#!/usr/bin/env node
// One-off driver: 抓取单个已知 C360 客户近 30 天 AI 用量, upsert 到妙搭
// app `customer_ai_quota` 表 (事实源).
//
// 重要: 2026-06-29 决策后, 妙搭 DB 是事实源, 飞书 Base V2 不再被读/写.
// 所以本 driver 只写妙搭, 不写 Base.
//
// 为什么需要这个: c360_collect.mjs 锁定只抓 user-67 视图, 但有些已知客户
// 不在该视图里 (例如易威行). 全量 cron 也覆盖不到. 这个 driver 跳过 phase2,
// 直接拿 known accountId + main tenant 跑 phase3 + phase4 + push.
//
// 当前抓取目标: 深圳易威行贸易有限公司
//   accountId = 001TL0000088AVRYA2
//   mainTenant = F8M23ARGPBJ
//
// 用法:  node scripts/c360_oneoff_ywx.mjs
// 2026-06-30 created for the 易威行 bug.

import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { stderr, exit } from 'node:process';

const execFile = promisify(execFileCb);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP = join(__dirname, 'cdp.mjs');

const LARK_CLI = process.env.LARK_CLI || '/Users/xqdmacminim4/.npm-global/bin/lark-cli';
const CDP_PORT = process.env.CDP_PORT || 18800;
const log = (...a) => stderr.write(a.map(String).join(' ') + '\n');

import { promisify } from 'node:util';
const CUSTOMER = {
  name: '深圳易威行贸易有限公司',
  accountId: '001TL0000088AVRYA2',
  mainTenant: 'F8M23ARGPBJ',
};

const CONFIG_PATH = process.env.CFG_PATH || join(__dirname, '..', 'c360.config.json');

// ---------- CDP wrappers ----------
async function cdp(args, opts = {}) {
  const { stdout } = await execFile('node', [CDP, ...args.map(String)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  return stdout;
}

function cdpUnwrap(raw) {
  if (!raw) return raw;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && 'type' in o && 'value' in o) return o.value;
  } catch {}
  return raw;
}

// ---------- find or open a C360 tab ----------
async function findC360Tab() {
  const tabs = JSON.parse(await cdp(['targets']));
  for (const t of tabs) {
    if (t.type === 'page' && (t.url || '').includes('c360.larkoffice.com/pc/')) return t.id;
  }
  const r = JSON.parse(await cdp(['new', `https://c360.larkoffice.com/pc/account/detail/${CUSTOMER.accountId}?tab=tenant-asset-data&anchor=tenant-list`]));
  return r.id;
}

// ---------- phase3: 确认主租户 (tenant-list anchor 修复) ----------
async function phase3(targetId) {
  await cdp(['navigate', targetId, `https://c360.larkoffice.com/pc/account/detail/${CUSTOMER.accountId}?tab=tenant-asset-data&anchor=tenant-list`]);
  await new Promise(r => setTimeout(r, 4000));
  const code = `
    JSON.stringify({
      tenants: Array.from(document.querySelectorAll('a'))
        .filter(a => (a.getAttribute('href') || '').includes('/pc/tenant/detail/'))
        .map(a => {
          const href = a.getAttribute('href') || '';
          const id = (href.match(/\\/pc\\/tenant\\/detail\\/([A-Za-z0-9]+)/) || [])[1] || '';
          const row = a.closest('tr');
          const rowText = row ? row.innerText : '';
          return { id, name: (a.textContent || '').trim(), isMain: rowText.includes('主租户') || rowText.includes('企业认证成功') };
        })
    })
  `;
  const raw = await cdp(['eval', targetId, code]);
  return JSON.parse(cdpUnwrap(raw));
}

// ---------- phase4: 抓取主租户 AI 明细 (XHR 拦截) ----------
async function phase4(targetId) {
  const url = `https://c360.larkoffice.com/pc/tenant/detail/${CUSTOMER.mainTenant}`;
  await cdp(['navigate', targetId, url]);
  await new Promise(r => setTimeout(r, 4000));
  await cdp(['eval', targetId, `
    window.__c360_captured = null;
    if (!window.__c360_orig_open) window.__c360_orig_open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) {
      this._url = (typeof u === 'string') ? u : '';
      if (this._url.includes('metrics_list')) {
        this.addEventListener('load', function() { window.__c360_captured = this.responseText; });
      }
      return window.__c360_orig_open.apply(this, arguments);
    };
    "ok"
  `]);
  // 4. 派发完整 pointer/mouse 事件链点 "额度消耗" tab (index 3)
  await cdp(['eval', targetId, `(() => {
    const tabs = document.querySelectorAll('.ud-c360__tabs__tab');
    if (!tabs[3]) return 'NO_TAB_3';
    const t = tabs[3];
    const r = t.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
    t.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    t.dispatchEvent(new MouseEvent("mousedown", opts));
    t.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
    t.dispatchEvent(new MouseEvent("mouseup", opts));
    t.dispatchEvent(new MouseEvent("click", opts));
    return 'clicked';
  })()`]);
  await new Promise(r => setTimeout(r, 8000));
  const raw = await cdp(['eval', targetId, 'window.__c360_captured']);
  const unwrapped = cdpUnwrap(raw);
  if (!unwrapped || unwrapped === 'null') throw new Error('NO_CAPTURE: XHR interceptor missed the API call');
  const parsed = JSON.parse(unwrapped);
  if (!parsed?.data?.list?.length) throw new Error('EMPTY: metrics_list returned no rows');
  return parsed.data.list;
}

// ---------- buildRows ----------
const METRIC_KEYS = [
  { key: 'ai_credits_asset_usage_knowledge' },
  { key: 'ai_credits_asset_usage_vc_ai' },
  { key: 'ai_credits_asset_usage_aily_buddy' },
  { key: 'ai_credits_asset_usage_miaoda' },
  { key: 'ai_credits_asset_usage_miaoda_claw' },
  { key: 'ai_credits_asset_usage_aily_app' },
  { key: 'ai_credits_asset_usage_aily_agent' },
  { key: 'ai_credits_asset_usage_apaas' },
  { key: 'ai_credits_asset_usage_doc_ai' },
  { key: 'ai_credits_asset_usage_base' },
  { key: 'ai_credits_asset_usage_meego' },
  { key: 'ai_credits_asset_usage_nexus_bot' },
  { key: 'ai_credits_asset_usage_aily_pro' },
];

function buildRows(list, meta) {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const scrapeBatch = now.replace(/[-: ]/g, '').slice(0, 12);
  return list.map((item) => {
    const date = item.date?.display_value;
    const row = {
      record_id: `${meta.customerName}_${date}`,
      customer_name: meta.customerName,
      account_id: meta.accountId,
      main_tenant: meta.mainTenant,
      view_source: meta.viewId || 'oneoff-ywx',
      record_date: date,
      data_source: 'C360',
      scrape_batch: scrapeBatch,
      scrape_time: now,
      total: Number(item.ai_credits_asset_usage?.value) || 0,
    };
    for (const { key } of METRIC_KEYS) {
      row[key] = Number(item[key]?.value) || 0;
    }
    return row;
  });
}

// ---------- pushToMiaodaDb: 唯一写库入口 ----------
async function pushToMiaodaDb(cfg, rows) {
  const m = cfg.miaodaDb;
  if (!m?.enabled) {
    log(`[Miaoda] disabled in config, skip`);
    return 0;
  }
  const sqlEscape = (s) => String(s).replaceAll("'", "''");
  const sqlIdent = (s) => `"${String(s).replaceAll('"', '""')}"`;
  const colMap = m.columns || {};
  // metricCols: 配置里 metric_key -> 妙搭列名(fld*). SQL 列名要用 fld*,
  // 数据值要从 row[metric_key] 取
  const metricKeyToCol = m.columns;  // { 'ai_credits_..._knowledge': 'fldEgcpqXP', ... }
  const metricPairs = Object.entries(metricKeyToCol);  // [[key, fld], ...]
  // 7 元数据列 + 12 metric 列(用 fld* 名)
  const baseCols = ['record_id', 'customer_name', 'account_id', 'main_tenant', 'view_source', 'record_date', 'total'];
  const cols = [...baseCols, ...metricPairs.map(([, fld]) => fld)];
  // ON CONFLICT 引用必须双引号包列名, 妙搭 fld* 是 mixed-case
  const updateSet = [
    '"customer_name" = EXCLUDED."customer_name"',
    '"account_id" = EXCLUDED."account_id"',
    '"main_tenant" = EXCLUDED."main_tenant"',
    '"view_source" = EXCLUDED."view_source"',
    '"record_date" = EXCLUDED."record_date"',
    '"total" = EXCLUDED."total"',
    ...metricPairs.map(([, fld]) => `"${fld}" = EXCLUDED."${fld}"`),
    '"synced_at" = now()',
  ];
  const values = rows.map(rw => {
    const fields = [
      `'${sqlEscape(rw.record_id)}'`,
      `'${sqlEscape(rw.customer_name)}'`,
      `'${sqlEscape(rw.account_id)}'`,
      `'${sqlEscape(rw.main_tenant)}'`,
      `'${sqlEscape(rw.view_source)}'`,
      `'${sqlEscape(rw.record_date)}'`,
      Number(rw.total) || 0,
      ...metricPairs.map(([key]) => Number(rw[key]) || 0),
    ];
    return `(${fields.join(', ')})`;
  });
  const sql = `INSERT INTO ${m.schema}.${m.table} (${cols.map(sqlIdent).join(', ')}) VALUES ${values.join(', ')} ON CONFLICT (record_id) DO UPDATE SET ${updateSet.join(', ')};`;
  const tmpDir = await mkdtemp(join(tmpdir(), 'miaoda-'));
  const sqlFile = join(tmpDir, 'upsert.sql');
  await writeFile(sqlFile, sql);
  log(`[Miaoda] SQL file: ${sqlFile} (${sql.length} bytes, ${rows.length} rows)`);
  // 用 spawnSync 拿完整 stdout/stderr
  const r = spawnSync(LARK_CLI, [
    'apps', '+db-execute',
    '--app-id', m.appId,
    '--env', m.env,
    '--file', 'upsert.sql',
    '--yes',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: tmpDir });
  log(`[Miaoda] status=${r.status}`);
  if (r.stdout) log(`[Miaoda] stdout=${r.stdout.slice(0, 600)}`);
  if (r.stderr) log(`[Miaoda] stderr=${r.stderr.slice(0, 600)}`);
  await rm(tmpDir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`miaoda upsert failed: ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  return rows.length;
}

// ---------- main ----------
async function main() {
  const cfgRaw = await readFile(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(cfgRaw);
  log(`config: viewId=${cfg.viewId}, miaodaDb.enabled=${cfg.miaodaDb?.enabled}`);

  const tid = await findC360Tab();
  log(`tab: ${tid}`);

  log(`phase3 ...`);
  const snap = await phase3(tid);
  log(`phase3: ${snap.tenants.length} tenants, mainTenant=${CUSTOMER.mainTenant}`);
  if (!CUSTOMER.mainTenant) {
    log('FATAL: no main tenant');
    exit(1);
  }

  log(`phase4 ...`);
  const list = await phase4(tid);
  log(`phase4: ${list.length} daily rows`);

  const rows = buildRows(list, {
    customerName: CUSTOMER.name,
    accountId: CUSTOMER.accountId,
    mainTenant: CUSTOMER.mainTenant,
    viewId: 'oneoff-ywx',
  });
  const total30d = rows.reduce((s, r) => s + (Number(r.total) || 0), 0);
  log(`buildRows: ${rows.length} rows, total30d=${total30d}`);

  // 唯一写库入口: 妙搭
  const miaodaRows = await pushToMiaodaDb(cfg, rows);
  log(`miaoda upsert: ${miaodaRows} rows`);

  log(`DONE: ${CUSTOMER.name} total30d=${total30d} miaodaRows=${miaodaRows}`);
}

main().catch(e => { log(`FATAL: ${e.message}\n${e.stack}`); exit(1); });
