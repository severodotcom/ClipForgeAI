# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# ClipForge — production image
#
# Three stages:
#   1. deps    — install node_modules once (cached layer).
#   2. builder — generate the Prisma client, warm the Whisper model cache,
#                then `next build` (output: "standalone").
#   3. runner  — minimal runtime: Node + ffmpeg/ffprobe + the traced
#                standalone app. No build tools, no source, no dev deps.
#
# No secret is read, baked in, or required at build time. DATABASE_URL,
# OPENAI_API_KEY, OPENAI_MODEL, CLIP_ANALYZER_PROVIDER, BETTER_AUTH_SECRET
# and BETTER_AUTH_URL are only ever read from the environment at runtime.
# ---------------------------------------------------------------------------

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci


FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Needs network access to Hugging Face Hub, no database and no secrets.
RUN npx prisma generate
RUN node scripts/warm-whisper-model.mjs
RUN npm run build


# Prisma CLI + its full dependency closure (incl. the schema-engine binary,
# the `dotenv` that prisma.config.ts imports and the @prisma/adapter-pg that
# prisma/seed.mjs imports), derived from package-lock.json and copied as-is
# from the deps install. Needed so the runner can execute `npx prisma
# migrate deploy` as Render's pre-deploy command and `npx prisma db seed`
# from a shell; the app itself never loads any of it.
FROM deps AS prisma-cli
COPY scripts/collect-prisma-cli.mjs ./scripts/
RUN node scripts/collect-prisma-cli.mjs /prisma-cli


FROM node:24-bookworm-slim AS runner
WORKDIR /app

# ffmpeg (which bundles ffprobe) is the only OS-level runtime dependency
# the app itself needs; Whisper's ONNX runtime ships as a prebuilt Node
# native addon inside node_modules (see the audit report for details).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --gid 1001 nodejs \
    && useradd --uid 1001 --gid nodejs --no-create-home --shell /usr/sbin/nologin nextjs

# Next.js standalone server + its traced node_modules subset (includes
# @prisma/client, pg, better-auth, openai, and — thanks to
# outputFileTracingIncludes — @huggingface/transformers with its warmed
# model cache, onnxruntime-node and sharp with their native bindings).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma CLI + schema/migrations, so the same image can also run
# `npx prisma migrate deploy` as Render's pre-deploy command (not executed
# by this image's default CMD, and no migration is run as part of this
# build). The CLI tree is overlaid on the standalone node_modules; the few
# packages both contain (react, react-dom, scheduler) come from the same
# lockfile, so the overlay doesn't change what the app loads. Copying a
# directory keeps node_modules/.bin/prisma a symlink.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=prisma-cli --chown=nextjs:nodejs /prisma-cli/node_modules ./node_modules

# Local video/clip storage. In production this path should be a Render
# Disk mount (see the deployment report) — creating it here only keeps
# `docker run` usable without a mounted volume.
RUN mkdir -p storage/videos storage/clips \
    && chown -R nextjs:nodejs storage

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
