#!/bin/bash
# c360_notify.sh — Read a c360_collect.mjs log file and post a markdown summary
# to the user via lark-cli im +messages-send. Designed to be invoked by
# launchd after the main c360_collect run finishes.
#
# Usage:
#   c360_notify.sh --log-file /tmp/c360_full_YYYYMMDD_HHMMSS.log
#
# Behavior:
#   - Parses OK/FAIL/SKIP counts from "[N/M] OK|FAIL|SKIP <name>" lines.
#   - Reads total from "found N customers in view <id>".
#   - Sorts the OK/FAIL/SKIP totals for a single concise message.
#   - Sends to the configured recipient (default: user open_id P2P).
#   - On failure, writes a short error to stderr (launchd captures this).
#
# Configuration via environment:
#   C360_NOTIFY_USER_ID  P2P open_id (default: xqdmacminim4's open_id)
#   LARK_CLI             absolute path to lark-cli (default: /Users/xqdmacminim4/.npm-global/bin/lark-cli)

set -euo pipefail

LOG_FILE=""
LARK_CLI="${LARK_CLI:-/Users/xqdmacminim4/.npm-global/bin/lark-cli}"
NOTIFY_USER_ID="${C360_NOTIFY_USER_ID:-ou_8c633881c9f2c8a09428185d45fa834c}"

while (( $# > 0 )); do
  case "$1" in
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --user-id)  NOTIFY_USER_ID="$2"; shift 2 ;;
    --lark-cli) LARK_CLI="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$LOG_FILE" ]]; then
  echo "error: --log-file is required" >&2
  exit 2
fi
if [[ ! -f "$LOG_FILE" ]]; then
  echo "error: log file not found: $LOG_FILE" >&2
  exit 2
fi

# --- parse log ------------------------------------------------------------
# Prefer the post-phase2b "scope: N customers" line; fall back to the legacy
# "found N customers in view" if scope line never appears (miaodaDrivenSync
# disabled or pre-merge runs).
total_customers=$(grep -m1 -oE 'scope: [0-9]+ customers|found [0-9]+ customers' "$LOG_FILE" | head -1 | grep -oE '[0-9]+' || echo "?")
ok=$(grep -cE '^\[[0-9]+/[0-9]+\] OK '   "$LOG_FILE" || echo 0)
fail=$(grep -cE '^\[[0-9]+/[0-9]+\] FAIL ' "$LOG_FILE" || echo 0)
skip=$(grep -cE '^\[[0-9]+/[0-9]+\] SKIP ' "$LOG_FILE" || echo 0)
done=$(grep -oE '^\[[0-9]+/[0-9]+\]' "$LOG_FILE" | tail -1 | grep -oE '[0-9]+' | head -1)
done="${done:-0}"
sum_total30d=$(grep -E '^\[[0-9]+/[0-9]+\] OK ' "$LOG_FILE" | grep -oE 'total30d=[0-9]+' | sed 's/.*=//' | awk '{s+=$1} END {print s+0}')
miaoda_pushed=$(grep -oE 'miaoda=[0-9]+' "$LOG_FILE" | sed 's/.*=//' | awk '{s+=$1} END {print s+0}')

# 妙搭 customer_assignments 表里有、C360 搜不到的客户名单。
# 由 c360_collect.mjs 的 phase2b_resolveMiaodaCustomers 在搜不到时输出
# 一行 "NOTFOUND <count> customers in Miaoda but not in C360: A, B, C"。
# 注意锚点 '^NOTFOUND'（不带 [N/M] 前缀），避免被 progress_watcher 的 RE_END
# 误匹配；也避免误匹配任何未来的 [N/M] NOTFOUND 行（如果有的话）。
notfound_names=$(grep -oE '^NOTFOUND [0-9]+ customers in Miaoda but not in C360: .+$' "$LOG_FILE" | tail -1 | sed -E 's/^NOTFOUND [0-9]+ customers in Miaoda but not in C360: //' || true)
if [[ -n "$notfound_names" ]]; then
  notfound_count=$(echo "$notfound_names" | tr ',' '\n' | grep -c '.' || echo 0)
else
  notfound_count=0
fi

# --- format time + run summary --------------------------------------------
ts=$(basename "$LOG_FILE" .log | sed -E 's/c360_full_//')
ts_human=$(date -j -f "%Y%m%d_%H%M%S" "$ts" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "$ts")

if [[ "$total_customers" != "?" && "$done" =~ ^[0-9]+$ && "$total_customers" =~ ^[0-9]+$ ]]; then
  if (( done >= total_customers )); then
    status="✅ 完成"
  elif (( fail > 0 )); then
    status="⚠️ 部分失败"
  else
    status="🟡 未完成"
  fi
elif (( fail > 0 )); then
  status="⚠️ 部分失败"
else
  status="🟡 未完成"
fi

# Build markdown body. Use $'...' ANSI-C quoting so \n is a real newline.
read -r -d '' BODY <<EOF || true
$status **C360 AI 额度抓取** · ${ts_human}

- 视图：${total_customers} 客户（鑫企点老客户）
- 已处理：**${done} / ${total_customers}**
- 🟢 OK：${ok}　🔴 FAIL：${fail}　⚪ SKIP：${skip}
- 妙搭 DB upsert：${miaoda_pushed} 行
- 近 30 天总消耗合计：${sum_total30d}
- ⚠️ 妙搭有但 C360 无：${notfound_count} 家
- ${notfound_names:-（无）}

📄 完整日志：\`${LOG_FILE}\`
EOF

# --- send ----------------------------------------------------------------
# $'...' lets \n be real newlines; the heredoc already has them.
# Use --as user (default for +messages-send in this script).
"$LARK_CLI" im +messages-send \
  --user-id "$NOTIFY_USER_ID" \
  --markdown "$BODY"

echo "notify: sent to $NOTIFY_USER_ID (ok=$ok fail=$fail skip=$skip done=$done/$total_customers)"
