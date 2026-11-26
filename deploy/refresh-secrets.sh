#!/bin/sh
# Runs ON THE BOX as root. Rebuilds /opt/lucid-mcp/secrets.env from the running HQ (manele) container and the
# Magic Chapter container, so the MCP server always uses the same credentials HQ uses. Values are never printed.
# Run it again (then run.sh) whenever a token is rotated on HQ.
set -eu
OUT=/opt/lucid-mcp/secrets.env
TMP=$(mktemp)
HQ=$(docker ps --format '{{.Names}}' | grep '^22elqx6fwi2r4swoveazpnsf' | head -1)
[ -n "$HQ" ] || { echo "HQ container not found" >&2; exit 1; }
docker inspect "$HQ" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^(JWT_SECRET|STRIPE_SECRET_KEY|OBLIO_EMAIL|OBLIO_SECRET|OBLIO_CIF|TT_ADS_TOKEN|META_ACCESS_TOKEN|META_AD_ACCOUNT_ID|[A-Z]+_FB_ADS_TOKEN|[A-Z]+_AD_ACCOUNT_ID|[A-Z]+_TT_CAMPAIGN_IDS|TT_FEED_CAMPAIGN_SITES)=' > "$TMP"
if docker ps --format '{{.Names}}' | grep -q '^lucid-santa$'; then
  docker inspect lucid-santa --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^STRIPE_SECRET_KEY=' | sed 's/^/MC_/' >> "$TMP" || true
  # Magic Chapter's own Meta token, used only if HQ has none for the MC ad account
  if ! grep -q '^SANTA_FB_ADS_TOKEN=.\+' "$TMP"; then
    docker inspect lucid-santa --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^FB_ADS_ACCESS_TOKEN=' | sed 's/^FB_ADS_ACCESS_TOKEN=/SANTA_FB_ADS_TOKEN=/' >> "$TMP" || true
  fi
fi
# Gmail (read-only use) for the support inboxes: the same OAuth client + refresh tokens the support agent (Sofia) holds.
AG=$(docker ps --format '{{.Names}}' | grep '^esknm7tjenezmhlcex3s1i2n' | head -1)
if [ -n "$AG" ]; then
  docker inspect "$AG" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -E '^(GMAIL_OAUTH_CLIENT_ID|GMAIL_OAUTH_CLIENT_SECRET|[A-Z]+_GMAIL_REFRESH_TOKEN|[A-Z]+_GMAIL_ADDRESS)=' >> "$TMP" || true
fi
install -m 600 "$TMP" "$OUT"; rm -f "$TMP"
echo "secrets.env rebuilt: $(wc -l < "$OUT") keys: $(cut -d= -f1 "$OUT" | tr '\n' ' ')"
