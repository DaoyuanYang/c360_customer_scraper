#!/usr/bin/env zsh
# c360-progress.zsh — Shell function for viewing c360_collect.mjs run progress.
#
# Source this from ~/.zshrc:
#   for f in /Users/xqdmacminim4/Desktop/feishu_claude/.agents/skills/lark-c360-ai-quota/scripts/c360-progress.zsh; do
#     source "$f"
#   done
#
# Or symlink to ~/.zsh_functions/ if you autoload from there:
#   ln -sf /path/to/this/file ~/.zsh_functions/c360-progress.zsh
#
# Usage:
#   c360-progress                # full multi-line snapshot of latest run (paths + 2-line progress + counts)
#   c360-progress --brief        # one-line compact: [==>] NN% (M/T)  公司 · OK A F B S C
#   c360-progress --watch        # same as --brief but refreshes every 10s in-place (real TTY only)
#   c360-progress --watch --all  # multi-line panel, each run one line, in-place refresh (real TTY)
#   c360-progress --all          # one --brief line per active run (use when multiple agents run in parallel)
#   c360-progress --id N         # select run N from the sorted list (default N=1 = newest)
#   c360-progress --list         # print the run IDs and file paths, no progress
#
# Output examples:
#   c360-progress --brief
#     [=======>            ]  39% (109/279)  深圳奥尼电子股份有限公司 · OK 106 F 0 S 3
#
#   c360-progress --all
#     #1 [=======>          ]  39% (109/279)  深圳奥尼电子股份有限公司 · OK 106 F 0 S 3
#     #2 [==>                ]   5% (5/270)   厦门吉比特网络技术股份有限公司 · OK 5 F 0 S 0
#
#   c360-progress --watch   (rendered in your terminal as same-line refresh)
#     [=======>            ]  39% (109/279)  深圳奥尼电子股份有限公司 · OK 106 F 0 S 3
#     [=======>            ]  39% (109/279)  广州康盛生物科技有限公司 · OK 114 F 0 S 4
#
# Reads:
#   /tmp/c360_progress_*.txt  (written by scripts/progress_watcher.mjs)
#   /tmp/c360_full_*.log      (raw per-customer [N/M] lines)

emulate -L zsh

# --- list helper -----------------------------------------------------------

# Returns newest-first list of /tmp/c360_progress_*.txt
__c360_list_progs() {
  ls -t /tmp/c360_progress_*.txt 2>/dev/null
}

# Given a prog file path, derive the matching log file path.
# /tmp/c360_progress_YYYYmmdd_HHMMSS.txt -> /tmp/c360_full_YYYYmmdd_HHMMSS.log
__c360_prog_to_log() {
  local prog="$1"
  local ts
  ts=$(print -- "$prog" | sed -E 's|.*/c360_progress_([0-9]+_[0-9]+)\.txt$|\1|')
  if [[ -n "$ts" ]]; then
    print -- "/tmp/c360_full_${ts}.log"
  else
    print -- ""
  fi
}

# --- render helpers --------------------------------------------------------

# Print a single brief line for a (prog, log) pair to stdout.
# No newline trimming, no escape sequences — caller decides framing.
__c360_render_brief() {
  local prog="$1" log="$2" id_label="${3:-}"
  if [[ ! -f "$log" ]]; then
    print -- "${id_label}(log missing: ${log})"
    return 1
  fi

  local ok fail skip total_customers done pct current
  ok=$(grep -cE '^\[[0-9]+/[0-9]+\] OK '   "$log")
  fail=$(grep -cE '^\[[0-9]+/[0-9]+\] FAIL ' "$log")
  skip=$(grep -cE '^\[[0-9]+/[0-9]+\] SKIP ' "$log")
  total_customers=$(grep -m1 -oE 'found [0-9]+ customers' "$log" | grep -oE '[0-9]+')
  done=$(grep -oE '^\[[0-9]+/[0-9]+\]' "$log" | tail -1 | grep -oE '[0-9]+' | head -1)
  [[ -z "$done" ]] && done=0
  [[ -z "${total_customers:-}" ]] && total_customers="?"

  current=$(grep -E '^--- ' "$log" | tail -1 | sed -E 's/^--- //; s/ \([^)]+\) →.*$//')

  if [[ "$total_customers" == "?" ]]; then
    pct=0
  else
    pct=$(( done * 100 / total_customers ))
  fi
  local bar="" filled=$(( pct / 5 ))
  local i=0
  for ((; i < 20; i++)); do
    if (( i < filled )); then bar+="="; elif (( i == filled && filled < 20 )); then bar+=">"; else bar+=" "; fi
  done

  local cur
  if [[ -z "$current" ]]; then
    cur="(phase2 翻页中)"
  else
    cur="$current"
  fi

  printf '%s[%s] %3d%% (%d/%s)  %s · OK %d F %d S %d\n' \
    "$id_label" "$bar" "$pct" "$done" "$total_customers" "$cur" "$ok" "$fail" "$skip"
}

# Render ALL runs as a single line joined by ' | '.
# Each run gets a compact 8-char mini bar + counts; no current customer name
# (one-line mode is for narrow terminals / message heartbeat).
__c360_render_oneline() {
  local progs=("$@")
  local n=${#progs}
  if (( n == 0 )); then
    print -- "no c360 run files in /tmp/"
    return 1
  fi

  local parts=() i=1 p
  for p in "${progs[@]}"; do
    local log="" done=0 total="?" pct=0 bar="" filled=0 ok=0 f=0 s=0
    log=$(__c360_prog_to_log "$p")
    if [[ -f "$log" ]]; then
      ok=$(grep -cE '^\[[0-9]+/[0-9]+\] OK '   "$log")
      f=$(grep -cE '^\[[0-9]+/[0-9]+\] FAIL ' "$log")
      s=$(grep -cE '^\[[0-9]+/[0-9]+\] SKIP ' "$log")
      total=$(grep -m1 -oE 'found [0-9]+ customers' "$log" | grep -oE '[0-9]+')
      [[ -z "$total" ]] && total="?"
      done=$(grep -oE '^\[[0-9]+/[0-9]+\]' "$log" | tail -1 | grep -oE '[0-9]+' | head -1)
      [[ -z "$done" ]] && done=0
    fi
    [[ "$total" != "?" ]] && pct=$(( done * 100 / total )) || pct=0
    filled=$(( pct / 14 ))  # 100/14 ≈ 7 → use 7-char bar
    local j=0
    for ((; j < 7; j++)); do
      if (( j < filled )); then bar+="="; elif (( j == filled && filled < 7 )); then bar+=">"; else bar+=" "; fi
    done
    parts+=("$(printf '#%d [%s] %2d%% (%d/%s) OK %d F %d S %d' "$i" "$bar" "$pct" "$done" "$total" "$ok" "$f" "$s")")
    (( i++ ))
  done

  # Join with ' | '
  local out line
  out=""
  for line in "${parts[@]}"; do
    if [[ -z "$out" ]]; then
      out="$line"
    else
      out="${out} | ${line}"
    fi
  done
  print -- "$out"
}

# Render full multi-line snapshot (path + 2-line progress + counters).
__c360_render_full() {
  local prog="$1" log="$2"
  if [[ ! -f "$log" ]]; then
    print -- "📊 $prog"
    print -- "📄 (log missing: $log)"
    return 1
  fi

  local ok fail skip total_customers
  ok=$(grep -cE '^\[[0-9]+/[0-9]+\] OK '   "$log")
  fail=$(grep -cE '^\[[0-9]+/[0-9]+\] FAIL ' "$log")
  skip=$(grep -cE '^\[[0-9]+/[0-9]+\] SKIP ' "$log")
  total_customers=$(grep -m1 -oE 'found [0-9]+ customers' "$log" | grep -oE '[0-9]+')

  print -- "📊 $prog"
  print -- "📄 $log"
  print -- ""
  sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\r/\n/g' "$prog" \
    | grep -E '^(\[|当前|--|完成|排队|等待|阶段)' \
    | tail -2
  print -- ""
  printf "🟢 OK=%-3d  🔴 FAIL=%-3d  ⚪ SKIP=%-3d   (total=%s)\n" \
    "$ok" "$fail" "$skip" "$total_customers"
}

# --- main entry ------------------------------------------------------------

c360-progress() {
  emulate -L zsh

  local mode=full show_all=false id=1 one_line=false

  # Parse flags (accept in any order; --id N, --brief, etc.)
  while (( $# > 0 )); do
    case "$1" in
      --watch|-w)
        mode=watch
        shift
        ;;
      --brief|-b)
        mode=brief
        shift
        ;;
      --all|-a)
        show_all=true
        shift
        ;;
      --one-line|-1)
        one_line=true
        shift
        ;;
      --id|-i)
        id="$2"
        shift 2
        ;;
      --list|-l)
        mode=list
        shift
        ;;
      --help|-h)
        print -- "Usage: c360-progress [--brief|-b] [--watch|-w] [--all|-a] [--one-line|-1]"
        print -- "                  [--id N|-i N] [--list|-l]"
        print -- "  (default)         full multi-line snapshot of latest run"
        print -- "  --brief           one-line compact snapshot of latest run (or all with --all)"
        print -- "  --watch           same as --brief but refreshes every 10s in-place (real TTY only)"
        print -- "  --watch --all     multi-line panel, one run per line, in-place refresh every 10s"
        print -- "  --one-line        EVERY run compressed into a single line, joined with ' | '"
        print -- "  --watch --one-line  same as --one-line but in-place refresh (real TTY only)"
        print -- "  --all             show one brief line per active run (parallel agents)"
        print -- "  --id N            select run N from sorted list (default N=1, newest first)"
        print -- "  --list            list run IDs and their progress/log file paths"
        return 0
        ;;
      *)
        print -- "unknown flag: $1 (try --help)"
        return 2
        ;;
    esac
  done

  # --list: just print the runs we know about.
  if [[ "$mode" == "list" ]]; then
    local progs=("${(@f)$(__c360_list_progs)}")
    if (( ${#progs} == 0 )); then
      print -- "no c360 run files in /tmp/"
      return 1
    fi
    local i=1 p
    for p in "${progs[@]}"; do
      local log=""
      log=$(__c360_prog_to_log "$p")
      local mtime=0 now=0 age=0
      mtime=$(stat -f %m "$p" 2>/dev/null) || mtime=$(date +%s)
      now=$(date +%s)
      age=$(( now - mtime ))
      printf '#%d  age=%4ds  prog=%s  log=%s\n' "$i" "$age" "$p" "$log"
      (( i++ ))
    done
    return 0
  fi

  local progs=("${(@f)$(__c360_list_progs)}")
  if (( ${#progs} == 0 )); then
    print -- "no c360 run files in /tmp/"
    return 1
  fi

  # --all WITHOUT --watch/--brief: render brief line for every run.
  # (With --watch or --brief, --all handling is in the case statement below.)
  if $show_all && [[ "$mode" == "full" ]]; then
    local i=1 p
    for p in "${progs[@]}"; do
      local log=""
      log=$(__c360_prog_to_log "$p")
      __c360_render_brief "$p" "$log" "#${i} "
      (( i++ ))
    done
    return 0
  fi

  # Select run by id (default 1 = newest).
  if (( id < 1 || id > ${#progs} )); then
    print -- "id ${id} out of range (1..${#progs}); try --list"
    return 1
  fi
  local prog="${progs[$id]}"
  local log=""
  log=$(__c360_prog_to_log "$prog")

  case "$mode" in
    watch)
      if [[ ! -t 1 ]]; then
        print -- "c360-progress --watch needs a real TTY; falling back to --brief once"
        __c360_render_brief "$prog" "$log"
        return $?
      fi
      # --watch --one-line: single aggregated line, in-place refresh.
      if $one_line; then
        local progs_locked=("${(@f)$(__c360_list_progs)}")
        if (( ${#progs_locked} == 0 )); then
          print -- "no c360 run files in /tmp/"
          return 1
        fi
        print -n $'\x1b[?25l'  # hide cursor
        trap 'print -rn -- $'\''\x1b[?25h\x1b[2K\r'\'' ; return 0' INT TERM
        while true; do
          # NOTE: assign-then-set to avoid `local x=$(...)` echo bug in some zsh versions.
          local line=""
          line=$(__c360_render_oneline "${progs_locked[@]}")
          print -rn -- $'\r\x1b[2K'"$line"
          sleep 10
        done
      fi
      # --watch --all: multi-line panel, each run one line, refresh in-place.
      if $show_all; then
        # Capture runs ONCE; subsequent refreshes draw the same set so the
        # panel height is stable. New runs added during a session won't
        # appear until the user restarts --watch --all.
        local progs_locked=("${(@f)$(__c360_list_progs)}")
        local n_lines=${#progs_locked}
        if (( n_lines == 0 )); then
          print -- "no c360 run files in /tmp/"
          return 1
        fi
        print -n $'\x1b[?25l'  # hide cursor
        trap 'print -rn -- $'\''\x1b[?25h\x1b[?7h'\'' ; return 0' INT TERM
        local first=1
        while true; do
          if (( first )); then
            first=0
          else
            # Move cursor up N lines, then clear from cursor down.
            print -rn -- $'\x1b['"${n_lines}"'A\x1b[J'
          fi
          local i=1 p
          for p in "${progs_locked[@]}"; do
            local l=""
            l=$(__c360_prog_to_log "$p")
            __c360_render_brief "$p" "$l" "#${i} "
            (( i++ ))
          done
          sleep 10
        done
      fi
      # --watch (single run): TTY in-place refresh loop.
      print -n $'\x1b[?25l'  # hide cursor
      trap 'print -rn -- $'\''\x1b[?25h\x1b[2K\r'\'' ; return 0' INT TERM
      while true; do
        local line=""
        line=$(__c360_render_brief "$prog" "$log")
        print -rn -- $'\r\x1b[2K'"$line"
        sleep 10
      done
      ;;
    brief)
      # --brief --all: stacked lines, one per run (no TTY detection; this
      # is the right shape for AI heartbeats when multiple agents run).
      if $show_all; then
        local i=1 p
        for p in "${progs[@]}"; do
          local l=""
          l=$(__c360_prog_to_log "$p")
          __c360_render_brief "$p" "$l" "#${i} "
          (( i++ ))
        done
        return 0
      fi
      __c360_render_brief "$prog" "$log"
      ;;
    *)
      # --one-line (without --watch): always aggregate ALL runs into a
      # single line, joined with " | ".
      if $one_line; then
        __c360_render_oneline "${progs[@]}"
        return 0
      fi
      __c360_render_full "$prog" "$log"
      ;;
  esac
}
