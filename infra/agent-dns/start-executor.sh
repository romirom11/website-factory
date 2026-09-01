#!/usr/bin/env bash
set -euo pipefail

# Docker's embedded resolver continues to answer names on the private Compose
# networks. External queries are forwarded to this loopback relay, which sends
# them to the allowlisting CoreDNS service without requiring a fixed container
# address or a host-specific IPAM subnet.
readonly resolver_host=agent-egress-dns
readonly resolver_port=53
readonly listen_address=127.0.0.53

# Fail before the executor starts if Docker cannot resolve the filtering DNS
# service on runner-egress-v2. This lookup is answered locally by 127.0.0.11.
getent ahostsv4 "$resolver_host" >/dev/null

socat \
  "UDP4-RECVFROM:${resolver_port},bind=${listen_address},reuseaddr,fork" \
  "UDP4-SENDTO:${resolver_host}:${resolver_port}" &
udp_relay_pid=$!

socat \
  "TCP4-LISTEN:${resolver_port},bind=${listen_address},reuseaddr,fork" \
  "TCP4:${resolver_host}:${resolver_port}" &
tcp_relay_pid=$!

pnpm runner:executor &
executor_pid=$!

readonly child_pids=("$udp_relay_pid" "$tcp_relay_pid" "$executor_pid")

shutdown() {
  trap - TERM INT
  kill -TERM "${child_pids[@]}" 2>/dev/null || true
}

cleanup() {
  shutdown
  wait "${child_pids[@]}" 2>/dev/null || true
}

trap shutdown TERM INT
trap cleanup EXIT

set +e
wait -n "${child_pids[@]}"
status=$?
set -e

# A relay exiting cleanly is still a service failure. The executor must never
# continue with a missing DNS policy boundary.
if kill -0 "$executor_pid" 2>/dev/null; then
  echo "runner DNS relay exited unexpectedly" >&2
  exit 1
fi

exit "$status"
