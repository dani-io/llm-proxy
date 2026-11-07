#!/usr/bin/env bash
# Sync OpenCode's model list for the llm-proxy provider with what the proxy
# offers this key (GET /v1/models). New models are added, models gone from the
# proxy are removed, existing entries keep their names/options.
#
#   scripts/opencode-sync-models.sh [provider-id] [base-url]
#
# The key is read from OpenCode's credential store (opencode auth login →
# Other → same provider id). Needs jq and curl.
set -euo pipefail

PROVIDER="${1:-homelab}"
BASE="${2:-http://llm.bp/v1}"
CONF="${OPENCODE_CONFIG:-$HOME/.config/opencode/opencode.json}"
AUTH="$HOME/.local/share/opencode/auth.json"

command -v jq >/dev/null || { echo "jq is missing: sudo apt install jq" >&2; exit 1; }
[ -f "$CONF" ] || { echo "no config at $CONF" >&2; exit 1; }
jq -e . "$CONF" >/dev/null 2>&1 || { echo "$CONF is not plain JSON (comments?) — edit it by hand" >&2; exit 1; }

KEY=$(jq -r --arg p "$PROVIDER" '.[$p].key // empty' "$AUTH" 2>/dev/null || true)
[ -n "$KEY" ] || { echo "no key for '$PROVIDER' in $AUTH — run: opencode auth login → Other → $PROVIDER" >&2; exit 1; }

RESP=$(curl -fsS "$BASE/models" -H "Authorization: Bearer $KEY") || { echo "GET $BASE/models failed" >&2; exit 1; }
MODELS=$(jq '[.data[] | {key: .id, value: {name: (.id + (if .external then " (external)" else " (local)" end))}}] | from_entries' <<<"$RESP")
[ "$(jq 'length' <<<"$MODELS")" -gt 0 ] || { echo "the proxy returned no models for this key" >&2; exit 1; }

BACKUP="$CONF.$(date +%Y%m%d-%H%M%S).bak"
cp "$CONF" "$BACKUP"
jq --arg p "$PROVIDER" --argjson m "$MODELS" \
  '.provider[$p].models as $old
   | .provider[$p].models = ($m | with_entries(.value = (.value + (($old // {})[.key] // {}))))' \
  "$BACKUP" > "$CONF"

echo "models for '$PROVIDER':"; jq -r 'keys[] | "  " + .' <<<"$MODELS"
echo "backup: $BACKUP — restart OpenCode to see the list"
