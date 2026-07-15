#!/usr/bin/env node
// c360_collect.mjs — End-to-end C360 → 飞书多维表格 scraper.
//
// Drives a debug-mode Edge via scripts/cdp.mjs, captures the
// `anchor/api/entity/tenant_metrics/metrics_list` XHR for each customer,
// and writes dedup'd daily rows to 飞书多维表格 via lark-cli.
//
// Usage:
//   node c360_collect.mjs [--customer <name>] [--config <path>] [--log-file <path>]
//                         [--debug-port 18800] [--reuse-target]
//
// Defaults:
//   --config     ./c360.config.json
//   --debug-port 18800  (CDP_PORT)
//
// Env:
//   LARK_CLI     absolute path to lark-cli binary
//                (default: $HOME/.npm-global/bin/lark-cli)
//   CDP_PORT     default 18800
//   CDP_HOST     default 127.0.0.1
//   C360_CONFIG  override config path

import { argv, env, exit, stdout, stderr } from 'node:process';
import { readFile, writeFile, mkdtemp, rm, mkdir, open as openFs, unlink } from 'node:fs/promises';
import { createWriteStream, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createProgress } from './progress.mjs';

const execFile = promisify(execFileCb);

const LARK_CLI = env.LARK_CLI || join(env.HOME, '.npm-global/bin/lark-cli');
// Per-product C360 metrics keys (also used as the column names in 妙搭 DB
// when no explicit column override is supplied in cfg.miaodaDb.columns).
// `syntheticZero: true` entries are not fetched from the API; they always
// push 0 (e.g. features that aren't billed on the same metrics_list endpoint).
// `aliasedAs: '<column>'` entries are surfaced through the named hardcoded
// column instead of writing their own column (avoids duplicate columns in
// the INSERT statement). E.g. ai_credits_asset_usage is the per-day total
// and is stored in the hardcoded `total` column.
const METRIC_KEYS = [
  { key: 'ai_credits_asset_usage',          syntheticZero: false, aliasedAs: 'total' },
  { key: 'ai_credits_asset_usage_knowledge',syntheticZero: false },
  { key: 'ai_credits_asset_usage_vc_ai',    syntheticZero: false },
  { key: 'ai_credits_asset_usage_aily_buddy',syntheticZero: false },
  { key: 'ai_credits_asset_usage_miaoda',   syntheticZero: false },
  { key: 'ai_credits_asset_usage_miaoda_claw',syntheticZero: false },
  { key: 'ai_credits_asset_usage_aily_app', syntheticZero: false },
  { key: 'ai_credits_asset_usage_aily_agent',syntheticZero: false },
  { key: 'ai_credits_asset_usage_apaas',    syntheticZero: false },
  { key: 'ai_credits_asset_usage_doc_ai',   syntheticZero: false },
  { key: 'ai_credits_asset_usage_base',     syntheticZero: false },
  { key: 'ai_credits_asset_usage_meego',    syntheticZero: false },
  { key: 'ai_credits_asset_usage_nexus_bot',syntheticZero: false },
  { key: 'ai_credits_aily_pro',             syntheticZero: true  },  // C360 暂无此产品(对应 飞书 aily 专用额度),保持 0
];

// Mirror every log() line to args.logFile when set (wired up right after
// parseArgs() — `args` doesn't exist at this point). Default to stderr only
// so pre-parseArgs paths (help text, lock contention) still produce output.
let _logFileStream = null;
const log = (...a) => {
  const line = a.map(String).join(' ') + '\n';
  stderr.write(line);
  if (_logFileStream) {
    try { _logFileStream.write(line); } catch { /* ignore stream errors */ }
  }
};

// --- arg parsing ---------------------------------------------------------

function parseArgs() {
  const out = {
    customer: null, config: null, logFile: null, debugPort: null,
    reuseTarget: false, testMode: false, dryRun: false,
    concurrency: 2,
    batchSize: 10,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--customer') out.customer = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--log-file') out.logFile = argv[++i];
    else if (a === '--debug-port') out.debugPort = Number(argv[++i]);
    else if (a === '--reuse-target') out.reuseTarget = true;
    else if (a === '--test-mode') out.testMode = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--concurrency') out.concurrency = Math.max(1, Math.min(8, Number(argv[++i])));
    else if (a === '--batch-size') out.batchSize = Math.max(1, Math.min(100, Number(argv[++i])));
    else if (a === '-h' || a === '--help') {
      log('Usage: node c360_collect.mjs [options]');
      log('');
      log('Options:');
      log('  --customer <name>    Process only this customer (exact name match)');
      log('  --test-mode          Process only customers in cfg.testCustomers');
      log('  --dry-run            Skip DB writes; log SQL that would have been executed');
      log('  --config <path>      Config file (default: ./c360.config.json)');
      log('  --debug-port <N>     Edge CDP port (default 18800)');
      log('  --reuse-target       Reuse one Edge tab across phases');
      log('  --log-file <path>    Log file path');
      log('  --concurrency <N>    Number of parallel C360 worker tabs (default 2, max 8)');
      log('  --batch-size <N>     Customers per 妙搭 SQL upsert (default 10, max 100)');
      exit(0);
    } else {
      log(`unknown arg: ${a}`);
      exit(2);
    }
  }
  return out;
}

// --- lark-cli wrapper ----------------------------------------------------
//
// Stage B: switched from spawnSync (synchronous, blocks the event loop,
// serializes all CLI calls) to promisify(execFile). Concurrent workers
// can now run multiple lark-cli sub-processes at once. Semantics preserved:
//   - allowFail: true → returns { status, stdout, stderr } on non-zero exit
//   - allowFail: false (default) → throws on non-zero exit
//
// Note: `cwd` from opts is forwarded as the spawn cwd (used by phase5
// base writes and miaoda DB pushes to point at unique os.tmpdir() paths).
async function lark(args, opts = {}) {
  // Separate execFile-only options from the result-shape options.
  const { allowFail = false, ...execOpts } = opts;
  try {
    const { stdout, stderr } = await execFile(LARK_CLI, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,   // 64 MB; large INSERT VALUES can be huge
      ...execOpts,
    });
    return { status: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    // execFile rejects with an Error whose `.code` is the exit code (number
    // or null) and `.stdout`/`.stderr` hold captured output. Other failure
    // modes (ENOENT, etc.) surface as err.code = string and no stdout/stderr.
    const status = typeof err.code === 'number' ? err.code : 1;
    const out = err.stdout ?? '';
    const errOut = err.stderr ?? '';
    if (allowFail) {
      return { status, stdout: out, stderr: errOut, error: err };
    }
    throw new Error(
      `lark-cli ${args[0]} failed (exit ${status}):\n${errOut || out}\n${err.message}`
    );
  }
}

// --- CDP wrappers --------------------------------------------------------

const CDP = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'cdp.mjs');

async function cdp(args, opts = {}) {
  // `cdp.mjs` returns structured output: `targets` (JSON), `new <url>` (JSON),
  // `eval <tabId> <code>` (raw string from the page), `navigate <tabId> <url>`
  // (raw ack), `close <tabId>` (raw ack). We just propagate stdout/stderr.
  try {
    const { stdout, stderr } = await execFile('node', [CDP, ...args.map(String)], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
    return { status: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    const status = typeof err.code === 'number' ? err.code : 1;
    if (opts.allowFail) {
      return {
        status,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        error: err,
      };
    }
    throw new Error(
      `cdp ${args[0]} failed (exit ${status}):\n${err.stderr || err.stdout || err.message}`
    );
  }
}

async function cdpJson(args) {
  const r = await cdp(args, { allowFail: true });
  if (r.status !== 0) {
    throw new Error(`cdp ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  // cdp.mjs prints JSON to stdout (last line for some subcommands may include a status line on stderr)
  return JSON.parse(r.stdout.trim());
}

async function cdpRaw(args) {
  const r = await cdp(args, { allowFail: true });
  if (r.status !== 0) {
    throw new Error(`cdp ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  // cdp.mjs `eval` outputs a {type, value} wrapper; other subcommands output
  // a plain JSON value. Unwrap if the wrapper is present.
  const stdout = r.stdout.trim();
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return stdout; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'type' in parsed && 'value' in parsed) {
    return parsed.value;
  }
  return parsed;
}

async function fetchTargets() {
  return cdpJson(['targets']);
}

async function findOrCreateC360Tab() {
  const targets = await fetchTargets();
  // Prefer a tab already on c360.larkoffice.com
  const onSite = targets.find((t) => (t.url || '').includes('c360.larkoffice.com') && t.type === 'page');
  if (onSite) return onSite.id;
  // Otherwise open a new tab on the customer-list URL
  const viewId = cfg.viewId || 'user-67';
  const listUrl = `https://c360.larkoffice.com/pc/account/list?viewId=${viewId}`;
  const t = await cdpJson(['new', listUrl]);
  return t.id;
}

// --- phases --------------------------------------------------------------

async function phase0_ensureEdge() {
  // Try targets — if it works, the port is open and a browser is responding.
  try {
    const targets = await fetchTargets();
    // Smoke test on the first page target
    const page = targets.find((t) => t.type === 'page');
    if (page) {
      const v = await cdpRaw(['eval', page.id, '1+1']);
      if (v === '2' || v === 2) return { alreadyRunning: true, targetId: page.id };
    }
    log('Edge responded but smoke test failed — killing zombie processes.');
  } catch (err) {
    log(`Edge not reachable on port ${env.CDP_PORT ?? 18800}: ${err.message}`);
  }

  // Kill any zombie Edge processes holding the port
  spawnSync('pkill', ['-f', 'Microsoft Edge.*remote-debugging-port'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1000));

  // Launch a fresh debug Edge
  const port = env.CDP_PORT ?? '18800';
  const userDataDir = cfg.userDataDir || `/tmp/claude-c360-debug-edge`;
  const url = `https://c360.larkoffice.com/pc/account/list?viewId=${cfg.viewId || 'user-67'}`;
  log(`Launching Edge with --remote-debugging-port=${port} ...`);
  const r = spawnSync('open', [
    '-na', 'Microsoft Edge',
    '--args',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    url,
  ], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`failed to launch Edge (exit ${r.status}). Is Microsoft Edge installed?`);
  }

  // Poll for up to 10s
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const targets = await fetchTargets();
      const page = targets.find((t) => t.type === 'page' && (t.url || '').includes('c360.larkoffice.com'));
      if (page) {
        log(`Edge up. C360 tab: ${page.id} (${page.title})`);
        return { alreadyRunning: false, targetId: page.id };
      }
    } catch { /* keep polling */ }
  }
  throw new Error('Edge launched but no C360 tab appeared after 10s. Please log in to C360 in the Edge window, then re-run.');
}

async function phase1_ensureAuth() {
  const r = await lark(['auth', 'status'], { allowFail: true });
  if (r.status !== 0) {
    throw new Error(`lark-cli auth failed (exit ${r.status}):\n${r.stderr || r.stdout}\n\nRun: ${LARK_CLI} auth login`);
  }
  log(`lark-cli auth ok: ${(r.stdout || '').split('\n')[0]}`);
}

// Poll the C360 SPA DOM until the pagination component mounts, or until
// timeoutMs elapses. C360's launchd background runs would sometimes load
// the page skeleton without the pagination row, causing NO_PAGE_1 and 0
// customers scraped. Returns true if pagination appeared, false on timeout.
// The interval is short (500ms) so we don't hammer CDP on every check.
async function waitForPagination(targetId, timeoutMs = 30000) {
  const PROBE = `document.querySelectorAll('.ud-c360__pagination-item').length`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await cdpRaw(['eval', targetId, PROBE]);
      if (Number(r) > 0) return true;
    } catch { /* transient CDP error — keep polling */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function phase2_fetchCustomers(targetId) {
  // Click-based pagination. C360's URL `?page=N` param updates the URL but
  // does NOT actually change the rendered customer list — only a DOM click
  // on .ud-c360__pagination-next (or jump-next) advances the SPA state.
  // So we navigate to page 1 once, then loop: extract → click next → wait.
  const viewId = cfg.viewId || 'user-67';
  const MAX_PAGES = 30;  // safety cap
  const EXTRACT_CODE = `
    JSON.stringify(
      Array.from(document.querySelectorAll('a'))
        .filter(a => (a.getAttribute('href') || '').includes('account/detail'))
        .map(a => ({
          name: (a.textContent || '').trim(),
          accountId: ((a.getAttribute('href') || '').match(new RegExp('detail/([^?]+)')) || [])[1] || ''
        }))
        .filter(c => c.accountId)
    )
  `;
  const TOTAL_CODE = `(document.body.innerText.match(/共\\s*(\\d+)\\s*条/) || [])[1] || ''`;
  // Synthesize a real pointer/mouse event sequence at the element's center.
  // The C360 ud-c360 UI components listen on pointerdown/mousedown, NOT on
  // plain click. Calling el.click() only fires 'click' and is silently ignored.
  // We must dispatch the full sequence with non-zero coordinates.
  const DISPATCH_CLICK_AT_CENTER = `
    (el) => {
      if (!el) return false;
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const ev = (type.startsWith('pointer'))
          ? new PointerEvent(type, { ...opts, clientX: cx, clientY: cy, pointerType: 'mouse' })
          : new MouseEvent(type, { ...opts, clientX: cx, clientY: cy });
        el.dispatchEvent(ev);
      }
      return true;
    }
  `;
  // Click the "next" button (.ud-c360__pagination-next). Fall back to
  // .ud-c360__pagination-jump-next if next is missing. Return status string
  // for caller to decide whether to stop.
  const NEXT_CLICK_CODE = `
    (() => {
      const isDisabled = (el) => el && (el.classList.contains('ud-c360__pagination-disabled') || el.disabled || el.getAttribute('aria-disabled') === 'true');
      const tryClick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        if (isDisabled(el)) return 'DISABLED';
        (${DISPATCH_CLICK_AT_CENTER})(el);
        return 'dispatched:' + sel;
      };
      return tryClick('.ud-c360__pagination-next') || tryClick('.ud-c360__pagination-jump-next') || 'NOT_FOUND';
    })()
  `;
  // Click page 1 explicitly to reset the SPA state. The C360 SPA persists
  // its current page across navigations, so a fresh ?viewId=... URL might
  // still land on a non-first page if the user was previously deep in the
  // pagination. Clicking page 1 first guarantees we start from the top.
  const GOTO_PAGE_1_CODE = `
    (() => {
      const items = Array.from(document.querySelectorAll('.ud-c360__pagination-item'));
      const page1 = items.find(it => it.textContent.trim() === '1');
      if (!page1) return 'NO_PAGE_1';
      (${DISPATCH_CLICK_AT_CENTER})(page1);
      return 'dispatched-page-1';
    })()
  `;
  // Initial navigation to the view. After load, wait for the pagination
  // component (.ud-c360__pagination-item) to actually mount — a fixed
  // setTimeout(4000) used to lose races on launchd cold-start when the SPA
  // hadn't finished initial render, returning NO_PAGE_1 and scraping 0 rows.
  const url = `https://c360.larkoffice.com/pc/account/list?viewId=${viewId}`;
  await cdpRaw(['navigate', targetId, url]);
  // Reset to page 1, with retry. If the pagination didn't mount yet (e.g.
  // cold start under launchd background throttling), the first attempt
  // returns NO_PAGE_1; reload and retry up to MAX_PAGE_1_RETRIES times
  // before giving up. Each retry waits for pagination to appear via
  // waitForPagination (poll the DOM until it's there, up to 30s).
  const MAX_PAGE_1_RETRIES = 3;
  let goto1 = 'NO_PAGE_1';
  for (let attempt = 1; attempt <= MAX_PAGE_1_RETRIES; attempt++) {
    const ready = await waitForPagination(targetId, 30000);
    if (!ready) {
      log(`  reset: pagination not ready (attempt ${attempt}/${MAX_PAGE_1_RETRIES}) — reloading`);
      await cdpRaw(['navigate', targetId, url]);
      continue;
    }
    goto1 = await cdpRaw(['eval', targetId, GOTO_PAGE_1_CODE]);
    log(`  reset: ${goto1} (attempt ${attempt}/${MAX_PAGE_1_RETRIES})`);
    if (goto1 === 'dispatched-page-1') break;
    if (attempt < MAX_PAGE_1_RETRIES) {
      log(`  reset: NO_PAGE_1 — reloading and retrying`);
      await cdpRaw(['navigate', targetId, url]);
    }
  }
  if (goto1 !== 'dispatched-page-1') {
    log(`  reset: gave up after ${MAX_PAGE_1_RETRIES} attempts — skipping view`);
    return [];
  }
  await new Promise((r) => setTimeout(r, 2500));
  const all = [];
  let total = null;
  let prevFirstName = null;
  for (let i = 1; i <= MAX_PAGES; i++) {
    const json = await cdpRaw(['eval', targetId, EXTRACT_CODE]);
    const customers = JSON.parse(json);
    log(`  page ${i}: ${customers.length} customers`);
    if (customers.length === 0) break;
    // Sanity check: if the first customer didn't change after a click, the
    // page didn't actually advance.
    if (i > 1 && customers[0]?.name === prevFirstName) {
      log(`  page didn't advance (first customer unchanged) — stopping`);
      break;
    }
    prevFirstName = customers[0]?.name;
    all.push(...customers);
    if (total === null) {
      const t = await cdpRaw(['eval', targetId, TOTAL_CODE]);
      total = Number(t) || null;
      if (total) log(`  total: ${total}`);
    }
    if (total && all.length >= total) {
      log(`  reached total (${all.length}/${total})`);
      break;
    }
    // Click "next" page button.
    const r = await cdpRaw(['eval', targetId, NEXT_CLICK_CODE]);
    if (r === 'DISABLED' || r === 'NOT_FOUND') {
      log(`  next button ${r} — last page`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (total && all.length < total) {
    log(`WARN: only scraped ${all.length}/${total} customers — MAX_PAGES=${MAX_PAGES} may be too low`);
  }
  return all;
}

async function phase2c_searchC360ByName(targetId, query) {
  // 全局搜索 C360（顶部搜索框 .ud-c360__native-input），按客户名解析
  // accountId。用 React-aware input setter（前端 CDP 验证有效）。
  // 翻页通过 ud-c360 pagination-next 的 pointer/mouse 链触发。
  // 返回精确匹配 query 的 { name, accountId } 列表。
  //
  // 重要：C360 的搜索是**按当前视图过滤**的（不是全局）。
  // user-67「鑫企点老客户」只搜得到 view 内的客户，搜不到其它视图的。
  // 想要跨视图找客户，必须切到「全部客户」(`system-5`)，那是包容性最大的视图。
  // 通过 miaodaDrivenSync.searchViewId 配置；默认 system-5。
  const SEARCH_MAX_PAGES = cfg.miaodaDrivenSync?.searchPageSize ?? 5;
  const viewId = cfg.miaodaDrivenSync?.searchViewId || 'system-5';
  // 提取每页的 account/detail 链接。
  const EXTRACT_CODE = `
    JSON.stringify(
      Array.from(document.querySelectorAll('a'))
        .filter(a => (a.getAttribute('href') || '').includes('account/detail'))
        .map(a => ({
          name: (a.textContent || '').trim(),
          accountId: ((a.getAttribute('href') || '').match(new RegExp('detail/([^?]+)')) || [])[1] || ''
        }))
        .filter(c => c.accountId)
    )
  `;
  // React-aware 写 search input。
  const SET_QUERY_CODE = `
    (() => {
      const inp = document.querySelector('.ud-c360__native-input');
      if (!inp) return 'NO_INPUT';
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      desc.set.call(inp, ${JSON.stringify(query)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'set';
    })()
  `;
  // next 按钮点击走完整 pointer/mouse 链（ud-c360 监听 pointerdown/mousedown，不监听 click）。
  const DISPATCH_CLICK_AT_CENTER = `
    (el) => {
      if (!el) return false;
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const ev = (type.startsWith('pointer'))
          ? new PointerEvent(type, { ...opts, clientX: cx, clientY: cy, pointerType: 'mouse' })
          : new MouseEvent(type, { ...opts, clientX: cx, clientY: cy });
        el.dispatchEvent(ev);
      }
      return true;
    }
  `;
  const NEXT_CLICK_CODE = `
    (() => {
      const isDisabled = (el) => el && (el.classList.contains('ud-c360__pagination-disabled') || el.disabled || el.getAttribute('aria-disabled') === 'true');
      const tryClick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        if (isDisabled(el)) return 'DISABLED';
        (${DISPATCH_CLICK_AT_CENTER})(el);
        return 'dispatched:' + sel;
      };
      return tryClick('.ud-c360__pagination-next') || tryClick('.ud-c360__pagination-jump-next') || 'NOT_FOUND';
    })()
  `;
  // 导航到 viewId 列表页 reset 状态（搜索框在同一页顶部，但需要在第 1 页）。
  const searchUrl = `https://c360.larkoffice.com/pc/account/list?viewId=${viewId}`;
  await cdpRaw(['navigate', targetId, searchUrl]);
  // 等待搜索输入框挂载（避免冷启动拿到 skeleton 写不进去）。30s 内没出来就放弃。
  const INPUT_READY = `document.querySelector('.ud-c360__native-input') ? 'READY' : 'NOT_READY'`;
  const inputDeadline = Date.now() + 30000;
  let inputReady = 'NOT_READY';
  while (Date.now() < inputDeadline) {
    try { inputReady = await cdpRaw(['eval', targetId, INPUT_READY]); } catch { /* keep polling */ }
    if (inputReady === 'READY') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (inputReady !== 'READY') {
    log(`WARN phase2c_searchC360ByName: search input did not mount within 30s for query "${query}"`);
    return [];
  }
  // 写搜索框。
  const setResult = await cdpRaw(['eval', targetId, SET_QUERY_CODE]);
  if (setResult === 'NO_INPUT') {
    log(`WARN phase2c_searchC360ByName: search input not found on page for query "${query}"`);
    return [];
  }
  await new Promise((r) => setTimeout(r, 2500));
  // 翻页取全部结果。
  const all = [];
  for (let i = 1; i <= SEARCH_MAX_PAGES; i++) {
    const json = await cdpRaw(['eval', targetId, EXTRACT_CODE]);
    let rows;
    try { rows = JSON.parse(json); } catch { rows = []; }
    if (!rows.length) break;
    all.push(...rows);
    if (i === SEARCH_MAX_PAGES) {
      const cap = SEARCH_MAX_PAGES * 20;
      log(`WARN phase2c_searchC360ByName: query "${query}" hit SEARCH_MAX_PAGES=${SEARCH_MAX_PAGES} (>=${cap} rows); may be incomplete`);
      break;
    }
    const r = await cdpRaw(['eval', targetId, NEXT_CLICK_CODE]);
    if (r === 'DISABLED' || r === 'NOT_FOUND') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  // 精确名匹配 post-filter（C360 搜索是模糊的，避免「易威行贸易」匹配「易威行贸易有限公司」）。
  const q = query.trim().toLowerCase();
  const exact = all.filter((r) => (r.name || '').trim().toLowerCase() === q);
  if (!exact.length && all.length) {
    log(`phase2c_searchC360ByName: query "${query}" had ${all.length} fuzzy hits but 0 exact matches: ${all.slice(0, 5).map((r) => r.name).join(' | ')}${all.length > 5 ? ' ...' : ''}`);
  }
  return exact;
}

async function phase2b_resolveMiaodaCustomers(targetId, customers) {
  // 在 phase2_fetchCustomers 拿到 view 客户列表后，叠加扫妙搭
  // customer_assignments 表：view 已有的不重搜（excludeIfC365ViewHas=true），
  // 其余逐个调 phase2c_searchC360ByName 解析；搜不到的发 WARN + 累计
  // notFoundNames，最后输出 1 行 NOTFOUND ... 给 c360_notify.sh 解析。
  if (!cfg.miaodaDrivenSync?.enabled) return customers;
  const m = cfg.miaodaDrivenSync;
  if (!cfg.miaodaDb?.enabled) {
    log(`WARN miaodaDrivenSync.enabled=true but cfg.miaodaDb.enabled=false; skipping Miaoda resolution`);
    return customers;
  }
  const appId = cfg.miaodaDb.appId;
  const schema = cfg.miaodaDb.schema;
  const table = m.assignmentsTable || 'customer_assignments';
  const col = m.customerNameColumn || 'customer_name';
  const excludeSet = new Set(m.excludeNames || []);
  const skipIfInView = m.excludeIfC360ViewHas !== false;
  // 1) 拉取 Miaoda customer_name 列表。
  const sql = `SELECT ${col} AS customer_name FROM ${schema}.${table} WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col}`;
  const r = await lark(['apps', '+db-execute', '--app-id', appId, '--environment', cfg.miaodaDb.env, '--sql', sql, '--yes'], { allowFail: true });
  if (r.status !== 0) {
    log(`WARN phase2b: failed to query Miaoda ${schema}.${table}: ${r.stderr || r.stdout}`);
    return customers;
  }
  let parsed;
  try {
    const data = JSON.parse(r.stdout);
    parsed = JSON.parse(data.data?.results?.[0]?.data || '[]');
  } catch (err) {
    log(`WARN phase2b: bad JSON from Miaoda query: ${err.message}`);
    return customers;
  }
  const miaodaNames = Array.from(new Set(parsed.map((x) => x.customer_name).filter(Boolean)));
  log(`phase2b: ${miaodaNames.length} unique customer names from Miaoda ${schema}.${table}`);
  // 2) 算出 view 未覆盖的 diff。
  const viewNames = new Set(customers.map((c) => c.name));
  const toResolve = [];
  for (const name of miaodaNames) {
    if (skipIfInView && viewNames.has(name)) continue;     // view 已有，不重搜
    if (excludeSet.has(name)) continue;                     // 显式排除
    toResolve.push(name);
  }
  log(`phase2b: ${toResolve.length} Miaoda names to C360-search (skipped ${miaodaNames.length - toResolve.length} covered by view or excludeNames)`);
  // 3) 逐个搜 C360（serial 跑；并发可后续加）。
  const notFound = [];
  let added = 0;
  for (const name of toResolve) {
    let hits;
    try { hits = await phase2c_searchC360ByName(targetId, name); }
    catch (err) { log(`WARN phase2b: search "${name}" threw: ${err.message}`); notFound.push(name); continue; }
    if (hits.length === 1) {
      customers.push({ name, accountId: hits[0].accountId });
      added += 1;
    } else if (hits.length > 1) {
      log(`WARN phase2b: search "${name}" returned ${hits.length} exact-name hits (should be 1): ${hits.map((h) => h.accountId).join(', ')}; treating as not-found`);
      notFound.push(name);
    } else {
      notFound.push(name);
    }
  }
  // 4) 输出 scope 汇总行（吃 progress_watcher 的 RE_SCOPE + 人类阅读）。
  const fromView = viewNames.size;
  log(`scope: ${customers.length} customers (${fromView} from C360 view ${cfg.viewId} + ${added} resolved from Miaoda ${schema}.${table})`);
  // 5) 输出 NOTFOUND 汇总行（吃 c360_notify.sh 的 '^NOTFOUND ...' 解析）。
  if (notFound.length) {
    log(`NOTFOUND ${notFound.length} customers in Miaoda but not in C360: ${notFound.join(', ')}`);
  }
  return customers;
}

async function phase3_fetchSnapshot(targetId, accountId) {
  // anchor=tenant-list 强制切到"租户列表"子模块,否则默认显示"资产/订阅"列表,
  // 找不到 /pc/tenant/detail/ 链接,导致 SKIP: no tenant (2026-06-30 易威行首次踩到)
  const url = `https://c360.larkoffice.com/pc/account/detail/${accountId}?tab=tenant-asset-data&anchor=tenant-list`;
  await cdpRaw(['navigate', targetId, url]);
  await new Promise((r) => setTimeout(r, 4000));
  // Tenant IDs live in <a href="/pc/tenant/detail/XXX"> attributes, NOT in
  // rendered text — so a TreeWalker on text nodes can't find them. Query
  // anchors directly. Mark the main tenant by checking the row context for
  // "主租户" / "企业认证成功".
  const code = `
    JSON.stringify({
      tenants: Array.from(document.querySelectorAll('a'))
        .filter(a => (a.getAttribute('href') || '').includes('/pc/tenant/detail/'))
        .map(a => {
          const href = a.getAttribute('href') || '';
          const id = (href.match(/\\/pc\\/tenant\\/detail\\/([A-Za-z0-9]+)/) || [])[1] || '';
          const row = a.closest('tr');
          const rowText = row ? row.innerText : '';
          return {
            id,
            name: (a.textContent || '').trim(),
            isMain: rowText.includes('主租户') || rowText.includes('企业认证成功'),
          };
        }),
      consumptionRate: (() => {
        const m = (document.body.innerText || '').match(/AI 预计到期消耗率[：:]\\s*([0-9.]+)\\s*%/);
        return m ? Number(m[1]) : 0;
      })(),
    })
  `;
  const json = await cdpRaw(['eval', targetId, code]);
  const { tenants, consumptionRate } = JSON.parse(json);
  const tenantIds = tenants.map((t) => t.id);
  const main = tenants.find((t) => t.isMain) || tenants[0];
  return { tenantIds, mainTenant: main ? main.id : null, consumptionRate };
}

async function phase4_fetchDailyMetrics(targetId, accountId, tenantId) {
  // 1) Navigate to tenant detail
  const url = `https://c360.larkoffice.com/pc/tenant/detail/${tenantId}`;
  await cdpRaw(['navigate', targetId, url]);
  await new Promise((r) => setTimeout(r, 4000));
  // 2) Inject XHR interceptor (must be done after navigation)
  await cdpRaw(['eval', targetId, `
    window.__c360_captured = null;
    if (!window.__c360_orig_open) window.__c360_orig_open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) {
      this._url = (typeof u === 'string') ? u : '';
      if (this._url.includes('metrics_list')) {
        this.addEventListener('load', function() { window.__c360_captured = this.responseText; });
      }
      return window.__c360_orig_open.apply(this, arguments);
    };
    'interceptor injected'
  `]);
  // 3) Click tab index 3 (额度消耗)
  await cdpRaw(['eval', targetId, `
    (() => {
      const tabs = document.querySelectorAll('.ud-c360__tabs__tab');
      if (!tabs[3]) return 'NO_TAB_3';
      tabs[3].click();
      return 'clicked';
    })()
  `]);
  // 4) Wait for the API response
  await new Promise((r) => setTimeout(r, 8000));
  // 5) Read the captured payload
  const raw = await cdpRaw(['eval', targetId, 'window.__c360_captured']);
  if (!raw || raw === 'null') throw new Error('NO_CAPTURE: XHR interceptor missed the API call');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('BAD_JSON from XHR capture'); }
  if (!parsed?.data?.list?.length) throw new Error('EMPTY: metrics_list returned no rows');
  return parsed;
}

function buildRows(list, meta = {}) {
  // Returns an array of plain objects ready for 妙搭 DB upsert. Each row:
  //   { record_id, customer_name, account_id, view_source,
  //     record_date, total, data_source, main_tenant, scrape_batch,
  //     scrape_time, <metric_key>: <value>, ... }
  //
  // record_id = `${customerName}_${date}` (kept stable for idempotent
  // ON CONFLICT (record_id) DO UPDATE in 妙搭 DB).
  //
  // IMPORTANT — `record_date` source:
  //   `date` comes from the C360 metrics_list API response
  //   (`item.date.display_value`), NOT from `new Date()` or any local
  //   today/today-1 computation. This means whatever date C360 returns is
  //   what lands in 妙搭 — typically the latest available data date, which
  //   may lag a few days behind the wall clock if C360's data pipeline
  //   hasn't backfilled yet. If you see "missing yesterday's row", the
  //   issue is upstream in C360's data freshness, not here. Don't change
  //   this to `new Date()` — that would mis-attribute every row to the
  //   scrape day and break idempotent re-runs.
  //
  // Note on `total`: c360's `ai_credits_asset_usage` already represents the
  // per-day grand total. We expose it via the metric key AND copy it to the
  // top-level `total` field that the 妙搭 schema hardcodes.
  const customerName = meta.customerName || '';
  const accountId = meta.accountId || '';
  const viewId = meta.viewId || cfg.viewId || '';
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const scrapeBatch = now.replace(/[-: ]/g, '').slice(0, 12);
  return list.map((item) => {
    const date = item.date?.display_value;
    const row = {
      record_id: `${customerName}_${date}`,
      customer_name: customerName,
      account_id: accountId,
      view_source: viewId,
      record_date: date,
      data_source: 'C360',
      main_tenant: meta.mainTenant || '',
      scrape_batch: scrapeBatch,
      scrape_time: now,
    };
    for (const { key, syntheticZero } of METRIC_KEYS) {
      row[key] = syntheticZero ? 0 : (Number(item[key]?.value) || 0);
    }
    row.total = row.ai_credits_asset_usage || 0;
    return row;
  });
}

function total30d(rows) {
  // rows is now a list of plain objects (post-stage-A). Compute total from
  // the `total` field set by buildRows.
  return rows.reduce((s, r) => s + (Number(r.total) || 0), 0);
}

// --- miaoda DB push ------------------------------------------------------
//
// Each customer run writes ~30 daily rows to 妙搭 app `customer_ai_quota`
// via `lark-cli apps +db-execute` (single SQL per customer, batched VALUES).
// PK is `${customerName}_${date}` (built by buildRows as `record_id`).
// ON CONFLICT (record_id) DO UPDATE → idempotent re-runs.
//
// Configuration (`cfg.miaodaDb`):
//   { enabled, appId, env, schema, table,
//     columns: { 'ai_credits_asset_usage': 'fldXxxYyy', ... }   // optional
//   }
// If `columns` is omitted, the row keys themselves are used as 妙搭 column
// names (snake_case identifiers, which PG lowercases unless quoted).
//
// Implementation notes:
// - 妙搭 fld* column names are mixed-case identifiers; PG lowercases unquoted
//   identifiers, so we wrap every column reference in double quotes.
// - A 30-row INSERT can exceed macOS argv limit (~256 KB) when passed via
//   `--sql "<SQL>"`. Use `--file <relative-path>` with a temp file written
//   under os.tmpdir() (lark-cli requires --file to be relative to cwd, so
//   we spawn lark-cli with cwd=tmpdir).

const sqlEscape = (s) => String(s).replaceAll("'", "''");
const sqlIdent = (s) => `"${String(s).replaceAll('"', '""')}"`;

// Resolve the target 妙搭 column name for each metric key. The columns
// hardcoded into the SQL builder (record_id, customer_name, account_id,
// view_source, record_date, total) are excluded — passing them again here
// would either (a) collide with the hardcoded `total` column, or (b) be
// redundant since they're already added by the static part of the SQL.
// METRIC_KEYS entries marked `aliasedAs` are also excluded (e.g. the
// per-day `ai_credits_asset_usage` is stored in the hardcoded `total`
// column, so it must not be added a second time).
//
// IMPORTANT: HARDCODED_COLS MUST mirror the keys produced by buildRows()
// (the JS payload field set). If you add a new column here, you must:
//   1. Add the matching key to the row object in buildRows()
//   2. Add it to the SQL VALUES list in buildMiaodaUpsertSql()
//   3. Add it to the EXCLUDED update SET
//   4. ALTER TABLE the 妙搭 schema (DDL forbidden on online env — needs
//      editor re-publish)
// If you add a column to buildRows() without mirroring it here, this set
// will silently exclude it from the metric columns (and it will end up
// missing from INSERT). Conversely, if you add to HARDCODED_COLS but
// forget to populate the row key, this set won't help — that's why
// buildRows() must be the single source of truth.
const HARDCODED_COLS = new Set(['record_id', 'customer_name', 'account_id', 'view_source', 'record_date', 'total', 'data_source', 'main_tenant', 'scrape_batch', 'scrape_time']);

function resolveMiaodaColumns() {
  const overrides = cfg.miaodaDb?.columns || {};
  return METRIC_KEYS
    .filter((m) => !m.aliasedAs)
    .map((m) => ({
      metricKey: m.key,
      dbCol: overrides[m.key] || m.key,
      syntheticZero: m.syntheticZero,
    }))
    .filter(({ dbCol }) => !HARDCODED_COLS.has(dbCol));
}

// --- miaoda DB push (multi-customer batched) -----------------------------
//
// Stage C: single SQL with multi-customer VALUES, instead of one SQL per
// customer. runCommitWorker accumulates rows from many customers into a
// single batch and emits ONE INSERT statement covering all of them.
//
// inputs: `items` is an array of `{ name, accountId, rows: [...] }` — one
// entry per customer. All customers' rows are concatenated into a single
// VALUES list. `meta.batchSize` / `meta.dryRun` etc. are forwarded.

function buildMiaodaUpsertSql(items) {
  // Flatten all customers' rows. Each item must have `rows` (the daily rows
  // produced by buildRows); other item fields are ignored here.
  const allRows = [];
  for (const item of items) {
    if (!item.rows || !item.rows.length) continue;
    for (const r of item.rows) allRows.push(r);
  }
  if (!allRows.length) return null;

  const db = cfg.miaodaDb;
  const cols = resolveMiaodaColumns();
  const tableRef = db.schema
    ? `${sqlIdent(db.schema)}.${sqlIdent(db.table)}`
    : sqlIdent(db.table);

  // Schema discovered 2026-06-29, 列名重命名 2026-06-30:
  // 妙搭 customer_ai_quota user columns are: record_id (PK), customer_name,
  //   record_date, total, account_id, view_source, data_source, main_tenant,
  //   scrape_batch, scrape_time, synced_at, plus 13 中文产品名 metric columns
  //   (知识问答/智能纪要/飞书 aily 智能伙伴/妙搭/飞书 OpenClaw/飞书 aily 应用/
  //    飞书 aily 智能体/飞书 aPaaS/文档 AI 速览/多维表格 AI/飞书项目 AI/
  //    飞书 aily 专用额度/飞书 aily 专业版). We populate all of them.
  //   中文列名必须用 sqlIdent() 双引号包裹(PG 大小写敏感)。
  const dbColsList = [
    sqlIdent('record_id'),
    sqlIdent('customer_name'),
    sqlIdent('account_id'),
    sqlIdent('view_source'),
    sqlIdent('record_date'),
    sqlIdent('total'),
    ...cols.map(({ dbCol }) => sqlIdent(dbCol)),
    sqlIdent('data_source'),
    sqlIdent('main_tenant'),
    sqlIdent('scrape_batch'),
    sqlIdent('scrape_time'),
  ].join(', ');

  const valueRows = allRows.map((row) => {
    const parts = [
      `'${sqlEscape(row.record_id)}'`,
      `'${sqlEscape(row.customer_name)}'`,
      `'${sqlEscape(row.account_id)}'`,
      `'${sqlEscape(row.view_source || '')}'`,
      `'${sqlEscape(row.record_date)}'`,
      String(Number(row.total) || 0),
      ...cols.map(({ metricKey }) => String(Number(row[metricKey]) || 0)),
      `'${sqlEscape(row.data_source || 'C360')}'`,
      `'${sqlEscape(row.main_tenant || '')}'`,
      `'${sqlEscape(row.scrape_batch || '')}'`,
      `'${sqlEscape(row.scrape_time || '')}'`,
    ];
    return `(${parts.join(',')})`;
  });

  const updateSets = [
    `${sqlIdent('customer_name')} = EXCLUDED.${sqlIdent('customer_name')}`,
    `${sqlIdent('account_id')}    = EXCLUDED.${sqlIdent('account_id')}`,
    `${sqlIdent('view_source')}   = EXCLUDED.${sqlIdent('view_source')}`,
    `${sqlIdent('record_date')}   = EXCLUDED.${sqlIdent('record_date')}`,
    `${sqlIdent('total')}         = EXCLUDED.${sqlIdent('total')}`,
    ...cols.map(({ dbCol }) => `${sqlIdent(dbCol)} = EXCLUDED.${sqlIdent(dbCol)}`),
    `${sqlIdent('data_source')} = EXCLUDED.${sqlIdent('data_source')}`,
    `${sqlIdent('main_tenant')}  = EXCLUDED.${sqlIdent('main_tenant')}`,
    `${sqlIdent('scrape_batch')} = EXCLUDED.${sqlIdent('scrape_batch')}`,
    `${sqlIdent('scrape_time')}  = EXCLUDED.${sqlIdent('scrape_time')}`,
    `${sqlIdent('synced_at')}    = now()`,
  ].join(', ');

  return [
    `INSERT INTO ${tableRef} (${dbColsList})`,
    `VALUES ${valueRows.join(', ')}`,
    `ON CONFLICT (${sqlIdent('record_id')}) DO UPDATE SET ${updateSets}`,
    `RETURNING ${sqlIdent('record_id')};`,
  ].join('\n');
}

async function pushBatchToMiaodaDb(items, meta = {}) {
  const db = cfg.miaodaDb;
  if (!db?.enabled || !db?.appId || !db?.table) {
    return { pushed: 0, skipped: true, reason: 'miaodaDb not configured' };
  }
  if (!items.length) {
    return { pushed: 0, skipped: true, reason: 'no items' };
  }

  const sql = buildMiaodaUpsertSql(items);
  if (!sql) {
    return { pushed: 0, skipped: true, reason: 'no rows in batch' };
  }

  const totalRows = items.reduce((s, i) => s + (i.rows?.length || 0), 0);
  const customerNames = items.map((i) => i.name).join(', ');

  if (args.dryRun) {
    log(`MIAODA-DRY batch: customers=${items.length} rows=${totalRows} sql_chars=${sql.length} (${customerNames.slice(0, 80)})`);
    // P0 diagnostic 2026-07-01: also dump the full SQL so we can compare
    // what c360_collect.mjs generates vs what works via direct lark-cli.
    // Will be reverted after we find the silent-failure root cause.
    log(`MIAODA-DRY SQL: ${sql}`);
    return { pushed: 0, dryRun: true, records: totalRows, customers: items.length };
  }

  // P0 diagnostic 2026-07-01: dump SQL even in real-run mode so we can
  // inspect what c360_collect.mjs is sending to lark-cli vs the working
  // hand-crafted SQL. Will be reverted after we find the silent-failure
  // root cause.
  log(`MIAODA-RUN SQL_HEAD: ${sql.slice(0, 400)} ... [${sql.length} chars total]`);
  // Persist the full SQL to a stable path for side-by-side testing.
  try { await writeFile('/tmp/c360_real_sql.sql', sql, 'utf8'); } catch { /* ignore */ }

  // Write SQL to a per-call temp file under os.tmpdir() (P0: avoid cwd
  // contention). Each call gets a fresh randomUUID-based directory; lark-cli
  // resolves `--file` relative to cwd, so we spawn from the temp dir to
  // keep the relative path valid and isolated.
  const tmpDirAbs = await mkdtemp(join(tmpdir(), `miaoda-${randomUUID()}-`));
  const relPath = './upsert.sql';
  const sqlAbsPath = join(tmpDirAbs, 'upsert.sql');
  try {
    await writeFile(sqlAbsPath, sql, 'utf8');
  } catch (err) {
    log(`MIAODA-FAIL batch(${items.length}): temp file write failed — ${err.message}`);
    await rm(tmpDirAbs, { recursive: true, force: true });
    return { pushed: 0, error: err.message };
  }

  const larkArgs = ['apps', '+db-execute',
    '--app-id', db.appId,
    '--environment', db.env || 'online',
    '--file', relPath,
    '--yes',
  ];

  // P0 fix 2026-07-01: retry up to 3 times on lark-cli silent-success
  // (lark-cli 1.0.56 sometimes returns ok=true + sql_type=INSERT +
  // affected_rows=N without actually executing against 妙搭 PG). Retry
  // gives us resilience against transient flakes; an explicit
  // affected_rows=0 check flags the "lark-cli consistently ignores this
  // batch" case so the operator gets a MIAODA-FAIL alarm.
  //
  // Even more importantly: lark-cli 1.0.56 also returns the EXPECTED row
  // count as affected_rows (not the actual PG-touched count) when it
  // silently drops the batch. So the affected_rows=0 assertion isn't
  // enough — we also need to verify against the 妙搭 DB itself by
  // snapshotting MAX(synced_at) before/after the batch.
  const MAX_ATTEMPTS = 3;
  let wr = null;
  let lastError = null;
  let lastBody = null;
  let affected = 0;
  let success = false;

  // Snapshot MAX(synced_at) from 妙搭 before the batch so we can detect
  // "lark-cli said OK but didn't actually run" via a no-op diff.
  let beforeMax = null;
  try {
    const r = await lark(['apps', '+db-execute',
      '--app-id', db.appId, '--environment', db.env || 'online',
      '--sql', `SELECT MAX(synced_at) AS m FROM ${db.schema ? `"${db.schema}".` : ''}"${db.table}";`,
      '--yes',
    ], { allowFail: true });
    if (r.status === 0) {
      const body = JSON.parse(r.stdout);
      const m = body?.data?.results?.[0]?.data;
      if (m) {
        try { beforeMax = JSON.parse(m)[0]?.m; } catch { /* ignore */ }
      }
    }
  } catch { /* best-effort */ }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      wr = await lark(larkArgs, { allowFail: true, cwd: tmpDirAbs });
    } catch (err) {
      lastError = `spawn error: ${err.message}`;
      log(`MIAODA-FAIL batch(${items.length}) attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      await rm(tmpDirAbs, { recursive: true, force: true });
      return { pushed: 0, error: lastError };
    }

    if (wr.status !== 0) {
      const stderrSnippet = (wr.stderr || '').toString().slice(0, 800).replace(/\n+/g, ' ');
      lastError = `lark-cli exit ${wr.status}: ${stderrSnippet}`;
      log(`MIAODA-FAIL batch(${items.length}) attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);
      // Non-zero exit is unlikely to recover via retry (auth/cwd issues
      // need a human), bail early.
      await rm(tmpDirAbs, { recursive: true, force: true });
      return { pushed: 0, error: lastError, stderr: stderrSnippet };
    }

    let body;
    try { body = JSON.parse(wr.stdout.toString()); }
    catch { body = {}; }
    lastBody = body;

    // P0 diagnostic 2026-07-01: dump full wr.stdout to surface any silent
    // failure mode where lark-cli says ok but no rows are touched. Will be
    // reverted after we confirm the retry+assert fix.
    log(`MIAODA-RUN LARK_STDOUT[attempt=${attempt}]: ${wr.stdout.toString().slice(0, 600)}`);

    if (!body.ok) {
      lastError = body?.error?.message || 'unknown error';
      log(`MIAODA-FAIL batch(${items.length}) attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);
      // Server-side errors (schema mismatch, permission) won't recover
      // via retry. Bail.
      await rm(tmpDirAbs, { recursive: true, force: true });
      return { pushed: 0, error: lastError };
    }

    const results = body?.data?.results || [];
    const result0 = results[0] || {};
    affected = Number(result0.affected_rows ?? 0);
    const sqlType = result0.sql_type || '?';

    // P0 assertion 1 (DISABLED 2026-07-02): affected_rows=0 is NOT a
    // reliable failure signal — lark-cli 1.0.63 returns affected_rows=0
    // for legitimate ON CONFLICT UPDATE batches (the rowcount PG returns
    // is the actual number of rows physically inserted, not touched).
    // We rely entirely on assertion 2 (MAX(synced_at) advance) below.
    //
    // Original 1.0.56 silent-success logic retained commented for history.
    // if (totalRows > 0 && affected === 0) {
    //   lastError = `lark-cli reported ok=true + affected_rows=0 for ${totalRows}-row batch (sql_type=${sqlType}) — likely silent-success, retrying`;
    //   log(`MIAODA-SUSPECT batch(${items.length}) attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);
    //   if (attempt < MAX_ATTEMPTS) {
    //     await new Promise((r) => setTimeout(r, 2000));
    //     continue;
    //   }
    //   await rm(tmpDirAbs, { recursive: true, force: true });
    //   return { pushed: 0, error: lastError, body };
    // }

    // P0 assertion 2: verify against 妙搭 DB directly. lark-cli
    // 1.0.56 also returns the EXPECTED row count when it silently drops
    // the batch, so affected_rows=145 doesn't mean 145 rows were
    // touched. Snapshot MAX(synced_at) again; if it didn't advance past
    // beforeMax, the batch was silently dropped.
    if (beforeMax !== null) {
      // Give 妙搭 PG a moment to commit + replica visibility.
      await new Promise((r) => setTimeout(r, 500));
      try {
        const r2 = await lark(['apps', '+db-execute',
          '--app-id', db.appId, '--environment', db.env || 'online',
          '--sql', `SELECT MAX(synced_at) AS m FROM ${db.schema ? `"${db.schema}".` : ''}"${db.table}";`,
          '--yes',
        ], { allowFail: true });
        // P0 diagnostic 2026-07-01: dump full assertion-2 state.
        let body2Debug = null;
        let afterMax = null;
        if (r2.status === 0) {
          try { body2Debug = JSON.parse(r2.stdout); } catch { body2Debug = null; }
          const m2 = body2Debug?.data?.results?.[0]?.data;
          if (m2) {
            try { afterMax = JSON.parse(m2)[0]?.m; } catch { /* ignore */ }
          }
        }
        log(`MIAODA-ASSERT2 beforeMax=${beforeMax} afterMax=${afterMax} r2.status=${r2.status} body2_ok=${body2Debug?.ok} body2_err=${body2Debug?.data?.error_code || '-'}`);
        if (r2.status === 0) {
          const body2 = body2Debug;
          const m2 = body2?.data?.results?.[0]?.data;
          if (m2) {
            if (afterMax && beforeMax && new Date(afterMax).getTime() <= new Date(beforeMax).getTime()) {
              lastError = `synced_at did not advance (before=${beforeMax} after=${afterMax}) despite lark-cli saying ok+affected_rows=${affected} — silent drop, retrying`;
              log(`MIAODA-SUSPECT batch(${items.length}) attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);
              if (attempt < MAX_ATTEMPTS) {
                await new Promise((r) => setTimeout(r, 2000));
                continue;
              }
              await rm(tmpDirAbs, { recursive: true, force: true });
              return { pushed: 0, error: lastError, body, beforeMax, afterMax };
            }
          }
        }
      } catch { /* best-effort verification */ }
    }

    // Success path.
    success = true;
    break;
  }

  await rm(tmpDirAbs, { recursive: true, force: true });

  if (!success) {
    log(`MIAODA-FAIL batch(${items.length}): exhausted ${MAX_ATTEMPTS} retries — last error: ${lastError}`);
    return { pushed: 0, error: lastError, body: lastBody };
  }

  log(`MIAODA-OK batch(${items.length}): upserted=${affected} of ${totalRows} rows (${customerNames.slice(0, 80)})`);
  return { pushed: affected, customers: items.length, rows: totalRows };
}

// Single-customer wrapper used when batchSize=1 or for failures. Kept for
// backward compatibility with any future caller that wants per-customer
// SQL granularity. Not used by runCommitWorker at batchSize >= 1.
async function pushToMiaodaDb(rows, meta = {}) {
  const item = {
    name: meta.customerName || '?',
    accountId: meta.accountId,
    rows,
  };
  const result = await pushBatchToMiaodaDb([item], meta);
  // Re-shape result to single-customer shape for log compatibility.
  if (result.dryRun) {
    log(`MIAODA-DRY ${item.name}: app=${cfg.miaodaDb?.appId} env=${cfg.miaodaDb?.env} rows=${rows.length}`);
  }
  return result;
}

async function processCustomer(targetId, name, accountId) {
  log(`--- ${name} (${accountId})`);
  const snap = await phase3_fetchSnapshot(targetId, accountId);
  if (!snap.mainTenant) {
    log(`SKIP ${name}: no tenant found on detail page`);
    return { name, status: 'skip', reason: 'no tenant' };
  }
  let payload;
  try {
    payload = await phase4_fetchDailyMetrics(targetId, accountId, snap.mainTenant);
  } catch (err) {
    log(`FAIL ${name}: ${err.message}`);
    return { name, status: 'fail', reason: err.message };
  }
  const rows = buildRows(payload.data.list, {
    customerName: name,
    accountId,
    mainTenant: snap.mainTenant,
    viewId: cfg.viewId,
  });
  const total30 = Math.round(total30d(rows));
  if (args.dryRun) {
    log(`DRY ${name}: mainTenant=${snap.mainTenant}, days=${rows.length}, total30d=${total30} (no write)`);
    // Even in dry-run, exercise the 妙搭 SQL builder so we surface obvious bugs.
    let miaodaResult = null;
    if (cfg.miaodaDb?.enabled) {
      try {
        miaodaResult = await pushToMiaodaDb(rows, { customerName: name, accountId, mainTenant: snap.mainTenant });
      } catch (err) {
        log(`MIAODA-ERR ${name}: ${err.message}`);
        miaodaResult = { pushed: 0, error: err.message };
      }
    }
    return { name, accountId, mainTenant: snap.mainTenant, days: rows.length, total30, dryRun: true, miaoda: miaodaResult };
  }

  // Push to 妙搭 DB (single sink; Base is no longer written)
  let miaodaResult = null;
  if (cfg.miaodaDb?.enabled) {
    try {
      miaodaResult = await pushToMiaodaDb(rows, { customerName: name, accountId, mainTenant: snap.mainTenant });
    } catch (err) {
      log(`MIAODA-ERR ${name}: ${err.message}`);
      miaodaResult = { pushed: 0, error: err.message };
    }
  }

  log(`OK ${name}: mainTenant=${snap.mainTenant}, days=${rows.length}, total30d=${total30}${miaodaResult ? `, miaoda=${miaodaResult.pushed || 0}` : ''}`);
  return { name, accountId, mainTenant: snap.mainTenant, days: rows.length, total30, miaoda: miaodaResult };
}

// --- Stage B: parallel scrape workers + commit queue ---------------------
//
// Two-stage pipeline:
//   Phase A (parallel): N worker tabs each run phase3+phase4 on a disjoint
//     slice of customers, push results into a shared AsyncQueue.
//   Phase B (serial): a single commit worker drains the queue, calling
//     pushToMiaodaDb for each customer. (Stage C will batch multiple
//     customers per SQL.)
//
// Tab health: each worker pings its tab (`eval 1+1`) before every customer.
// On failure it closes + reopens the tab and continues with the remaining
// customers on its slice. Concurrency is preserved as long as at least one
// tab stays healthy.

// Bounded async queue with producer-counted close semantics.
// Producers call `markProducer()` once at start and `producerDone()` when
// they finish. After all producers have called `producerDone()`, the queue
// auto-closes and `take()` resolves with `null` (sentinel end-of-stream).
//
// Without this, runScrapeWorker finishing its slice leaves runCommitWorker
// blocked on `take()`, and `Promise.allSettled([...workers, commitTask])`
// never returns → main flow hangs after [N/N] OK.
//
// Implementation: producerDone() decrements a counter; when it hits 0,
// close() is invoked exactly once.
class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
    this.producersRemaining = 0;
  }
  push(item) {
    if (this.closed) throw new Error('queue closed');
    if (this.waiters.length) {
      const w = this.waiters.shift();
      w.resolve(item);
    } else {
      this.items.push(item);
    }
  }
  take() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push({ resolve }));
  }
  addProducers(n) {
    this.producersRemaining += n;
  }
  producerDone() {
    this.producersRemaining -= 1;
    if (this.producersRemaining <= 0 && !this.closed) this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      const w = this.waiters.shift();
      w.resolve(null);
    }
  }
  get size() { return this.items.length; }
}

// Distribute `scope` across N buckets using accountId hash (or name when
// accountId is missing). Sticky hashing means a re-run with the same scope
// and N yields the same partition — useful for incremental retry.
function bucketize(scope, n) {
  const buckets = Array.from({ length: n }, () => []);
  if (n <= 1) return [scope.slice()];
  for (const c of scope) {
    const key = c.accountId || c.name || '';
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(h) % n;
    buckets[idx].push(c);
  }
  return buckets;
}

// Open N c360 tabs so each worker has its own page context. Tab-local state
// (window.__c360_captured, XHR interceptor monkey-patch) is per-realm and
// does not leak between workers. All tabs share the Edge instance's OAuth
// session.
async function openWorkerTabs(n) {
  const tabs = [];
  for (let i = 0; i < n; i++) {
    const r = await cdp(['new', `https://c360.larkoffice.com/pc/account/list?viewId=${cfg.viewId || 'user-67'}`], { allowFail: true });
    if (r.status !== 0 || !r.stdout.trim()) {
      log(`WARN: failed to open worker tab #${i}: ${(r.stderr || r.stdout).slice(0, 200)}`);
      continue;
    }
    try {
      const t = JSON.parse(r.stdout);
      tabs.push(t.id);
      log(`worker tab #${i}: ${t.id} (${t.url || ''})`);
    } catch (err) {
      log(`WARN: bad JSON from cdp new for worker tab #${i}: ${err.message}`);
    }
  }
  if (!tabs.length) throw new Error('openWorkerTabs: no tabs opened');
  return tabs;
}

// Ping a tab; returns true on success, false if the tab is dead/unreachable.
// cdp.mjs eval outputs `{"type":"number","value:2}` — we parse the wrapper
// rather than doing a string compare.
async function pingTab(tabId) {
  const r = await cdp(['eval', tabId, '1+1'], { allowFail: true });
  if (r.status !== 0) return false;
  try {
    const parsed = JSON.parse((r.stdout || '').trim());
    return parsed?.type === 'number' && parsed.value === 2;
  } catch {
    return false;
  }
}

// Try to close the dead tab (best effort) then open a fresh one. Returns
// the new tabId, or null on total failure.
async function reopenTab(oldTabId) {
  if (oldTabId) {
    await cdp(['close', oldTabId], { allowFail: true });
  }
  const r = await cdp(['new', `https://c360.larkoffice.com/pc/account/list?viewId=${cfg.viewId || 'user-67'}`], { allowFail: true });
  if (r.status !== 0 || !r.stdout.trim()) {
    log(`WARN: reopenTab failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
    return null;
  }
  try {
    const t = JSON.parse(r.stdout);
    log(`reopened worker tab: ${t.id} (was ${oldTabId})`);
    return t.id;
  } catch {
    return null;
  }
}

// One scrape worker: iterates its slice, runs phase3+phase4 on its own tab,
// pushes results into the queue. Tab health is checked per customer; a dead
// tab is replaced in place. Concurrency is preserved as long as reopenTab
// eventually succeeds.
async function runScrapeWorker(tabId, slice, queue) {
  let currentTab = tabId;
  try {
    for (const c of slice) {
      if (!currentTab) {
        currentTab = await reopenTab(null);
        if (!currentTab) {
          log(`FAIL ${c.name}: no healthy tab available`);
          queue.push({ name: c.name, accountId: c.accountId, status: 'fail', reason: 'no tab' });
          continue;
        }
      }
      if (!(await pingTab(currentTab))) {
        log(`WARN worker tab ${currentTab} unhealthy before ${c.name}; reopening`);
        currentTab = await reopenTab(currentTab);
        if (!currentTab) {
          queue.push({ name: c.name, accountId: c.accountId, status: 'fail', reason: 'tab reopen failed' });
          continue;
        }
      }
      try {
        // Inline the fetch portion of processCustomer (phase3+phase4+buildRows)
        // so we don't trigger the per-customer commit here — the commit worker
        // owns the miaoda DB write.
        const snap = await phase3_fetchSnapshot(currentTab, c.accountId);
        if (!snap.mainTenant) {
          log(`SKIP ${c.name}: no tenant`);
          queue.push({ name: c.name, accountId: c.accountId, status: 'skip', reason: 'no tenant' });
          continue;
        }
        const payload = await phase4_fetchDailyMetrics(currentTab, c.accountId, snap.mainTenant);
        const rows = buildRows(payload.data.list, {
          customerName: c.name, accountId: c.accountId,
          mainTenant: snap.mainTenant, viewId: cfg.viewId,
        });
        queue.push({
          name: c.name, accountId: c.accountId,
          mainTenant: snap.mainTenant,
          rows,
          days: rows.length,
          total30: Math.round(total30d(rows)),
          status: 'ok',
        });
      } catch (err) {
        log(`FAIL ${c.name}: ${err.message}`);
        queue.push({ name: c.name, accountId: c.accountId, status: 'fail', reason: err.message });
      }
    }
  } finally {
    // Signal this worker is done producing items. When all producers have
    // called producerDone(), the queue auto-closes and runCommitWorker sees
    // the null sentinel on its next take(). Without this, the queue would
    // block forever once all workers finish, hanging Promise.allSettled.
    queue.producerDone();
  }
}

// Single-thread commit worker: drains the queue, accumulates customers
// into a batch of size `batchSize`, then calls pushBatchToMiaodaDb once
// per batch. Tail (< batchSize) is flushed at queue close.
//
// The pre-batch per-customer progress events (customerStart / customerEnd)
// still fire so the operator sees each customer finishing individually;
// batched SQL execution just merges the DB write into a single round-trip.
async function runCommitWorker(queue, opts = {}) {
  const batchSize = Math.max(1, Math.min(100, Number(opts.batchSize ?? 10)));
  const results = [];
  let batch = [];   // array of { name, accountId, rows, ... }

  async function flushBatch() {
    if (!batch.length) return;
    const items = batch;
    batch = [];
    let batchResult = null;
    if (cfg.miaodaDb?.enabled) {
      try {
        batchResult = await pushBatchToMiaodaDb(items);
      } catch (err) {
        log(`MIAODA-ERR batch(${items.length}): ${err.message}`);
        batchResult = { pushed: 0, error: err.message };
      }
    }
    // Per-item progress + result, so the final markdown table still shows
    // one row per customer. Re-call customerStart before each customerEnd
    // so the progress line shows the right name (otherwise the first
    // customerEnd clears curCustomer and the rest print as empty name).
    for (const it of items) {
      const dur = 0;  // batched timing is not per-customer; use 0 to indicate batched
      const total30 = it.total30;
      progress.customerStart(it.name, it.accountId);
      progress.customerEnd({
        status: 'ok',
        days: it.days ?? '-',
        newN: '-',
        skipped: '-',
        total30d: total30 ?? '-',
        ingest: it.rows?.length ?? '-',
        durMs: dur,
      });
      results.push({
        name: it.name, accountId: it.accountId,
        mainTenant: it.mainTenant, days: it.days, total30,
        miaoda: { pushed: it.rows?.length || 0, batched: true, batchError: batchResult?.error },
      });
    }
  }

  while (true) {
    const item = await queue.take();
    if (item == null) break;
    if (item.status !== 'ok') {
      results.push(item);
      continue;
    }
    progress.customerStart(item.name, item.accountId);
    progress.tick('queued', item.name);
    batch.push(item);
    if (batch.length >= batchSize) {
      await flushBatch();
    }
  }
  // Flush tail (< batchSize).
  await flushBatch();
  return results;
}

// --- PID lock (P0: prevent launchd overlap or accidental double-runs) ---
//
// launchd runs this script at 00:30 every day (see launchd/
// com.claude.c360-ai-quota.plist). If a previous run is still in progress
// (e.g. a slow full scrape of 270 customers), a new instance would race
// against it for the same customer table rows, the same Base records, and
// the same 妙搭 DB rows.
//
// We use an atomic O_EXCL open on a lock file to ensure only one instance
// proceeds; any further instance exits cleanly so launchd does not treat
// the overlap as a launch failure.
const LOCK_PATH = env.C360_LOCK_FILE || '/tmp/c360-ai-quota.lock';
let _lockFh = null;
async function acquirePidLock() {
  try {
    _lockFh = await openFs(LOCK_PATH, 'wx');
    await _lockFh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Read the existing PID to print a useful diagnostic.
      let prevPid = '<unknown>';
      let prevTime = '<unknown>';
      try {
        const txt = await readFile(LOCK_PATH, 'utf8');
        const [p, t] = txt.split('\n');
        if (p) prevPid = p.trim();
        if (t) prevTime = t.trim();
      } catch { /* ignore */ }
      // Stale-lock detection (P0 fix 2026-06-30): a previous instance may have
      // been SIGKILLed (launchd Background reclaim, battery sleep, system
      // reboot) without unlinking the lock file. Detect via (a) liveness of
      // the recorded PID (`process.kill(pid, 0)` is POSIX "is alive" probe,
      // no signal sent) AND (b) lock age. Both guards needed: PID alone can
      // be reused by the kernel; age alone can flag a still-running scrape.
      let prevAlive = false;
      if (prevPid !== '<unknown>' && /^\d+$/.test(prevPid)) {
        try { process.kill(Number(prevPid), 0); prevAlive = true; } catch { prevAlive = false; }
      }
      let lockAgeMs = -1;
      if (prevTime !== '<unknown>' && !Number.isNaN(Date.parse(prevTime))) {
        lockAgeMs = Date.now() - Date.parse(prevTime);
      }
      const stale = (!prevAlive && lockAgeMs > 60_000) || lockAgeMs > 4 * 3600_000;
      if (stale) {
        log(`removing stale lock (pid=${prevPid} alive=${prevAlive} age=${Math.round(lockAgeMs / 1000)}s)`);
        try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
        // Retry once on the now-free path.
        try {
          _lockFh = await openFs(LOCK_PATH, 'wx');
          await _lockFh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
          return;  // success — fall through to the post-lock setup below
        } catch (err2) {
          log(`stale-lock retry failed: ${err2.message}`);
          throw err2;
        }
      }
      log(`another c360_collect instance is already running (pid=${prevPid} alive=${prevAlive} age=${lockAgeMs >= 0 ? Math.round(lockAgeMs / 1000) + 's' : '?'}, started=${prevTime}).`);
      log(`if this is wrong, remove ${LOCK_PATH} and re-run.`);
      exit(0);
    }
    throw err;
  }
  // Best-effort cleanup on exit. We unlink unconditionally on normal exit
  // and on SIGINT/SIGTERM; a hard kill will leave the lock behind
  // (intentional, so the operator notices via the diagnostic above).
  let _released = false;
  const release = () => {
    if (_released) return;
    _released = true;
    try { _lockFh?.close(); } catch { /* ignore */ }
    try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
    _lockFh = null;
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); exit(130); });
  }
}

// --- main ----------------------------------------------------------------

const args = parseArgs();
// Wire up --log-file mirroring now that args is parsed. We use an append
// stream so re-runs append to the same file (bash wrapper expects this).
if (args.logFile) {
  try {
    _logFileStream = createWriteStream(args.logFile, { flags: 'a' });
    _logFileStream.on('error', () => { _logFileStream = null; });
  } catch (err) {
    log(`failed to open log-file ${args.logFile}: ${err.message} — continuing with stderr only`);
  }
}
await acquirePidLock();
const cfgPath = args.config || env.C360_CONFIG || './c360.config.json';
let cfg;
try {
  cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
} catch (err) {
  log(`failed to read config ${cfgPath}: ${err.message}`);
  exit(1);
}
if (args.debugPort) env.CDP_PORT = String(args.debugPort);
else if (cfg.cdpPort) env.CDP_PORT = String(cfg.cdpPort);

const t0 = Date.now();
log(`# c360_collect — ${new Date().toISOString()}`);
log(`config: ${cfgPath} | lark-cli: ${LARK_CLI} | CDP_PORT: ${env.CDP_PORT}`);

// progress reporter (TTY-aware, falls back to plain log when redirected)
const progress = createProgress({ total: 0, label: 'C360 AI 用量' });
progress.begin();
progress.tick('auth');

await phase1_ensureAuth();
const { targetId } = await phase0_ensureEdge();
progress.tick('customer list');
const customers = await phase2_fetchCustomers(targetId);
log(`found ${customers.length} customers in view ${cfg.viewId}`);
// phase2b 在 view 客户列表上叠加妙搭 customer_assignments 表的客户：
// view 已有的不重搜（默认 excludeIfC365ViewHas=true），其余逐个调
// phase2c_searchC360ByName 解析；搜不到的发 WARN + 累计 notFoundNames，
// 最终输出 1 行 "scope: N customers (M from C360 view + K from Miaoda)"。
const customersWithMiaoda = await phase2b_resolveMiaodaCustomers(targetId, customers);
progress.tick('scope');

let scope;
if (args.customer) {
  // 先在 view ∪ Miaoda 合并列表里精确名匹配
  scope = customersWithMiaoda.filter((c) => c.name === args.customer);
  if (!scope.length) {
    // view 里没有；调 phase2c 全局搜索兜底（前端 CDP 验证有效）
    log(`--customer "${args.customer}" not in view ${cfg.viewId} nor in Miaoda resolution; trying C360 global search...`);
    let hits;
    try { hits = await phase2c_searchC360ByName(targetId, args.customer); }
    catch (err) { log(`--customer search threw: ${err.message}`); hits = []; }
    if (hits.length === 1) {
      log(`C360 search resolved "${args.customer}" → ${hits[0].name} (${hits[0].accountId})`);
      scope = hits;
    } else if (hits.length > 1) {
      log(`NOTFOUND --customer "${args.customer}" ambiguous: C360 search returned ${hits.length} exact-name hits:`);
      for (const h of hits) log(`  - ${h.name} (${h.accountId})`);
      log(`please re-run with an exact name from the list above.`);
      exit(1);
    } else {
      log(`NOTFOUND --customer "${args.customer}" not in C360 (view ${cfg.viewId} + global search returned 0 exact matches)`);
      exit(1);
    }
  }
} else if (args.testMode) {
  if (!cfg.testCustomers?.length) {
    log('--test-mode requires cfg.testCustomers in config');
    exit(2);
  }
  scope = customersWithMiaoda.filter((c) => cfg.testCustomers.includes(c.name));
  if (!scope.length) {
    log(`no customers from testCustomers found in view ${cfg.viewId} (+ Miaoda)`);
    exit(1);
  }
  log(`--test-mode: ${scope.length} customers from cfg.testCustomers`);
} else {
  scope = customersWithMiaoda;
}

if (args.customer && !scope.length) {
  log(`no customer matches --customer "${args.customer}"`);
  exit(1);
}

// Update progress total BEFORE the customer loop so the very first
// `customerEnd` call renders the correct "[N/M]" denominator.
progress.setTotal(scope.length);
progress.tick('customers', `${scope.length} to process`);
progress.phaseEnd();

// Defensive dedup: even if C360 returns the same accountId in two pages
// during one run, never process the same customer twice in one run.
const _seenAcc = new Set();
const _seenName = new Set();
const dedupedScope = [];
for (const c of scope) {
  const _k = c.accountId || c.name;
  if (!_k) continue;
  if (c.accountId && _seenAcc.has(c.accountId)) continue;
  if (!c.accountId && _seenName.has(c.name)) continue;
  if (c.accountId) _seenAcc.add(c.accountId);
  if (!c.accountId) _seenName.add(c.name);
  dedupedScope.push(c);
}

// Stage B pipeline: N scrape workers + 1 commit worker. The single tab
// from phase0_ensureEdge is reused as worker #0; remaining N-1 tabs are
// opened fresh by openWorkerTabs.
const concurrency = Math.max(1, Math.min(8, Number(args.concurrency ?? 2)));
log(`stage-B pipeline: concurrency=${concurrency}, scope=${dedupedScope.length}`);
progress.tick('pipeline', `concurrency=${concurrency}`);

const extraTabs = concurrency > 1 ? await openWorkerTabs(concurrency - 1) : [];
const workerTabs = [targetId, ...extraTabs].slice(0, concurrency);
const buckets = bucketize(dedupedScope, workerTabs.length);
const queue = new AsyncQueue();
queue.addProducers(buckets.length);  // workerTasks each call producerDone() on exit
const workerTasks = buckets.map((slice, i) => runScrapeWorker(workerTabs[i], slice, queue));
const commitTask = runCommitWorker(queue, { batchSize: args.batchSize });

const settled = await Promise.allSettled([...workerTasks, commitTask]);
// Surface any worker exception that wasn't caught inside the worker loop
// (uncaught throws would otherwise be swallowed by allSettled).
for (const [i, s] of settled.entries()) {
  if (s.status === 'rejected') {
    log(`WARN task #${i} rejected: ${s.reason?.message || s.reason}`);
  }
}
const results = settled[settled.length - 1].status === 'fulfilled'
  ? settled[settled.length - 1].value
  : [];
progress.phaseEnd();

const dt = ((Date.now() - t0) / 1000).toFixed(1);
// Final report
// Collect summary lines (stderr) and markdown table lines (stdout) so
// progress.finish can clear the in-progress TTY line first, then log the
// summary to stderr and the markdown table to stdout.
const summaryLines = [];
const pushSum = (s) => summaryLines.push(s);
const stdoutLines = [];
const pushOut = (s) => stdoutLines.push(s);

pushSum('');
pushSum(`# C360 AI 额度抓取完成 (${dt}s)`);
pushSum(`- 客户总数：${scope.length}`);
pushSum(`- 成功：${results.filter((r) => r.status !== 'fail' && r.status !== 'skip').length}`);
pushSum(`- 失败：${results.filter((r) => r.status === 'fail').length}`);
pushSum(`- 跳过：${results.filter((r) => r.status === 'skip').length}`);
pushSum('');
// Markdown table (per original SKILL.md line 596-606 format) goes to stdout.
const showIngest = cfg.miaodaDb?.enabled;
if (showIngest) {
  pushOut('| 客户 | 主租户 | 抓取天数 | 新增写入 | 妙搭推送 | 近30天总消耗 |');
  pushOut('|---|---|---:|---:|---:|---:|');
} else {
  pushOut('| 客户 | 主租户 | 抓取天数 | 新增写入 | 近30天总消耗 |');
  pushOut('|---|---|---:|---:|---:|');
}
for (const r of results) {
  if (r.status === 'fail' || r.status === 'skip') {
    if (showIngest) {
      pushOut(`| ${r.name} | — | — | — | — | ${r.status.toUpperCase()}: ${r.reason} |`);
    } else {
      pushOut(`| ${r.name} | — | — | — | ${r.status.toUpperCase()}: ${r.reason} |`);
    }
  } else {
    const miaodaPushed = r.miaoda?.pushed ?? (r.miaoda?.dryRun ? 'DRY' : '—');
    // Base 详情表不再写入；"新增写入" 列显示 "—" 占位。
    const baseWritten = '—';
    if (showIngest) {
      pushOut(`| ${r.name} | \`${r.mainTenant}\` | ${r.days} | ${baseWritten} | ${miaodaPushed} | ${r.total30.toLocaleString('en-US')} |`);
    } else {
      pushOut(`| ${r.name} | \`${r.mainTenant}\` | ${r.days} | ${baseWritten} | ${r.total30.toLocaleString('en-US')} |`);
    }
  }
}

// 妙搭 DB summary (if enabled)
if (showIngest) {
  const miaodaResults = results.filter((r) => r.miaoda);
  const miaodaPushed = miaodaResults.reduce((s, r) => s + (r.miaoda?.pushed || 0), 0);
  const miaodaErrors = miaodaResults.filter((r) => r.miaoda?.error).length;
  pushSum('');
  pushSum(`# 妙搭 DB 推送汇总`);
  pushSum(`- 推送客户数：${miaodaResults.length}`);
  pushSum(`- 推送成功行数：${miaodaPushed}`);
  pushSum(`- 推送失败：${miaodaErrors}`);
}

// Final flush:
// - TTY: progress.finish clears the in-progress line first.
// - non-TTY: progress.finish still emits a leading blank line via summaryLines.
// We then print markdown table to stdout (unchanged behavior).
progress.finish(summaryLines);
for (const line of stdoutLines) stdout.write(line + '\n');
