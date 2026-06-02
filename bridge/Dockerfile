# Rove test bridge — runs the bridge as its OWN tailnet device so the mobile
# app can discover it as a second machine. `tailscaled` runs in userspace mode,
# so this works on Docker Desktop for macOS (no /dev/net/tun required).
FROM node:22-bookworm-slim

# Tailscale CLI + daemon, copied from the official image (no apt repo needed).
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscale  /usr/local/bin/tailscale

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && mkdir -p /var/run/tailscale /var/lib/tailscale /root/.claude /workspace

# Claude Code CLI — the bridge drives it to run sessions. Authenticate at
# runtime via `docker compose exec -it rove-bridge claude` → /login (creds land
# in /root/.claude, which is a persisted volume — see docker-compose.yml).
RUN npm i -g @anthropic-ai/claude-code

WORKDIR /app/bridge

# Install deps first (cached layer) from the bridge's own lockfile.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Bridge source (tsx runs the .ts directly — no build step).
COPY . ./
RUN chmod +x docker-entrypoint.sh

# Sessions + claude creds live under /root/.claude (persisted volume), so a
# `claude /login` and any sessions you start survive container restarts.
ENV PORT=8443

EXPOSE 8443
ENTRYPOINT ["./docker-entrypoint.sh"]
