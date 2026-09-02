#!/bin/sh
# Loads the wf-runner-executor AppArmor profile into the host kernel.
#
# Why: docker-default denies mount(), and on Ubuntu 24.04
# (kernel.apparmor_restrict_unprivileged_userns=1) an unconfined process that
# creates a user namespace is moved into the capability-less
# `unprivileged_userns` profile, so `apparmor=unconfined` does not help either.
# The nested bubblewrap sandbox inside agent-runner-executor needs a confined
# profile that allows userns/mount/pivot_root: deploy/apparmor/wf-runner-executor.
#
# securityfs is kernel-global, so a privileged container can mount it and load
# policy exactly like apparmor_parser on the host would. The container then
# idles and re-applies the profile if it ever disappears; the compose
# healthcheck (`load-runner-apparmor check`) gates the executor start.
#
# Modes: (default) load + idle loop; `check` = healthcheck; `dry-run` = compile
# only (apparmor_parser -Q), used to validate the profile against a kernel.
set -eu

PROFILE_NAME="wf-runner-executor"
SRC="/opt/apparmor/${PROFILE_NAME}"
READY_FLAG="/run/runner-apparmor-ready"
AA="/sys/kernel/security/apparmor"
MODE="${1:-load}"

ensure_securityfs() {
  if [ ! -d "$AA" ] && [ -d /sys/kernel/security ]; then
    mount -t securityfs securityfs /sys/kernel/security 2>/dev/null || true
  fi
}

host_has_apparmor() { [ -d "$AA" ] && [ -r "$AA/profiles" ]; }

profile_loaded() { grep -q "^${PROFILE_NAME} " "$AA/profiles"; }

render_profile() {
  # Kernels without user-namespace mediation (AppArmor < 4.0, e.g. Ubuntu 22.04)
  # reject `userns,` and the 4.0 abi; they do not restrict userns either.
  if grep -qs userns_create "$AA/features/namespaces/mask"; then
    cp "$SRC" "$1"
  else
    grep -v -E '^\s*(abi <abi/4\.0>,|userns,)\s*$' "$SRC" > "$1"
  fi
}

load_profile() {
  tmp="$(mktemp)"
  render_profile "$tmp"
  apparmor_parser -r -T "$tmp"
  rm -f "$tmp"
  profile_loaded
}

case "$MODE" in
  check)
    [ -f "$READY_FLAG" ] || exit 1
    if host_has_apparmor; then profile_loaded; fi
    ;;
  dry-run)
    ensure_securityfs
    host_has_apparmor || { echo "dry-run: host has no AppArmor, nothing to compile against"; exit 0; }
    tmp="$(mktemp)"
    render_profile "$tmp"
    apparmor_parser -Q -T "$tmp" && echo "dry-run: ${PROFILE_NAME} compiles against this kernel"
    ;;
  load)
    ensure_securityfs
    if ! host_has_apparmor; then
      echo "skip: host kernel has no AppArmor; Docker ignores apparmor security_opt here"
      touch "$READY_FLAG"
      exec sleep infinity
    fi
    if load_profile; then
      echo "ok: AppArmor profile ${PROFILE_NAME} loaded into the host kernel"
    else
      echo "error: ${PROFILE_NAME} is not listed in ${AA}/profiles after apparmor_parser" >&2
      exit 1
    fi
    touch "$READY_FLAG"
    while sleep 60; do
      if ! profile_loaded; then
        echo "profile ${PROFILE_NAME} disappeared from the kernel; reloading"
        load_profile || echo "error: reload failed" >&2
      fi
    done
    ;;
  *)
    echo "usage: load-runner-apparmor [load|check|dry-run]" >&2
    exit 2
    ;;
esac
