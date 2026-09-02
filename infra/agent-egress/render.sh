#!/bin/sh
# Renders the runner egress allowlist for Squid and CoreDNS from one registry:
#   runtime-domains.txt      inherent provider/package domains (subdomains too)
#   opencode-providers.tsv   models.dev catalog; only ids in $OPENCODE_PROVIDERS
#                            contribute their exact API host
#
# Runs at container start inside the proxy (dash) and DNS (busybox) images, so
# it must stay POSIX sh: no pipefail, no arrays. Usage:
#   render.sh domains                 -> one domain per line on stdout
#   render.sh squid  <out-file>       -> Squid dstdomain list (".example.com")
#   render.sh corefile <template> <out-file>
#                                     -> replaces __ZONES__ with "a:53 b:53 …"
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
registry="${EGRESS_REGISTRY_DIR:-$here}"
# Comma/space separated ids; normalised to one per line.
providers="$(printf '%s' "${OPENCODE_PROVIDERS:-}" | tr ', ' '\n\n' | sed '/^$/d')"

fail() { echo "render.sh: $*" >&2; exit 1; }

# Host part of an https URL: scheme stripped, first path segment cut, port cut.
host_of() {
  printf '%s\n' "$1" | sed -e 's#^[a-z]*://##' -e 's#/.*$##' -e 's#:[0-9]*$##'
}

provider_api() {
  awk -F '\t' -v id="$1" '$1 == id { print $3 }' "$registry/opencode-providers.tsv"
}

# Validation runs before any pipeline so a bad id fails the container start
# instead of being swallowed by `sort`.
for id in $providers; do
  case "$id" in
    *[!a-z0-9-]*) fail "OPENCODE_PROVIDERS entry '$id' is not a provider id" ;;
  esac
  [ -n "$(provider_api "$id")" ] \
    || fail "OPENCODE_PROVIDERS entry '$id' is not in opencode-providers.tsv (run pnpm tsx scripts/refresh-opencode-catalog.ts?)"
done

domains() {
  grep -v '^[[:space:]]*#' "$registry/runtime-domains.txt" | grep -v '^[[:space:]]*$' \
    | awk '{ print $2 }'
  for id in $providers; do
    host_of "$(provider_api "$id")"
  done
}

case "${1:-}" in
  domains)
    domains | sort -u
    ;;
  squid)
    [ -n "${2:-}" ] || fail "squid needs an output file"
    domains | sort -u | sed 's/^/./' > "$2"
    ;;
  corefile)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] || fail "corefile needs <template> <out-file>"
    zones="$(domains | sort -u | sed 's/$/:53/' | tr '\n' ' ' | sed 's/ $//')"
    [ -n "$zones" ] || fail "no egress zones to render"
    sed "s|__ZONES__|$zones|" "$2" > "$3"
    ;;
  *)
    fail "usage: render.sh domains | squid <out> | corefile <template> <out>"
    ;;
esac
