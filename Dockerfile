FROM node:22-bookworm-slim

WORKDIR /app

# HTTPS certificates and tools available to the agent.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        openssl \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Persistent application state belongs under Maritime's /data.
# Maritime injects PORT; the application already reads it.
ENV NODE_ENV=production \
    CODEX_HOME=/data/codex \
    AGENT_WORKSPACE_ROOT=/data/workspaces \
    CODEX_AUTH_MODE=chatgpt \
    PATH="/app/node_modules/.bin:${PATH}"

# Install the repository's pinned dependencies.
# Dev dependencies are required for the TypeScript build.
# Optional dependencies include platform-specific binaries.
COPY package.json package-lock.json .npmrc ./

RUN npm ci --include=dev --include=optional \
    && npm cache clean --force

# Keep source files, SQL migrations, prompts, and other app assets.
COPY . .

RUN npm run build

# The existing startup lifecycle already runs database migrations.
CMD ["node", "dist/server.js"]
