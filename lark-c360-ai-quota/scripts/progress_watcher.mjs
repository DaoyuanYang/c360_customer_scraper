#!/usr/bin/env node
// progress_watcher.mjs — Tails a c360_collect.mjs log file and prints a
// 2-line progress summary every poll interval.
//
// Line 1: [============>          ] 47.4% (90/190)
// Line 2: 当前: 深圳市建筑科学研究院股份有限公司
//
// Detection rules (from the live log format produced by c360_collect.mjs):
//   - "--- <name> (<accountId>) → <table>" → customer start
//   - "[N/0] OK|FAIL|SKIP ..."             → customer end (counts as done)
//   - "MIAODA-OK ... upserted=N of M"      → optional milestone (not counted)
//
// Usage:
//   node scripts/progress_watcher.mjs --log <path> --total <N> [--interval 5]
//
//   --total     total customers expected (the view's scrape list size)
//   --interval  poll interval in seconds (default 5)
//   --once      print one snapshot and exit (for one-off checks)
//
// Exits cleanly when the watched log file is no longer being written
// (mtime older than 2 × interval) and the process holding the log is gone.

import { argv, env, exit, stderr, stdout } from 'node:process';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

function parseArgs() {
  const out = { interval: 5, total: 0, log: '', once: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--log') out.log = argv[++i];
    else if (a === '--total') out.total = Number(argv[++i]);
    else if (a === '--interval') out.interval = Number(argv[++i]);
    else if (a === '--once') out.once = true;
    else if (a === '-h' || a === '--help') {
      stderr.write('Usage: node progress_watcher.mjs --log <path> --total <N> [--interval 5] [--once]\n');
      exit(0);
    }
  }
  return out;
}

const args = parseArgs();
if (!args.log) {
  stderr.write('error: --log is required\n');
  exit(2);
}

const RE_PHASE2_FOUND = /^found\s+(\d+)\s+customers\s+in\s+view\b/;
// "scope: N customers (M from C360 view + K from Miaoda)" — preferred when
// miaodaDrivenSync is enabled (covers view + Miaoda union).
const RE_SCOPE = /^scope:\s+(\d+)\s+customers\b/;
// Regex matches progress lines emitted by scripts/progress.mjs (customerEnd):
//   [12/190] OK   客户名 (accountId) days=30 ... dur=20946ms
const RE_END = /^\[(\d+)\/(\d+)\]\s+(OK|FAIL|SKIP)\s+/;
const RE_START = /^---\s+(.+?)\s+\(([^)]+)\)\s+→/;
const RE_TESTMODE = /^--test-mode:\s+(\d+)\s+customers\s+from\s+cfg\.testCustomers/;

function buildBar(done, total, width = 30) {
  const pct = total > 0 ? Math.min(1, done / total) : 0;
  const filled = Math.round(pct * width);
  if (filled === 0) return '[' + ' '.repeat(width) + ']';
  if (filled >= width) return '[' + '='.repeat(width) + ']';
  // Cap arrow at one position before the end; use the cell right before the
  // filled region for the arrow when there's room, otherwise fill solid.
  const head = filled - 1;
  const rest = width - filled;
  return '[' + '='.repeat(head) + '>' + ' '.repeat(rest) + ']';
}

async function snapshot(logPath, totalOverride) {
  let text = '';
  try {
    text = await readFile(logPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');

  // Detect total from the log itself if --total was not provided. Priority:
  // 1. --test-mode: N customers (when --test-mode)
  // 2. "found N customers in view <id>" (the real list size)
  // 3. --total CLI override (caller's explicit value)
  let total = totalOverride || 0;
  let phase2Done = false;
  let done = 0;
  let currentName = '';
  let currentAccount = '';
  for (const line of lines) {
    if (!phase2Done) {
      const tm = RE_TESTMODE.exec(line);
      if (tm) { total = Number(tm[1]); }
      // Prefer "scope: N customers" (post-phase2b union total). Fall back to
      // the legacy "found N customers in view" if scope line never appears
      // (e.g. miaodaDrivenSync disabled or pre-merge runs).
      const sc = RE_SCOPE.exec(line);
      if (sc) { total = Number(sc[1]); phase2Done = true; }
      else {
        const f = RE_PHASE2_FOUND.exec(line);
        if (f) { total = Number(f[1]); phase2Done = true; }
      }
    }
    const s = RE_START.exec(line);
    if (s) {
      currentName = s[1];
      currentAccount = s[2];
    }
    if (RE_END.test(line)) {
      done += 1;
      currentName = '';
      currentAccount = '';
    }
  }

  const pct = total > 0 ? (done / total) * 100 : 0;
  const pctStr = pct.toFixed(1).padStart(5, ' ');
  return {
    done, total,
    currentName, currentAccount,
    bar: buildBar(done, total),
    pctStr,
    phase2Done,
  };
}

function render(snap) {
  if (!snap) {
    return '(log not readable yet)\n(等待 phase2 翻页...)';
  }
  if (!snap.phase2Done) {
    return `(-- 阶段：抓取客户名单 --)\n(等待 phase2 输出 found N customers...)`;
  }
  const head = `${snap.bar} ${snap.pctStr}% (${snap.done}/${snap.total})`;
  const tail = snap.currentName
    ? `当前: ${snap.currentName}`
    : (snap.done >= snap.total ? '已完成' : '(排队中...)');
  return `${head}\n${tail}`;
}

// Write snapshot, overwriting previous 2-line block in-place (works in any TTY
// or in tools that interpret \r; non-TTY readers will see concatenated lines).
function emit(snap) {
  if (!args.once) {
    stderr.write('\x1b[2K\x1b[1A\x1b[2K\r');
  }
  stdout.write(render(snap) + '\n');
}

async function isWriterActive(logPath) {
  // If the file's mtime is older than 2 × interval AND process holding it is gone, treat as done.
  try {
    const st = await stat(logPath);
    const ageMs = Date.now() - st.mtimeMs;
    return ageMs < args.interval * 2000;
  } catch {
    return false;
  }
}

async function run() {
  while (true) {
    const snap = await snapshot(args.log, args.total);
    emit(snap);
    if (args.once) return;
    await new Promise((r) => setTimeout(r, args.interval * 1000));
    if (!(await isWriterActive(args.log))) {
      // Final snapshot then exit.
      const finalSnap = await snapshot(args.log, args.total);
      emit(finalSnap);
      return;
    }
  }
}

run().catch((err) => {
  stderr.write(`watcher fatal: ${err.message}\n`);
  exit(1);
});
