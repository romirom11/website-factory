# Control UI image.
#
# IMPORTANT: build this from the REPO ROOT context, not from ui/:
#   docker build -f ui/Dockerfile .
# The app imports the factory's drizzle schema (`src/db/schema.ts`). Locally
# `ui/factory/schema.ts` is a symlink to it; a Docker build cannot follow a
# symlink out of its context, so we copy the real file over the symlink here.
# One schema definition, never a drifting duplicate.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# `packageManager` in ui/package.json pins the pnpm version corepack fetches,
# so install and build always run under the same pnpm that wrote the lockfile.
RUN corepack enable

# ── build ────────────────────────────────────────────────────────────────────
# Install and build in ONE stage: pnpm re-validates node_modules before running
# a script, and a node_modules copied in from another stage trips that check.
FROM base AS builder
WORKDIR /app
COPY ui/package.json ui/pnpm-lock.yaml ui/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY ui/ ./
# `ui/factory/schema.ts` arrives as the dev symlink (-> ../../src/db/schema.ts),
# which dangles here because the copy is rooted at /app. Remove it first, then
# copy the real file: a plain COPY would otherwise write THROUGH the symlink.
RUN rm -f ./factory/schema.ts ./factory/buildPolicy.ts ./factory/businessStatus.ts ./factory/settings.ts ./factory/models.ts ./factory/jobDefinitions.ts
COPY src/db/schema.ts ./factory/schema.ts
# Same reasoning as the schema: the build policy (who gets a demo built, in what
# order) is ONE file shared with the workers, so the router and the UI's
# "Будувати демо" button can never disagree about eligibility.
COPY src/orchestrator/buildPolicy.ts ./factory/buildPolicy.ts
# Legal business-state transitions are a single contract for
# worker CAS updates and UI actions. Local development follows the symlink;
# container builds receive the same source explicitly.
COPY src/orchestrator/businessStatus.ts ./factory/businessStatus.ts
# The settings REGISTRY (which keys exist, which
# are secret, how they validate) and the AES-256-GCM envelope format must be
# ONE definition. A drifting copy here would mean the UI writes a row the
# factory cannot decrypt, or offers a key nothing reads.
COPY src/lib/settings.ts ./factory/settings.ts
# The MODEL-TIER policy (how AGENT_MODEL /
# AGENT_MODEL_HEAVY map onto whichever harness is selected) is one definition —
# the workers pass these ids to their CLIs and the settings page renders the
# same rule as field fallbacks. Import-free by design (see its docblock).
COPY src/agents/modelPolicy.ts ./factory/models.ts
# Queue policy and human-readable job metadata are one
# import-free registry consumed by both factory and UI.
COPY src/orchestrator/jobDefinitions.ts ./factory/jobDefinitions.ts
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs

# `output: 'standalone'` bundles the server plus only the modules it needs.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
