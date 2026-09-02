/**
 * Real Docker Compose conformance probes for the production runner boundary.
 *
 * Uses a dedicated project/networks/volumes, then removes only those resources.
 * Runner images must be built from the current checkout before this test.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface ContainerInspect {
  Config: { Env: string[] };
  RestartCount: number;
  HostConfig: {
    CapAdd: string[] | null;
    CapDrop: string[] | null;
    Memory: number;
    PidsLimit: number | null;
    ReadonlyRootfs: boolean;
    SecurityOpt: string[] | null;
    Sysctls: Record<string, string> | null;
  };
  Mounts: Array<{ Destination: string; Name?: string; Type: string }>;
  NetworkSettings: {
    Networks: Record<string, { Gateway: string; NetworkID: string }>;
  };
}

const project = `wf-runner-isolation-${process.pid}`;
const legacySubnet = '172.31.250.0/24';
const collisionNetwork = `${project}-legacy-subnet`;
const injectedPublicNetwork = `${project}-dokploy-injection`;
const services = [
  'agent-egress-dns',
  'agent-egress-proxy',
  'agent-runner-executor',
  'agent-runner-gateway',
];

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const baseEnv = { ...process.env };
delete baseEnv.RUNNER_EGRESS_SUBNET;
delete baseEnv.RUNNER_EGRESS_DNS_IP;
const composeEnv: NodeJS.ProcessEnv = {
  ...baseEnv,
  RUNNER_API_KEY: 'runner-isolation-public-key',
  RUNNER_EXECUTOR_API_KEY: 'runner-isolation-private-key',
  UI_PASSWORD: 'runner-isolation-ui-password',
  BUILD_TERMINAL_PORT: String(await freePort()),
  RUNNER_MEMORY_LIMIT: '2g',
};

function run(
  program: string,
  args: string[],
  allowFailure = false,
  environment: NodeJS.ProcessEnv = composeEnv,
): CommandResult {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output: CommandResult = {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? String(result.error ?? ''),
  };
  if (!allowFailure && output.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed:\n${output.stdout}${output.stderr}`);
  }
  return output;
}

const compose = (args: string[], allowFailure = false): CommandResult =>
  run('docker', ['compose', '-p', project, ...args], allowFailure);

const composeWithEnv = (
  environment: NodeJS.ProcessEnv,
  args: string[],
  allowFailure = false,
): CommandResult => run(
  'docker',
  ['compose', '-p', project, ...args],
  allowFailure,
  { ...composeEnv, ...environment },
);

const docker = (args: string[], allowFailure = false): CommandResult =>
  run('docker', args, allowFailure);

let passed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

function inspect(container: string): ContainerInspect {
  return JSON.parse(docker(['inspect', container]).stdout)[0] as ContainerInspect;
}

async function waitHealthy(container: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = docker([
      'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container,
    ], true).stdout.trim();
    if (state === 'healthy') return;
    if (state === 'unhealthy' || state === 'exited' || state === 'dead') break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const logs = compose(['logs', '--no-color', '--tail=200', ...services], true);
  throw new Error(`container did not become healthy: ${container}\n${logs.stdout}${logs.stderr}`);
}

async function waitRestart(container: string, previousCount: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (inspect(container).RestartCount > previousCount) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`container did not restart after its DNS relay exited: ${container}`);
}

let executor = '';
let gateway = '';
let proxy = '';
let started = false;
let collisionNetworkCreated = false;
let injectedPublicNetworkCreated = false;

try {
  await check('Compose renders portable runner DNS topology and policy modes', () => {
    const config = JSON.parse(compose(['config', '--format', 'json']).stdout) as {
      services: Record<string, {
        command?: string[];
        dns?: string[];
        security_opt?: string[];
        sysctls?: Record<string, string>;
      }>;
      networks: Record<string, { ipam?: Record<string, unknown> }>;
    };
    const executorConfig = config.services['agent-runner-executor'];
    assert.deepEqual(config.networks['runner-egress-v2']?.ipam, {});
    assert.deepEqual(executorConfig?.dns, ['127.0.0.53']);
    assert.ok(executorConfig?.security_opt?.includes('apparmor=wf-runner-executor'));
    assert.equal(executorConfig?.sysctls?.['net.ipv4.ip_unprivileged_port_start'], '0');
    assert.deepEqual(config.services['agent-egress-dns']?.command, ['-conf', '/Corefile.true']);

    const openConfig = JSON.parse(composeWithEnv(
      { RUNNER_DNS_PROTECTION_ENABLED: 'false' },
      ['config', '--format', 'json'],
    ).stdout) as typeof config;
    assert.deepEqual(openConfig.services['agent-egress-dns']?.command, ['-conf', '/Corefile.false']);
  });

  const collision = docker([
    'network', 'create', '--driver', 'bridge', '--subnet', legacySubnet, collisionNetwork,
  ], true);
  if (collision.status === 0) {
    collisionNetworkCreated = true;
  } else {
    assert.match(
      `${collision.stdout}${collision.stderr}`,
      /overlap/i,
      `could not reserve the legacy runner subnet:\n${collision.stdout}${collision.stderr}`,
    );
  }

  started = true;
  compose(['up', '-d', '--force-recreate', ...services]);
  executor = compose(['ps', '-q', 'agent-runner-executor']).stdout.trim();
  gateway = compose(['ps', '-q', 'agent-runner-gateway']).stdout.trim();
  proxy = compose(['ps', '-q', 'agent-egress-proxy']).stdout.trim();
  assert.ok(executor && gateway && proxy, 'runner containers were not created');
  await waitHealthy(executor);
  await waitHealthy(gateway);

  await check('readiness reports fail-closed runtime conformance', () => {
    const result = docker([
      'exec', executor, 'node', '-e',
      "fetch('http://127.0.0.1:8791/health').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))",
    ]);
    const health = JSON.parse(result.stdout) as {
      ok: boolean;
      isolation: { required: boolean; ready: boolean; codeRuntimes: Record<string, boolean> };
    };
    assert.equal(health.ok, true);
    assert.equal(health.isolation.required, true);
    assert.equal(health.isolation.ready, true);
    assert.deepEqual(health.isolation.codeRuntimes, {
      'claude-code': true,
      codex: true,
      opencode: false,
    });
  });

  await check('executor has only internal control/egress networks', () => {
    const data = inspect(executor);
    const networks = Object.entries(data.NetworkSettings.Networks);
    assert.deepEqual(networks.map(([name]) => name).sort(), [
      `${project}_runner-control`,
      `${project}_runner-egress-v2`,
    ]);
    assert.ok(networks.every(([, value]) => value.Gateway === ''));
    for (const [, value] of networks) {
      const network = JSON.parse(docker(['network', 'inspect', value.NetworkID]).stdout)[0] as { Internal: boolean };
      assert.equal(network.Internal, true);
    }
  });

  await check('readiness rejects a public network injected by the deployment platform', async () => {
    docker(['network', 'create', '--driver', 'bridge', injectedPublicNetwork]);
    injectedPublicNetworkCreated = true;
    docker(['network', 'connect', injectedPublicNetwork, executor]);

    const route = docker(['exec', executor, 'sh', '-lc', "awk '$2 == \"00000000\" { print $0 }' /proc/net/route"])
      .stdout.trim();
    assert.notEqual(route, '', 'the injected bridge must create a default route for this regression probe');

    const status = docker([
      'exec', executor, 'node', '-e',
      "fetch('http://127.0.0.1:8791/health').then(r=>console.log(r.status))",
    ]).stdout.trim();
    assert.equal(status, '503');

    const executionStatus = docker([
      'exec', executor, 'node', '-e',
      [
        "fetch('http://127.0.0.1:8791/v1/executions',{",
        "method:'POST',",
        "headers:{'content-type':'application/json','x-executor-key':'runner-isolation-private-key'},",
        "body:'{}'",
        "}).then(r=>console.log(r.status))",
      ].join(''),
    ]).stdout.trim();
    assert.equal(executionStatus, '503');

    docker(['network', 'disconnect', injectedPublicNetwork, executor]);
    await waitHealthy(executor);
  });

  await check('executor is read-only, capability-free and resource-bounded', () => {
    const host = inspect(executor).HostConfig;
    assert.equal(host.ReadonlyRootfs, true);
    assert.deepEqual(host.CapAdd, null);
    assert.ok(host.CapDrop?.includes('ALL'));
    assert.ok(host.SecurityOpt?.includes('no-new-privileges:true'));
    assert.ok(host.SecurityOpt?.includes('seccomp=unconfined'));
    assert.ok(host.SecurityOpt?.includes('apparmor=wf-runner-executor'));
    assert.equal(host.PidsLimit, 512);
    assert.ok(host.Memory > 0);
    assert.equal(host.Sysctls?.['net.ipv4.ip_unprivileged_port_start'], '0');
  });

  await check('read-only runner services bypass package-manager launchers', () => {
    const executorProcesses = docker(['top', executor, '-eo', 'pid,args']).stdout;
    const gatewayProcesses = docker(['top', gateway, '-eo', 'pid,args']).stdout;
    assert.match(executorProcesses, /node \/app\/dist\/runner\/executor\.js/);
    assert.match(gatewayProcesses, /node dist\/runner\/gateway\.js/);
    assert.doesNotMatch(executorProcesses, /(?:^|\s)pnpm(?:\s|$)/m);
    assert.doesNotMatch(gatewayProcesses, /(?:^|\s)pnpm(?:\s|$)/m);
  });

  await check('executor mounts no factory data or Docker socket', () => {
    const data = inspect(executor);
    assert.deepEqual(data.Mounts.map((mount) => mount.Destination).sort(), [
      '/app/runner-work',
      '/app/runner-work/.private/codex',
      '/app/runner-work/.private/credentials',
      '/app/runner-work/.private/provider/opencode',
    ].sort());
    assert.ok(data.Mounts.every((mount) => !/sites|deploy|postgres|minio|docker\.sock/i.test(mount.Destination)));
    const socket = docker(['exec', executor, 'test', '!', '-e', '/var/run/docker.sock']);
    assert.equal(socket.status, 0);
  });

  await check('executor receives no factory secrets', () => {
    const forbidden = /^(DATABASE_URL|S3_|AWS_|SMTP_|IMAP_|TELEGRAM_|WAHA_|WHATSAPP_|POSTGRES_|MINIO_|SETTINGS_MASTER_KEY|UI_SESSION_SECRET)/;
    const names = inspect(executor).Config.Env.map((entry) => entry.split('=', 1)[0]);
    assert.deepEqual(names.filter((name) => forbidden.test(name)), []);
  });

  await check('gateway has no provider credential mounts', () => {
    const data = inspect(gateway);
    assert.ok(data.Mounts.every((mount) => !/runnerclaude|codexhome|opencodehome/.test(mount.Name ?? '')));
    assert.ok(data.Mounts.every((mount) => !mount.Destination.includes('/.private/')));
  });

  await check('provider credential contents are invisible to the gateway', () => {
    const marker = '.gateway-visibility-probe';
    docker(['exec', executor, 'sh', '-lc', [
      `printf claude-probe > "$RUNNER_CREDENTIAL_ROOT/${marker}"`,
      `printf codex-probe > "$CODEX_HOME/${marker}"`,
      `printf opencode-probe > "$XDG_DATA_HOME/opencode/${marker}"`,
    ].join('; ')]);
    docker(['exec', gateway, 'sh', '-lc', [
      `test ! -e "/app/runner-work/.private/credentials/${marker}"`,
      `test ! -e "/app/runner-work/.private/codex/${marker}"`,
      `test ! -e "/app/runner-work/.private/provider/opencode/${marker}"`,
    ].join(' && ')]);
    docker(['exec', executor, 'sh', '-lc', [
      `rm -f "$RUNNER_CREDENTIAL_ROOT/${marker}"`,
      `rm -f "$CODEX_HOME/${marker}"`,
      `rm -f "$XDG_DATA_HOME/opencode/${marker}"`,
    ].join('; ')]);
  });

  await check('approved package traffic crosses the proxy', () => {
    docker([
      'exec', executor, 'curl', '-fsS', '-o', '/dev/null',
      '--connect-timeout', '5', '--max-time', '15', 'https://registry.npmjs.org/pnpm',
    ]);
  });

  await check('arbitrary CONNECT and Python urllib traffic are denied', () => {
    const command = [
      "if curl -fsS -o /dev/null --connect-timeout 3 --max-time 5 https://example.com 2>/dev/null; then exit 31; fi",
      "if python3 -c 'import urllib.request; urllib.request.urlopen(\"https://example.com\", timeout=3)' >/dev/null 2>&1; then exit 32; fi",
    ].join('; ');
    docker(['exec', executor, 'sh', '-lc', command]);
  });

  await check('direct HTTP clients and raw IP sockets have no route', () => {
    const command = [
      "if curl --noproxy '*' -fsS -o /dev/null --connect-timeout 3 --max-time 5 https://registry.npmjs.org/pnpm 2>/dev/null; then exit 41; fi",
      "node -e \"fetch('https://registry.npmjs.org/pnpm',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(42)).catch(()=>{})\"",
      "node -e \"const net=require('node:net');const s=net.connect({host:'1.1.1.1',port:443});const t=setTimeout(()=>s.destroy(),2500);s.on('connect',()=>{clearTimeout(t);process.exit(43)});s.on('error',()=>clearTimeout(t))\"",
    ].join('; ');
    docker(['exec', executor, 'sh', '-lc', command]);
  });

  await check('filtered DNS allows packages and rejects arbitrary/lateral names', () => {
    const script = `
      const dns=require('node:dns').promises;
      (async()=>{
        await dns.lookup('registry.npmjs.org');
        for(const host of ['example.com','postgres','minio','factory','host.docker.internal']){
          try { await dns.lookup(host); process.exit(51); } catch {}
        }
      })().catch(()=>process.exit(52));
    `;
    docker(['exec', executor, 'node', '-e', script]);
  });

  await check('executor restarts if its loopback DNS relay exits', async () => {
    const previousCount = inspect(executor).RestartCount;
    docker(['exec', executor, 'pkill', '-f', '^socat UDP4-RECVFROM:53,']);
    await waitRestart(executor, previousCount);
    await waitHealthy(executor);
    docker([
      'exec', executor, 'node', '-e',
      "require('node:dns').lookup('registry.npmjs.org',(error)=>process.exit(error?1:0))",
    ]);
  });

  await check('Codex exact-root sandbox hides auth, siblings, secrets and parent proc', () => {
    const command = String.raw`
      set -eu
      workspace_a="$(mktemp -d /app/runner-work/isolation-a-XXXXXX)"
      workspace_b="$(mktemp -d /app/runner-work/isolation-b-XXXXXX)"
      codex_probe="$CODEX_HOME/.isolation-probe-secret"
      claude_probe="$RUNNER_CREDENTIAL_ROOT/.isolation-probe-secret"
      cleanup() {
        rm -rf "$workspace_a" "$workspace_b"
        rm -f "$codex_probe" "$claude_probe"
      }
      trap cleanup EXIT
      printf sibling-secret > "$workspace_b/secret.txt"
      printf codex-secret > "$codex_probe"
      printf claude-secret > "$claude_probe"
      codex sandbox -P factory-tools -C "$workspace_a" sh -c '
        set -eu
        test -z "$(printenv EXECUTOR_API_KEY || true)"
        touch own-write.txt
        test ! -r "$1/secret.txt"
        test ! -r "$2"
        test ! -r "$3"
        if touch "$1/escape.txt" 2>/dev/null; then exit 61; fi
        if test -r /proc/1/environ && tr "\0" "\n" </proc/1/environ | grep -q EXECUTOR_API_KEY; then exit 62; fi
      ' isolation-inner "$workspace_b" "$codex_probe" "$claude_probe"
      test -f "$workspace_a/own-write.txt"
      test ! -e "$workspace_b/escape.txt"
    `;
    docker(['exec', executor, 'sh', '-lc', command]);
  });

  await check('sandboxed tools retain loopback and approved package egress only', () => {
    const command = String.raw`
      set -eu
      workspace="$(mktemp -d /app/runner-work/network-a-XXXXXX)"
      server_pid=''
      cleanup() {
        test -z "$server_pid" || kill "$server_pid" 2>/dev/null || true
        rm -rf "$workspace"
      }
      trap cleanup EXIT
      printf ok > "$workspace/health.txt"
      python3 -m http.server 19090 --bind 127.0.0.1 --directory "$workspace" >/dev/null 2>&1 &
      server_pid=$!
      sleep 1
      codex sandbox -P factory-tools -C "$workspace" sh -c '
        curl -fsS http://127.0.0.1:19090/health.txt | grep -qx ok
        if curl -fsS -o /dev/null --connect-timeout 3 --max-time 5 https://example.com 2>/dev/null; then exit 71; fi
      '
      codex sandbox -P factory-package-install -C "$workspace" \
        curl -fsS -o /dev/null --connect-timeout 5 --max-time 15 https://registry.npmjs.org/pnpm
    `;
    docker(['exec', executor, 'sh', '-lc', command]);
  });

  await check('proxy logs omit URL paths and query payloads', () => {
    const logs = docker(['logs', proxy]).stdout;
    assert.doesNotMatch(logs, /\/pnpm|\?.+=/);
  });

  await check('DNS protection can be disabled without changing runner topology', async () => {
    composeEnv.RUNNER_DNS_PROTECTION_ENABLED = 'false';
    compose(['up', '-d', '--force-recreate', 'agent-egress-dns', 'agent-runner-executor']);
    executor = compose(['ps', '-q', 'agent-runner-executor']).stdout.trim();
    assert.ok(executor, 'executor was not recreated with open DNS policy');
    await waitHealthy(executor);
    const script = `
      const dns=require('node:dns').promises;
      (async()=>{
        await dns.lookup('example.com');
        for(const host of ['postgres','minio','factory','host.docker.internal']){
          try { await dns.lookup(host); process.exit(81); } catch {}
        }
      })().catch(()=>process.exit(82));
    `;
    docker(['exec', executor, 'node', '-e', script]);
    docker(['exec', executor, 'sh', '-lc', [
      "if curl -fsS -o /dev/null --connect-timeout 3 --max-time 5 https://example.com 2>/dev/null; then exit 83; fi",
      "node -e \"fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(84)).catch(()=>{})\"",
    ].join('; ')]);
  });

  await check('readiness fails closed when the egress boundary disappears', () => {
    docker(['stop', proxy]);
    const executorStatus = docker([
      'exec', executor, 'node', '-e',
      "fetch('http://127.0.0.1:8791/health').then(r=>console.log(r.status))",
    ]).stdout.trim();
    assert.equal(executorStatus, '503');

    const gatewayStatus = docker([
      'exec', gateway, 'node', '-e',
      "fetch('http://127.0.0.1:8790/health').then(r=>console.log(r.status))",
    ]).stdout.trim();
    assert.equal(gatewayStatus, '503');
  });

  console.log(`\n🔐 RUNNER ISOLATION TESTS PASSED (${passed})`);
} finally {
  if (started) compose(['down', '-v', '--remove-orphans'], true);
  if (injectedPublicNetworkCreated) docker(['network', 'rm', injectedPublicNetwork], true);
  if (collisionNetworkCreated) docker(['network', 'rm', collisionNetwork], true);
}
