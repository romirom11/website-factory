#!/usr/bin/env bash
# Installs the AppArmor profile that agent-runner-executor is pinned to in
# docker-compose.yml (security_opt: apparmor=wf-runner-executor).
#
# Why a custom profile: Docker's docker-default profile denies mount(), and on
# Ubuntu 24.04 (kernel.apparmor_restrict_unprivileged_userns=1) an unconfined
# process that creates a user namespace is moved into the capability-less
# `unprivileged_userns` profile. Both break the nested bubblewrap sandbox, so
# `apparmor=unconfined` is NOT enough there. The profile keeps docker-default's
# /proc and /sys denials and only adds userns/mount/pivot_root.
#
# Idempotent. Run as root on every Linux host that runs the executor
# (one-time, and again after upgrading the profile in the repo):
#   sudo scripts/install-runner-apparmor.sh
set -euo pipefail

PROFILE_NAME="wf-runner-executor"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/apparmor/${PROFILE_NAME}"
DST="/etc/apparmor.d/${PROFILE_NAME}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "skip: AppArmor exists only on Linux hosts (Docker Desktop ignores the apparmor security_opt)."
  exit 0
fi
if [[ ! -d /sys/kernel/security/apparmor ]]; then
  echo "skip: this kernel has no AppArmor; Docker ignores the apparmor security_opt here."
  exit 0
fi
if [[ "$(id -u)" != "0" ]]; then
  echo "error: run as root (sudo $0)" >&2
  exit 1
fi
if ! command -v apparmor_parser >/dev/null 2>&1; then
  echo "error: apparmor_parser not found; install the 'apparmor' package first" >&2
  exit 1
fi
[[ -f "$SRC" ]] || { echo "error: profile source missing: $SRC" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
if [[ -f /etc/apparmor.d/abi/4.0 ]]; then
  cp "$SRC" "$tmp"
else
  # AppArmor < 4.0 (e.g. Ubuntu 22.04) has neither the 4.0 abi nor userns
  # rules, and does not restrict unprivileged user namespaces either.
  grep -v -E '^\s*(abi <abi/4\.0>,|userns,)\s*$' "$SRC" > "$tmp"
fi

install -m 0644 "$tmp" "$DST"
apparmor_parser -r -W "$DST"

if grep -q "^${PROFILE_NAME} " /sys/kernel/security/apparmor/profiles; then
  echo "ok: AppArmor profile '${PROFILE_NAME}' loaded from ${DST}"
else
  echo "error: profile '${PROFILE_NAME}' is not listed in /sys/kernel/security/apparmor/profiles" >&2
  exit 1
fi
