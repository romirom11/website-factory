#!/busybox sh
# CoreDNS image is distroless; busybox provides the shell for rendering the
# zone list. RUNNER_DNS_PROTECTION_ENABLED=false is the operator escape hatch
# for unrestricted public DNS (Corefile.false); the runner topology, HTTP
# allowlist and internal-name refusal are unchanged either way.
set -eu
# Applet symlinks for the render script (distroless image, see Dockerfile.runner).
export PATH="/bb:${PATH:-/usr/bin:/bin}"
if [ "${RUNNER_DNS_PROTECTION_ENABLED:-true}" = "false" ]; then
  exec /coredns -conf /Corefile.false
fi
/busybox sh /etc/agent-egress/render.sh corefile /Corefile.template /tmp/Corefile
exec /coredns -conf /tmp/Corefile
