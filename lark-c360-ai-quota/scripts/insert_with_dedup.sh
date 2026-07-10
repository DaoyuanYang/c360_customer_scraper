#!/bin/bash
# insert_with_dedup.sh — Reference bash implementation of the dedup+write logic.
#
# The primary entry point is scripts/c360_collect.mjs (Node) which does this
# in-process. This script is kept for cases where shelling out to lark-cli
# per-customer is preferred (e.g. ad-hoc replay, debugging).
#
# Usage: ./insert_with_dedup.sh <base-token> <table-id> <json-file>
# The JSON file must be: {"fields":[...], "rows":[[...], ...]}
#
# Env:
#   LARK_CLI  — absolute path to lark-cli (default: $HOME/.npm-global/bin/lark-cli)

set -euo pipefail

LARK_CLI="${LARK_CLI:-$HOME/.npm-global/bin/lark-cli}"

BASE_TOKEN="$1"
TABLE_ID="$2"
JSON_FILE="$3"

if [ -z "$BASE_TOKEN" ] || [ -z "$TABLE_ID" ] || [ -z "$JSON_FILE" ]; then
  echo "Usage: $0 <base-token> <table-id> <json-file>" >&2
  exit 1
fi

JSON=$(cat "$JSON_FILE")
FIELDS=$(echo "$JSON" | jq -c '.fields')
ROWS=$(echo "$JSON" | jq -c '.rows[]')

echo "Checking existing records in table $TABLE_ID via $LARK_CLI ..."
# Explicit --format json: avoid the default markdown table trap.
EXISTING_DATES=$(
  "$LARK_CLI" base +record-list \
    --base-token "$BASE_TOKEN" \
    --table-id "$TABLE_ID" \
    --limit 500 \
    --format json 2>/dev/null \
  | jq -r '.data.data[]?.fields["日期"] // .data[]?.fields["日期"] // empty' \
  | sort -u
)
EXISTING_COUNT=$(echo "$EXISTING_DATES" | grep -c . || true)
echo "Found $EXISTING_COUNT existing dates"

NEW_ROWS="[]"
SKIP=0
ADD=0

while IFS= read -r ROW; do
  DATE=$(echo "$ROW" | jq -r '.[0]')
  if echo "$EXISTING_DATES" | grep -qFx "$DATE"; then
    echo "  SKIP $DATE (already exists)"
    SKIP=$((SKIP + 1))
  else
    NEW_ROWS=$(echo "$NEW_ROWS" | jq --argjson row "$ROW" '. + [$row]')
    ADD=$((ADD + 1))
  fi
done < <(echo "$JSON" | jq -c '.rows[]')

echo "Summary: $ADD new rows to insert, $SKIP skipped (already exist)"

if [ "$ADD" -eq 0 ]; then
  echo "Nothing to insert."
  exit 0
fi

BATCH_TMP=$(mktemp -t c360-batch.XXXXXX.json)
trap 'rm -f "$BATCH_TMP"' EXIT
jq -n --argjson fields "$FIELDS" --argjson rows "$NEW_ROWS" \
  '{fields: $fields, rows: $rows}' > "$BATCH_TMP"

echo "Inserting $ADD records..."
"$LARK_CLI" base +record-batch-create \
  --base-token "$BASE_TOKEN" \
  --table-id "$TABLE_ID" \
  --json "@$BATCH_TMP"
echo "Done!"
