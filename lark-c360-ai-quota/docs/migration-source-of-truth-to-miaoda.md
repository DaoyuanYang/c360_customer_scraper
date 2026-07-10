# 数据事实源迁移：Base V2 → 妙搭 DB

> **状态**：决策已确定（用户拍板 2026-06-29）
> **适用范围**：`lark-c360-ai-quota` skill + 妙搭 `customer-ai-dashboard` app
> **阅读对象**：维护 c360 采集脚本的工程师 + 妙搭 dashboard 维护者 + 数据团队

---

## §0. 一句话总结

把 `customer_ai_quota` 数据的**事实源**从飞书 Base V2 (`tblJ4543DWO44K07`) 改为妙搭 DB。Base V2 不再被写、不再被读、不再是数据所有方；妙搭 DB 成为唯一事实源。

**净工作量：1 周开发 + 7 天观察期**。无业务团队变更成本。

---

## §1. 关键认知澄清（最重要的章节）

### 1.1 之前所有对话的 3 个错误前提

这一系列对话里，**前 2 个版本决策文档基于错误前提**，必须先纠正：

| 版本 | 错误前提 | 真实情况 |
|---|---|---|
| v1（已删除） | `c360_collect.mjs` 写 Base，要把 Base 改为妙搭 | c360_collect.mjs **已经**写妙搭 DB（直 SQL），Base 不是它的目标 |
| v2（已删除） | Base V2 是"业务录入界面 + 妙搭 dashboard 数据源"，弃用要新建录入页面 | Base V2 **没有人工录入**（机器 ETL 写入），且事实源在 Base，妙搭 DB 是镜像 |
| **v3（本版）** | **Base V2 才是事实源，妙搭 DB 是冗余镜像** | ✅ 这个版本正确 |

### 1.2 真实数据流（实测确认）

```
                              [现状：Base V2 是事实源]
                              
[1] C360 飞书 CRM (user-67)
        │
        │ CDP 抓取 + XHR 拦截
        ▼
c360_collect.mjs (本地 node)
        │
        ├──────────────────────────────┐
        │                              │
        ▼                              ▼
Base V2 (tblJ4543DWO44K07)        Base 客户表 (tblwV5oiNBOlJWAX)
   7660 行                          270 客户
        │ ← 事实源
        │
        │ lark-cli 翻页
        ▼
sync-from-feishu.mjs (本地 node, 妙搭项目自带)
        │
        │ POST /api/ingest/quota
        ▼
NestJS IngestService (妙搭后端)
   (clean + dedup + upsert)
        │
        ▼
妙搭 DB customer_ai_quota  ← 镜像（冗余，事实源在 Base）
```

**关键确认（代码 grep 验证）**：

| 文件:行 | 代码 | 实际行为 |
|---|---|---|
| `c360_collect.mjs:430-438` | `lark(['base', '+record-list', ...])` | c360 **读** Base V2 查唯一键去重 |
| `c360_collect.mjs:463-468` | `lark(['base', '+record-batch-create', ...])` | c360 **写** Base V2 明细表 |
| `c360_collect.mjs:482-486` | `lark(['base', '+record-list', ...])` | c360 **读** Base 客户表 |
| `c360_collect.mjs:503` | `lark(['base', '+record-upsert', ...])` | c360 **写** Base 客户表（创建） |
| `c360_collect.mjs:719-728` | `lark(['base', '+record-upsert', ...])` | c360 **写** Base 客户表（更新主租户等） |
| `c360_collect.mjs:734` | `await pushToMiaodaDb(...)` | c360 **写** 妙搭 DB |
| `sync-from-feishu.mjs` | `POST /api/ingest/quota` | sync **写** 妙搭 DB |

**Base V2 实际是 3 条路径的"汇聚点"**：
- c360_collect.mjs 同时写 Base 和妙搭
- 妙搭项目自带的 sync-from-feishu.mjs 从 Base 拉到妙搭
- 结果：妙搭 DB 是冗余镜像，Base V2 是事实源

---

## §2. 决策（事实源变更）

### 2.1 一句话

把 `customer_ai_quota` 的事实源从 Base V2 改为妙搭 DB。

### 2.2 改后数据流

```
                              [改后：妙搭 DB 是事实源]
                              
[1] C360 飞书 CRM (user-67)
        │
        │ CDP 抓取 + XHR 拦截
        ▼
c360_collect.mjs (改造后)
        │
        │ lark-cli apps +db-execute (直 SQL 写)
        ▼
┌────────────────────────────────────────────────────┐
│  妙搭 DB (workspace_aadkgklgugsaw)                   │
│                                                      │
│  customers 表 (新建)              ← 新建              │
│    account_id (PK text)                               │
│    customer_name, main_tenant, view_source, ...       │
│                                                      │
│  customer_ai_quota 表 (扩列)        ← 扩 6 列         │
│    record_id (PK text, 改 = ${accountId}_${date})     │
│    customer_name, record_date, total, ...             │
│    + account_id, main_tenant, view_source,            │
│      scrape_time, scrape_batch, data_source           │
│                                                      │
│  ← 事实源（Base V2 不再被任何代码读写）                │
└────────────────────────────────────────────────────┘
        
        ▼ SELECT
NestJS BaseDataService
        ▼
React Dashboard
```

### 2.3 必须删除的资产

| 资产 | 删除时机 | 说明 |
|---|---|---|
| `sync-from-feishu.mjs` | Phase 3（Day 5） | 不再需要从 Base 拉取 |
| Base V2 (`tblJ4543DWO44K07`) | Phase 4.3（Day 12） | 7 天观察期后清空 |
| Base 客户表 (`tblwV5oiNBOlJWAX`) | 保留观察 7 天 + 数据迁移后清空 | 事实源迁出后不再使用 |
| `c360_collect.mjs` 中的所有 `base +record-*` 调用 | Phase 2（Day 2-4） | 改用妙搭 DB |
| `c360.config.json` 中的 Base 字段 | Phase 2.4 | 删 baseToken/customerTableId/unifiedTable/legacyTable/keyField/fields 等 |

### 2.4 保留作逃生舱

| 资产 | 保留时长 | 用途 |
|---|---|---|
| `POST /api/ingest/quota` 端点 | 6 个月 | 应急通道（万一妙搭 DB 出问题） |
| Base V2 表本身 | 7 天 | 观察期对账，回滚窗口 |
| 旧版 `c360_collect.mjs` 代码 | git 保留 | 7 天内可 git revert 回滚 |

---

## §3. 详细工作量（按 1 个全栈工程师）

### Phase 0：妙搭 DB 准备（0.5 天）

| # | 动作 | 命令 / 操作 |
|---|---|---|
| 0.1 | 在妙搭 **dev** 环境建 `customers` 表 | `db.execute(sql.raw(CREATE_CUSTOMERS_SQL))` |
| 0.2 | 给 `customer_ai_quota` 加 6 列 | `ALTER TABLE ... ADD COLUMN ...` |
| 0.3 | 在妙搭 **builder UI** 手工加列到 online | 人工操作（online 禁 DDL） |
| 0.4 | 验证 schema | `lark-cli apps +db-table-get --env online --table customers` |

#### 0.1 customers 表 DDL（dev 环境）

```sql
CREATE TABLE workspace_aadkgklgugsaw.customers (
  account_id          text PRIMARY KEY,
  customer_name       text NOT NULL,
  main_tenant         text,
  view_source         text,
  last_scrape_time    timestamptz,
  total_30d           int4,
  enterable           boolean DEFAULT true,
  synced_at           timestamptz DEFAULT now()
);

CREATE INDEX idx_customers_name
  ON workspace_aadkgklgugsaw.customers(customer_name);
```

#### 0.2 customer_ai_quota 加 6 列（dev 环境）

```sql
ALTER TABLE workspace_aadkgklgugsaw.customer_ai_quota
  ADD COLUMN account_id text,
  ADD COLUMN main_tenant text,
  ADD COLUMN view_source text,
  ADD COLUMN scrape_time timestamptz,
  ADD COLUMN scrape_batch text,
  ADD COLUMN data_source text DEFAULT 'C360';
```

**online 环境同步**：人工到妙搭 builder UI 加同 6 列 + 新建 customers 表。

---

### Phase 1：Base 历史数据迁移（1-2 天）

#### 1.1 全量导出 Base V2 明细（7660 行）

```bash
lark-cli base +record-list \
  --base-token KsGkbl2xZap6HOseBHZck2oKnBg \
  --table-id tblJ4543DWO44K07 \
  --limit 500 \
  --format json \
  > base-v2-export.json
```

#### 1.2 全量导出 Base 客户表（270 行）

```bash
lark-cli base +record-list \
  --base-token KsGkbl2xZap6HOseBHZck2oKnBg \
  --table-id tblwV5oiNBOlJWAX \
  --limit 500 \
  --format json \
  > base-customers-export.json
```

#### 1.3 一次性迁移脚本 `migrate-base-to-miaoda.mjs`

伪代码结构：

```javascript
// 1. 读两份 JSON
const rows = JSON.parse(readFileSync('base-v2-export.json')).data;
const customers = JSON.parse(readFileSync('base-customers-export.json')).data;

// 2. 字段名映射：Base fld* → 妙搭 camelCase / snake_case
//    13 个 fld* 已在 feishu-to-db.ts 里定义，复用即可

// 3. 拼 INSERT INTO customers ... ON CONFLICT (account_id) DO UPDATE
//    注意：record_id (recXXX) → accountId (来自 C360)
//    SQL 走 lark-cli apps +db-execute --file

// 4. 拼 INSERT INTO customer_ai_quota ... ON CONFLICT (record_id) DO UPDATE
//    record_id 从 "${Base recXXX}_${date}" 改为 "${accountId}_${date}"
//    字段映射 + cleanRecord 函数复用 server/database/feishu-to-db.ts 逻辑

// 5. 验证：SELECT count(*) 对账
```

#### 1.4 验证迁移

```bash
# Base V2 行数（应有 7660）
lark-cli base +record-list \
  --base-token KsGkbl2xZap6HOseBHZck2oKnBg \
  --table-id tblJ4543DWO44K07 \
  --format json | jq '.data.data | length'

# 妙搭 DB 行数（应等于上面）
lark-cli apps +db-execute \
  --app-id app_4kesen9z6tbnr \
  --env online \
  --sql "SELECT COUNT(*) FROM workspace_aadkgklgugsaw.customer_ai_quota;" \
  --format json
```

---

### Phase 2：改 c360_collect.mjs（1.5-2 天）

#### 改动点 2.1：删除 `phase5_dedupAndWrite`（line 422-476）

**现状**：写 Base V2（`+record-list` 查去重 + `+record-batch-create` 批量写）

**改后**：删除整个函数，调用 `pushToMiaodaDb`（妙搭 ON CONFLICT 自带幂等去重）

```javascript
// 删除 phase5_dedupAndWrite 整个函数（line 422-476）
// processCustomer 改为：

const miaodaResult = await pushToMiaodaDb(rows, {
  customerName: name,
  accountId,
  mainTenant: snap.mainTenant,
});
const added = miaodaResult?.pushed ?? 0;
const skipped = miaodaResult?.skipped ? rows.length : 0;
```

#### 改动点 2.2：重写 `getOrCreateCustomer`（line 478-523）

**现状**：查 Base 客户表 + 写 Base 客户表

**改后**：查妙搭 `customers` 表 + UPSERT 妙搭 `customers`

**关键变化**：

| 维度 | 现状 | 改后 |
|---|---|---|
| PK | Base record_id (`recXXX`) | `account_id` (C360 文本) |
| 查询 | `+record-list` 拉全表，按客户名匹配 | `SELECT FROM customers WHERE account_id = ? OR customer_name = ?` |
| 写入 | `+record-upsert` | `INSERT ... ON CONFLICT (account_id) DO UPDATE` |
| 返回值 | Base record_id | account_id（后续用作 recordId 前缀） |

伪代码：

```javascript
async function getOrCreateCustomer(name, accountId, viewId) {
  const schema = cfg.miaodaDb.schema;  // 'workspace_aadkgklgugsaw'

  // 1. 优先按 accountId 查
  const sel1 = `SELECT account_id FROM ${schema}.customers
                WHERE account_id = '${sqlEscape(accountId)}' LIMIT 1;`;
  let existing = parseSingleValue(runDbExec(sel1));

  // 2. 兜底按客户名查
  if (!existing && name) {
    const sel2 = `SELECT account_id FROM ${schema}.customers
                  WHERE customer_name = '${sqlEscape(name)}' LIMIT 1;`;
    existing = parseSingleValue(runDbExec(sel2));
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (existing) {
    // 命中 → UPDATE（不改 PK）
    const upd = `UPDATE ${schema}.customers SET
                   customer_name = '${sqlEscape(name)}',
                   view_source = '${sqlEscape(viewId || cfg.viewId)}',
                   last_scrape_time = '${now}'
                 WHERE account_id = '${sqlEscape(existing)}';`;
    runDbExec(upd, { yes: true });
    return existing;
  }

  // 未命中 → INSERT
  const ins = `INSERT INTO ${schema}.customers
                 (account_id, customer_name, view_source, last_scrape_time, enterable)
               VALUES
                 ('${sqlEscape(accountId)}', '${sqlEscape(name)}',
                  '${sqlEscape(viewId || cfg.viewId)}', '${now}', true);`;
  runDbExec(ins, { yes: true });
  return accountId;
}
```

#### 改动点 2.3：processCustomer 末尾的 `+record-upsert`（line 718-728）

**现状**：写 Base 客户表（更新主租户 / 总消耗 / 最近抓取时间）

**改后**：UPDATE 妙搭 `customers` 表

```javascript
// 之前
lark([
  'base', '+record-upsert',
  '--base-token', cfg.baseToken,
  '--table-id', cfg.customerTableId,
  '--record-id', customerRecordId,
  '--json', JSON.stringify({
    '主租户': snap.mainTenant || '',
    '近30天总消耗': total30,
    '最近抓取时间': now,
  }),
]);

// 改后
const updSql = `UPDATE ${schema}.customers SET
                  main_tenant = '${sqlEscape(snap.mainTenant || '')}',
                  total_30d = ${total30},
                  last_scrape_time = '${now}'
                WHERE account_id = '${sqlEscape(accountId)}';`;
lark([
  'apps', '+db-execute',
  '--app-id', cfg.miaodaDb.appId,
  '--env', 'online',
  '--sql', updSql,
  '--yes',
]);
```

#### 改动点 2.4：清理 `c360.config.json`

**删除字段**：
- `baseToken`
- `customerTableId`
- `customerNameFieldId`（死配置）
- `linkFieldId`（死配置）
- `unifiedTable`
- `legacyTable`
- `keyField`
- `fields`（24 字段数组）

**扩展 miaodaDb 节**：

```json
{
  "miaodaDb": {
    "enabled": true,
    "appId": "app_4kesen9z6tbnr",
    "env": "online",
    "schema": "workspace_aadkgklgugsaw",
    "customerTable": "customers",
    "quotaTable": "customer_ai_quota",
    "fieldMap": { /* 13 个 fld* 保持不变 */ }
  }
}
```

#### 改动点 2.5：重写 `buildRows`（line 397-420）

**现状**：返回 Base 24 字段行（飞书 API 字段 ID 顺序）

**改后**：返回妙搭 SQL 友好格式

| 旧（Base 字段） | 新（妙搭列） |
|---|---|
| `唯一键` (`${recordId}_${date}`) | 拼 `${accountId}_${date}` 作 record_id |
| `客户` (link) | 删除（妙搭无 link 字段） |
| `客户名称` | `customer_name` |
| `accountId` | `account_id` |
| `主租户` | `main_tenant` |
| `视图来源` | `view_source` |
| `日期` | `record_date` |
| `总量` | `total` |
| 13 个产品字段 | 13 个 fld*（保持不变） |
| `抓取时间` | `scrape_time` |
| `抓取批次` | `scrape_batch` |
| `数据来源` | `data_source`（固定 'C360'） |

#### 改动点 2.6：`pushToMiaodaDb` 改造（line 547-665）

**主要变化**：

- `recordId` 字段值从 `${Base客户rid}_${date}` 改为 `${accountId}_${date}`
- INSERT 列列表增加 `account_id / main_tenant / view_source / scrape_time / scrape_batch / data_source`（共 6 列新增）

```javascript
const dbColsList = [
  'record_id', 'customer_name', 'record_date', 'total',
  'account_id', 'main_tenant', 'view_source',
  'scrape_time', 'scrape_batch', 'data_source',
  ...dbCols.map(({ dbCol }) => sqlIdent(dbCol)),  // 13 fld*
];
```

#### 改动点 2.7：launchd plist 不需要改

`com.claude.c360-ai-quota.plist` 调的是 `c360_collect.mjs`，脚本路径不变。plist 不动。

---

### Phase 3：删 sync-from-feishu.mjs（0.5 天）

#### 3.1 删除脚本

```bash
rm /Users/xqdmacminim4/Desktop/feishu_claude/explorations/miaoda-board/scripts/sync-from-feishu.mjs
```

#### 3.2 检查外部调度

```bash
# 检查 launchd
ls ~/Library/LaunchAgents/ | grep -i sync
launchctl list | grep -i sync

# 检查妙搭项目内有没有 cron 配置
grep -r "sync-from-feishu" /Users/xqdmacminim4/Desktop/feishu_claude/explorations/miaoda-board/
```

如果有调度器同步删。

#### 3.3 后端 ingest 端点保留作逃生舱（不删）

`POST /api/ingest/quota` 保留 6 个月作为应急通道。

---

### Phase 4：7 天观察期 + 清理（Day 5-12）

#### 4.1 观察期内每天校验

```bash
# 跑全量采集
node c360_collect.mjs

# 对账：妙搭 DB 行数（应稳定 ≈ 7660 + 新增天数）
lark-cli apps +db-execute --app-id app_4kesen9z6tbnr --env online --sql \
  "SELECT COUNT(*) FROM workspace_aadkgklgugsaw.customer_ai_quota;" --format json

# 抽样：随机 5 个客户对照 Base 历史行数
lark-cli apps +db-execute --app-id app_4kesen9z6tbnr --env online --sql \
  "SELECT account_id, COUNT(*) FROM workspace_aadkgklgugsaw.customer_ai_quota
   GROUP BY account_id ORDER BY account_id;" --format json
```

#### 4.2 Dashboard 验证

打开 `https://xinqiaodigital.aiforce.cloud/app/app_4kesen9z6tbnr`，选 3-5 个客户看 KPI + 趋势图 + Top 5，数据应与改前完全一致。

#### 4.3 Day 12 清空 Base 表

```bash
# 备份（保险起见，永久保存）
lark-cli base +record-list --base-token KsGkbl2xZap6HOseBHZck2oKnBg --table-id tblJ4543DWO44K07 --format json > base-v2-backup-20260711.json
lark-cli base +record-list --base-token KsGkbl2xZap6HOseBHZck2oKnBg --table-id tblwV5oiNBOlJWAX --format json > base-customers-backup-20260711.json

# 删除 Base 表
lark-cli base +delete-table --base-token KsGkbl2xZap6HOseBHZck2oKnBg --table-id tblJ4543DWO44K07 --yes
lark-cli base +delete-table --base-token KsGkbl2xZap6HOseBHZck2oKnBg --table-id tblwV5oiNBOlJWAX --yes
```

---

### Phase 5：补齐 dashboard 缺失能力（2-3 天，可选 P2）

详见 `https://xinqiaodigital.feishu.cn/docx/Yw16dWvnaoaF0dxzXE1cXt6KnWe`（妙搭能力边界 Report）§5：

| 工作项 | 工作量 | 优先级 |
|---|---|---|
| 公式字段（`COUNT_DISTINCT == COUNT`） | 1 天 | P2 |
| 反向 link 自动计数 | 1 天 | P2 |
| 客户 ↔ 明细跳转 | 0.5 天（已基本能用） | P2 |

可以跳过——妙搭 dashboard 当前已够用。

---

## §4. 总工作量

| Phase | 工作项 | 工作量 | 累计 |
|---|---|---|---|
| Phase 0 | 妙搭 DB 准备 | 0.5 天 | 0.5 天 |
| Phase 1 | Base 历史数据迁移 | 1-2 天 | 1.5-2.5 天 |
| Phase 2 | 改 c360_collect.mjs（7 个改动点） | 1.5-2 天 | 3-4.5 天 |
| Phase 3 | 删 sync-from-feishu.mjs | 0.5 天 | 3.5-5 天 |
| Phase 4 | 7 天观察期 | 7 天（运行观察） | — |
| Phase 5 | dashboard 补齐 | 2-3 天（可选） | +2-3 天 |
| **总计（不含观察期与 Phase 5）** | | **3.5-5 天 ≈ 1 周** | |

---

## §5. 风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 妙搭 DB 写入失败率高 | 高 | 7 天观察期 + sync-from-feishu.mjs 保留 6 个月 |
| Base 数据迁移漏数据 | 高 | 行数对账 + 抽样校验 |
| 妙搭 DB online 禁 DDL | 中 | Phase 0 在 dev 跑 + 人工到 builder 加列 |
| 7 天内回滚 | 中 | git revert c360_collect.mjs + 重跑 sync-from-feishu.mjs |
| 妙搭前端无审计 | 低 | 机器日志能覆盖大部分（c360_collect.mjs 的 log 行） |
| `accountId` 在妙搭与 C360 不一致 | 中 | `getOrCreateCustomer` 优先按 accountId，名称兜底 |
| 客户改名 | 中 | 用 `accountId` 作 PK（不会因为改名变），`customer_name` 普通列可改 |

---

## §6. 推进顺序（关键里程碑）

```
Day 0:
  Phase 0.1 dev 端建 customers 表 + 加 6 列
  Phase 0.2 builder UI 同步 online 加列

Day 1-2:
  Phase 1.1-1.2 导出 Base V2 + Base 客户表
  Phase 1.3 写 migrate-base-to-miaoda.mjs
  Phase 1.4 迁移 + 验证

Day 2-4:
  Phase 2.1-2.7 改 c360_collect.mjs（dev 端测试）

Day 5:
  Phase 3 删 sync-from-feishu.mjs
  release 部署到 online（dev → online）

Day 5-12:
  Phase 4 7 天观察期
  每日校验 + dashboard 验证

Day 12:
  Phase 4.3 备份 + 删除 Base 表

Day 13+:
  Phase 5 dashboard 补齐（可选）
```

---

## §7. 决策日志（避免反复）

### 7.1 为什么选"事实源迁到妙搭"

- 用户 2026-06-29 拍板：表单录入是机器自动完成的，不需要人工录入界面
- 用户确认：Base V2 现在没有人工录入，事实源在 Base
- 用户意图：把数据所有权从飞书 SaaS 迁到自有平台（妙搭）

### 7.2 为什么之前两个文档被撤回

- v1 错误前提："c360_collect 写 Base" → 错（实际已经直推妙搭）
- v2 错误前提："Base V2 是录入界面" → 错（机器自动录入，没有人工）
- **v3（本版）正确前提**："Base V2 是事实源，妙搭 DB 是镜像，要事实源变更"

### 7.3 与妙搭 DESIGN.md ADR 的关系

妙搭项目自己的 DESIGN.md §3.3 ADR 写了 v3 治本架构（dashboard 后端永远只读 DB，飞书限流只影响同步脚本）。本迁移 = 把"v3 写路径"再往前推一步——**写路径从"本地 sync 脚本读 Base"变成"妙搭 DB 端到端录入"**。

建议在妙搭项目 DESIGN.md 加 ADR-011：

> ADR-011 [2026-06-29] 数据事实源迁移：Base V2 退出，妙搭 DB 成为 customer_ai_quota 唯一事实源

---

## §8. 参考命令

```bash
# 看妙搭 customer_ai_quota 表结构
lark-cli apps +db-table-get --app-id app_4kesen9z6tbnr --table customer_ai_quota --env online

# 看妙搭 customers 表结构（Phase 0 后）
lark-cli apps +db-table-get --app-id app_4kesen9z6tbnr --table customers --env online

# 看妙搭现有 module 列表（参考）
ls /Users/xqdmacminim4/Desktop/feishu_claude/explorations/miaoda-board/server/modules/

# 看 cleanRecord / dedupInBatch（迁移脚本复用）
cat /Users/xqdmacminim4/Desktop/feishu_claude/explorations/miaoda-board/server/database/feishu-to-db.ts

# 删除 sync-from-feishu.mjs（Day 5）
rm /Users/xqdmacminim4/Desktop/feishu_claude/explorations/miaoda-board/scripts/sync-from-feishu.mjs

# 7 天后清空 Base 表（Day 12）
lark-cli base +delete-table --base-token KsGkbl2xZap6HOseBHZck2oKnBg --table-id tblJ4543DWO44K07 --yes
```

---

## §9. 相关文档

- **妙搭能力边界 Report**：`https://xinqiaodigital.feishu.cn/docx/Yw16dWvnaoaF0dxzXE1cXt6KnWe`
- **妙搭项目 DESIGN.md**：`explorations/miaoda-board/docs/DESIGN.md`（ADR-010 已有，本迁移 ADR-011 待加）
- **妙搭项目 README**：`explorations/miaoda-board/README.md`
- **c360_collect.mjs 现状**：`scripts/c360_collect.mjs`（line 422-476 / 478-523 / 547-665 / 718-728 为改动点）

---

**文档结束。** 任何与本迁移相关的实现细节变更，先改本文档，再改代码。

> **版本历史**：
> - v1（2026-06-28，基于错误前提"c360 写 Base"，已删除）
> - v2（2026-06-28，基于错误前提"Base 是录入界面"，已删除）
> - v3（2026-06-29，正确版：Base V2 是事实源，妙搭 DB 接收事实源变更）