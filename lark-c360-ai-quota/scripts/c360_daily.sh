#!/bin/bash
# c360_daily.sh — Top-level daily runner invoked by launchd.
# Runs c360_collect.mjs to scrape + sync, then posts a markdown summary
# to the user via lark-cli im +messages-send.
#
# Invoked by ~/Library/LaunchAgents/com.claude.c360-ai-quota.plist
# at 00:30 daily. caffeinate -i is applied by launchd, not here.

set -euo pipefail

SKILL_DIR="/Users/xqdmacminim4/Desktop/feishu_claude/.agents/skills/lark-c360-ai-quota"
LOG="/tmp/c360_full_$(/bin/date +%Y%m%d_%H%M%S).log"
NOTIFY_LOG="${LOG%.log}.notify.log"

export PATH="/Users/xqdmacminim4/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "=== c360_daily start $(/bin/date) ==="
echo "log: $LOG"

# 1. Run the main scrape + sync. Always use a fresh log file so concurrent
#    runs (e.g. manual + scheduled) don't clobber each other.
/usr/local/bin/node "$SKILL_DIR/scripts/c360_collect.mjs" \
  --config "$SKILL_DIR/c360.config.json" \
  --log-file "$LOG"
RC=$?

echo "=== c360_collect exited $RC ==="

# 2. Notify the user. If c360_collect crashed (RC != 0), still notify with
#    what we have so the user knows something went wrong.
"$SKILL_DIR/scripts/c360_notify.sh" \
  --log-file "$LOG" \
  --lark-cli /Users/xqdmacminim4/.npm-global/bin/lark-cli \
  > "$NOTIFY_LOG" 2>&1 || echo "notify failed (see $NOTIFY_LOG)"

echo "=== c360_daily end $(/bin/date) ==="
exit $RC
