/**
 * Unit + integration checks for the runtime settings store.
 *
 * Covers the three things that would silently break the whole feature:
 *  1. the AES-256-GCM envelope round-trips, and a WRONG master key degrades to
 *     '' instead of throwing (a worker must not die because a key rotated);
 *  2. resolution order really is DB -> env -> default;
 *  3. a value written to the DB becomes visible through `config.*` without a
 *     restart — the entire point of the change.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db/client.js';
import {
  decryptSecret, encryptSecret, getSetting, maskSecret, masterKeyConfigured,
  settingSource, SETTINGS,
} from '../src/lib/settings.js';
import {
  initSettings, reloadSettings, retireHeartbeat, rowKey, writeHeartbeat, writeSetting,
} from '../src/lib/settingsStore.js';
import { config } from '../src/config.js';

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`✅ ${label}${extra !== undefined ? ` — ${String(extra)}` : ''}`);
  else { console.error(`❌ ${label}${extra !== undefined ? ` — ${String(extra)}` : ''}`); failures++; }
}

// ── 1. encryption ────────────────────────────────────────────────────────────
check('SETTINGS_MASTER_KEY configured', masterKeyConfigured());

const secret = 'sk-ant-oat01-thisIsNotARealToken-0000';
const envelope = encryptSecret(secret);
check('envelope is not plaintext', !envelope.includes(secret) && envelope.startsWith('enc:v1:'));
check('round-trips', decryptSecret(envelope) === secret);
check('two encryptions of the same value differ (random IV)', encryptSecret(secret) !== envelope);
check('mask shows only the tail', maskSecret(secret) === `••••${secret.slice(-4)}`, maskSecret(secret));

const realKey = process.env.SETTINGS_MASTER_KEY;
process.env.SETTINGS_MASTER_KEY = 'f'.repeat(64);
check('wrong master key degrades to empty, never throws', decryptSecret(envelope) === '');
process.env.SETTINGS_MASTER_KEY = realKey;
check('right key still works after the swap', decryptSecret(envelope) === secret);

// ── 2. resolution order ──────────────────────────────────────────────────────
const TEST_KEY = 'OUTREACH_DAILY_LIMIT';
const before = await db.select().from(schema.settings).where(eq(schema.settings.key, rowKey(TEST_KEY)));
const hadRow = before.length > 0;
const previous = before[0]?.value ?? null;

await initSettings({ poll: false });

delete process.env[TEST_KEY];
await writeSetting(TEST_KEY, '', 'test');
await reloadSettings();
check('no DB row + no env -> registry default', getSetting(TEST_KEY) === '20', getSetting(TEST_KEY));
check('source reported as default', settingSource(TEST_KEY) === 'default');

process.env[TEST_KEY] = '33';
await reloadSettings();
check('env beats default', getSetting(TEST_KEY) === '33', getSetting(TEST_KEY));
check('source reported as env', settingSource(TEST_KEY) === 'env');

await writeSetting(TEST_KEY, '77', 'test');
await reloadSettings();
check('DB beats env', getSetting(TEST_KEY) === '77', getSetting(TEST_KEY));
check('source reported as db', settingSource(TEST_KEY) === 'db');

// ── 3. config getters see it live ────────────────────────────────────────────
check('config.outreachDailyLimit reflects the DB value', config.outreachDailyLimit === 77, config.outreachDailyLimit);
await writeSetting(TEST_KEY, '5', 'test');
await reloadSettings();
check('and changes again without a restart', config.outreachDailyLimit === 5, config.outreachDailyLimit);

// secrets go through config as plaintext, and land in the table encrypted
await writeSetting('TELEGRAM_BOT_TOKEN', 'test-token-abcd', 'test');
await reloadSettings();
check('secret readable through config', config.telegram.botToken === 'test-token-abcd', config.telegram.botToken);
const [stored] = await db.select().from(schema.settings).where(eq(schema.settings.key, rowKey('TELEGRAM_BOT_TOKEN')));
check('secret stored ENCRYPTED, not plaintext', Boolean(stored?.encrypted) && !stored!.value.includes('test-token-abcd'));
await writeSetting('TELEGRAM_BOT_TOKEN', '', 'test');
await reloadSettings();
check('clearing a secret deletes the row (falls back to env/default)',
  (await db.select().from(schema.settings).where(eq(schema.settings.key, rowKey('TELEGRAM_BOT_TOKEN')))).length === 0);

// ── 4. registry sanity ───────────────────────────────────────────────────────
check('no duplicate keys in the registry', new Set(SETTINGS.map((s) => s.key)).size === SETTINGS.length);
check('every secret has a group and label', SETTINGS.every((s) => s.group && s.label));

// ── 5. retired topology heartbeats ───────────────────────────────────────────
const HEARTBEAT_GROUP = 'e2e-retired';
const heartbeatKey = `heartbeat:${HEARTBEAT_GROUP}`;
await writeHeartbeat(HEARTBEAT_GROUP, { fixture: true });
check('fixture heartbeat exists before retirement',
  (await db.select().from(schema.settings).where(eq(schema.settings.key, heartbeatKey))).length === 1);
await retireHeartbeat(HEARTBEAT_GROUP);
check('retiring a worker topology removes its exact heartbeat',
  (await db.select().from(schema.settings).where(eq(schema.settings.key, heartbeatKey))).length === 0);
let invalidHeartbeatRejected = false;
try {
  await retireHeartbeat('../workers');
} catch {
  invalidHeartbeatRejected = true;
}
check('retirement rejects an invalid heartbeat group', invalidHeartbeatRejected);

// restore
delete process.env[TEST_KEY];
if (hadRow && previous !== null) {
  await db.insert(schema.settings)
    .values({ key: rowKey(TEST_KEY), value: previous, encrypted: false, updatedAt: new Date(), updatedBy: 'test-restore' })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: previous } });
} else {
  await db.delete(schema.settings).where(eq(schema.settings.key, rowKey(TEST_KEY)));
}

console.log(failures === 0 ? '\n⚙️  SETTINGS TEST PASSED' : `\n💥 ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
