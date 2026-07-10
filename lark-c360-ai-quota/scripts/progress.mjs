#!/usr/bin/env node
// progress.mjs — Lightweight TTY-aware progress reporter for c360_collect.mjs.
//
// Usage:
//   import { createProgress } from './progress.mjs';
//   const p = createProgress({ total: 270, label: 'C360 AI 用量' });
//   p.tick('phase name', info?);
//   p.customerStart('customer name', 'accountId');
//   p.customerEnd({ status: 'ok'|'skip'|'fail', days, newN, skipped, total30d, ingest });
//   p.phaseEnd();
//   p.finish(summaryLines);  // emits final lines + clears progress line
//
// Behavior:
//   - When stderr is a TTY: prints ANSI-cleared single-line progress
//     (overwrites the previous line) + newline at finish.
//   - When stderr is not a TTY (file redirect, launchd, CI, `2>&1 | tee`):
//     falls back to plain append-only log lines so the log file stays readable.
//   - Never throws; any I/O failure is swallowed and ignored.

import { stderr, stdout } from 'node:process';

const TTY = !!(stderr && stderr.isTTY) && !!(stdout && stdout.isTTY);
const ESC = '\x1b[';
const CLEAR_EOL = `${ESC}2K`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

function safeWrite(s) {
  try { stderr.write(s); } catch { /* ignore */ }
}

function fmtMMSS(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function trunc(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function createProgress({ total = 0, label = '' } = {}) {
  let done = 0;
  let ok = 0;
  let fail = 0;
  let skip = 0;
  let totalRef = total;
  const startMs = Date.now();
  let phaseLabel = '';
  let phaseInfo = '';
  let curCustomer = '';
  let curAccountId = '';
  let lastLineLen = 0;
  let ttyActive = false;

  function render() {
    if (!TTY) return;
    const elapsed = (Date.now() - startMs) / 1000;
    const avg = done > 0 ? elapsed / done : 0;
    const eta = avg > 0 && done < totalRef ? avg * (totalRef - done) : 0;
    const parts = [
      `[${done}/${totalRef}]`,
      curCustomer ? `客户: ${trunc(curCustomer, 18)}` : '',
      phaseLabel ? `阶段: ${trunc(phaseLabel, 16)}` : '',
      phaseInfo ? `(${trunc(phaseInfo, 12)})` : '',
      `已用 ${fmtMMSS(elapsed)}`,
      eta > 0 ? `预计剩余 ${fmtMMSS(eta)}` : '',
      `成功 ${ok} 失败 ${fail} 跳过 ${skip}`,
    ].filter(Boolean);
    let line = parts.join('  ');
    if (label) line = `${label}  ${line}`;
    if (line.length < lastLineLen) {
      line = line + ' '.repeat(lastLineLen - line.length);
    }
    lastLineLen = line.length;
    safeWrite(`\r${CLEAR_EOL}${line}`);
  }

  function showCursorOnce() {
    if (ttyActive) {
      safeWrite(SHOW_CURSOR);
      ttyActive = false;
    }
  }

  return {
    setTotal(n) {
      totalRef = Number(n) || 0;
      render();
    },
    tick(phase = '', info = '') {
      phaseLabel = phase || phaseLabel;
      phaseInfo = info || '';
      render();
    },
    customerStart(name = '', accountId = '') {
      curCustomer = name;
      curAccountId = accountId;
      render();
    },
    customerEnd(result = {}) {
      done += 1;
      const s = result.status || 'ok';
      if (s === 'ok') ok += 1;
      else if (s === 'skip') skip += 1;
      else if (s === 'fail') fail += 1;
      // When not a TTY, emit one structured log line per customer so the
      // log file remains self-explanatory.
      if (!TTY) {
        const dur = result.durMs != null ? ` dur=${result.durMs}ms` : '';
        const ingest = result.ingest != null ? ` ingest=${result.ingest}` : '';
        safeWrite(
          `[${done}/${totalRef}] ${s.toUpperCase().padEnd(4)} ${trunc(curCustomer, 28)}` +
          ` (${curAccountId})` +
          ` days=${result.days ?? '-'}` +
          ` new=${result.newN ?? '-'}` +
          ` skipped=${result.skipped ?? '-'}` +
          ` total30d=${result.total30d ?? '-'}` +
          ingest + dur + '\n',
        );
      }
      curCustomer = '';
      curAccountId = '';
      render();
    },
    phaseEnd() {
      if (!TTY) return;
      // Add a newline so the next non-progress line doesn't overwrite.
      safeWrite('\n');
      lastLineLen = 0;
    },
    finish(summaryLines = []) {
      showCursorOnce();
      if (TTY) {
        // Clear the in-progress line and emit a blank line for separation.
        safeWrite(`\r${CLEAR_EOL}\n`);
      }
      for (const line of summaryLines) {
        safeWrite(String(line) + '\n');
      }
    },
    // TTY hint: emit cursor-hide at the very start so cleanup is safe.
    begin() {
      if (TTY) {
        safeWrite(HIDE_CURSOR);
        ttyActive = true;
        render();
      }
    },
    // Read-only accessors (used by tests if any)
    _state() { return { done, ok, fail, skip, total: totalRef, phaseLabel, curCustomer }; },
  };
}
