# Loader for the executor's AppArmor profile. Runs privileged for a moment at
# every `docker compose up`, pushes deploy/apparmor/wf-runner-executor into the
# host kernel through securityfs, then idles and re-checks it (same pattern as
# the Kubernetes apparmor-loader). On hosts without AppArmor it is a no-op.
FROM ubuntu:24.04
RUN apt-get update \
    && apt-get install -y --no-install-recommends apparmor \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/apparmor/wf-runner-executor /opt/apparmor/wf-runner-executor
COPY deploy/apparmor/load.sh /usr/local/bin/load-runner-apparmor
RUN chmod 0755 /usr/local/bin/load-runner-apparmor
ENTRYPOINT ["/usr/local/bin/load-runner-apparmor"]
