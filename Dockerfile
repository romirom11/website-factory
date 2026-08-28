FROM node:22-bookworm

# Install the pinned package manager as a system binary. Corepack caches per
# user, which makes a root build followed by USER node download pnpm at startup.
RUN npm install --global pnpm@11.24.0
WORKDIR /app

# pnpm-workspace.yaml is NOT optional here: it carries the reviewed dependency
# build allowlist. Without it pnpm 11 rejects esbuild's native-binary setup.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# No `|| pnpm install` fallback: that hid the real failure AND would silently
# build an image whose dependency tree does not match the committed lockfile.
RUN pnpm install --frozen-lockfile

# Browsers for Playwright (audit, visual QA, page capture, social discovery).
#
# The install runs as root but every worker runs as `node` (see the USER switch
# below), and Playwright's default cache is PER USER (`$HOME/.cache/ms-playwright`).
# Without an explicit shared path the browsers land in /root/.cache, where the
# node user cannot see them, and every Playwright job dies with "Executable
# doesn't exist at /home/node/.cache/...". A fixed, world-readable path is what
# makes one install serve both users.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Every browser consumer runs headless; the full headed Chromium binary adds
# roughly 200 MB and cannot be displayed in this service anyway.
RUN npx playwright install --with-deps --only-shell chromium \
    && chmod -R a+rx /ms-playwright

# ffmpeg remains in the deterministic factory image for media preparation.
# Runtime CLIs, tmux and ttyd live only in Dockerfile.runner.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# The builder agent works inside a copy of site-template/ and reads references/
# and .claude/skills/ (gen-image). All three must exist in the image — see
# .dockerignore for what is deliberately left out (node_modules, .env, sites/).
COPY . .

# skills/ is the source of truth; the agent runtime reads .claude/skills/.
RUN mkdir -p .claude/skills && cp -r skills/. .claude/skills/

# ── run as a NON-ROOT user ───────────────────────────────────────────────────
# This is a hard requirement, not hardening: the agent layer drives Claude Code
# with permissionMode 'bypassPermissions', which the CLI implements as
# `--dangerously-skip-permissions` — and that flag REFUSES to run as root:
#   "--dangerously-skip-permissions cannot be used with root/sudo privileges"
# As root every agent job therefore fails 3/3 attempts regardless of whether
# CLAUDE_CODE_OAUTH_TOKEN is set. `node` (uid 1000) ships with the base image.
#
# The mounted sites/ and deploys/ volumes must be writable by that uid; they are
# created here so the bind mounts inherit an owner instead of arriving as root.
RUN mkdir -p /app/sites /app/deploys /app/storage /app/agent-inputs \
    && chown -R node:node /app /home/node

USER node

# Migrations are idempotent and must be applied before workers touch the DB:
# a fresh `docker compose up` on an empty volume otherwise starts against no
# schema at all. Both factory containers run this; whoever gets there first wins.
CMD ["sh", "-c", "pnpm db:migrate && pnpm all"]
