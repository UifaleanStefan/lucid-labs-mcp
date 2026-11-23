#!/bin/sh
# Runs ON THE BOX as root: build the image from /opt/lucid-mcp/src and (re)start the container behind coolify-proxy
# (Traefik) at https://mcp.159.195.252.107.nip.io/mcp with a Let's Encrypt certificate.
set -eu
cd /opt/lucid-mcp
TAG=lucid-mcp:$(date -u +%Y%m%d%H%M%S)
docker build -q -t "$TAG" -t lucid-mcp:latest src >/dev/null
docker rm -f lucid-mcp >/dev/null 2>&1 || true
H='mcp.159.195.252.107.nip.io'
docker run -d --name lucid-mcp --restart unless-stopped --network coolify \
  --env-file /opt/lucid-mcp/.env --env-file /opt/lucid-mcp/secrets.env \
  -v /opt/lucid-mcp/data:/data:ro \
  --memory 768m --cpus 1.5 \
  -l traefik.enable=true \
  -l traefik.docker.network=coolify \
  -l "traefik.http.routers.lucid-mcp-http.rule=Host(\`$H\`)" \
  -l traefik.http.routers.lucid-mcp-http.entryPoints=http \
  -l traefik.http.routers.lucid-mcp-http.middlewares=lucid-mcp-https \
  -l traefik.http.middlewares.lucid-mcp-https.redirectscheme.scheme=https \
  -l traefik.http.middlewares.lucid-mcp-https.redirectscheme.permanent=true \
  -l "traefik.http.routers.lucid-mcp.rule=Host(\`$H\`)" \
  -l traefik.http.routers.lucid-mcp.entryPoints=https \
  -l traefik.http.routers.lucid-mcp.tls=true \
  -l traefik.http.routers.lucid-mcp.tls.certresolver=letsencrypt \
  -l traefik.http.routers.lucid-mcp.service=lucid-mcp \
  -l traefik.http.services.lucid-mcp.loadbalancer.server.port=3000 \
  "$TAG" >/dev/null
i=0; while [ "$(docker inspect -f '{{.State.Health.Status}}' lucid-mcp 2>/dev/null)" != healthy ] && [ $i -lt 45 ]; do sleep 2; i=$((i+1)); done
docker ps --filter name=^lucid-mcp$ --format '{{.Names}} {{.Image}} {{.Status}}'
docker logs --tail 5 lucid-mcp
