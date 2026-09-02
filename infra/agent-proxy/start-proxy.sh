#!/bin/sh
# Render the egress allowlist for this deployment, then run Squid in the
# foreground. The container root is read-only; /tmp is the tmpfs Squid owns.
set -eu
/etc/agent-egress/render.sh squid /tmp/allowed-domains.acl
echo "runner egress proxy allows: $(tr '\n' ' ' < /tmp/allowed-domains.acl)"
exec squid -N -f /etc/squid/squid.conf -d 1
