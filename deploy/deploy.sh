#!/bin/sh
# Runs on the OWNER'S PC (Git Bash): ships server/ to the box and rebuilds the container.
#   sh deploy/deploy.sh            deploy code
#   sh deploy/deploy.sh --secrets  also rebuild secrets.env from HQ first
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
BOX="root@100.114.175.100"; KEY="$HOME/.ssh/lucid-box"
tar -C "$HERE/server" --exclude=node_modules --exclude=dist -czf - . | ssh -i "$KEY" "$BOX" 'rm -rf /opt/lucid-mcp/src.new && mkdir -p /opt/lucid-mcp/src.new && tar -xzf - -C /opt/lucid-mcp/src.new && rm -rf /opt/lucid-mcp/src && mv /opt/lucid-mcp/src.new /opt/lucid-mcp/src'
scp -q -i "$KEY" "$HERE/deploy/refresh-secrets.sh" "$HERE/deploy/run.sh" "$BOX:/opt/lucid-mcp/"
if [ "${1:-}" = "--secrets" ]; then ssh -i "$KEY" "$BOX" 'sh /opt/lucid-mcp/refresh-secrets.sh'; fi
ssh -i "$KEY" "$BOX" 'sh /opt/lucid-mcp/run.sh'
