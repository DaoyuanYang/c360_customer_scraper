# Lark C360 AI Quota Data Extractor (Claude Code V2.3)

从飞书 C360 CRM 抓取 **`user-67`「鑫企点老客户」视图** 的客户与 AI 通用额度每日明细，写入飞书 Base + 同步 upsert 到妙搭 aPaaS app `customer_ai_quota` 表。客户表只写客户主数据，不写 C360 列表视图的 ARR/员工数/行业/省份等扩展列。

## 数据流

```
C360 页面 (user-67 视图)
  ↓
scripts/c360_collect.mjs
  ├─→ 飞书 Base (KsGkbl2xZap6HOseBHZck2oKnBg)
  │     ├── 客户表 (tblwV5oiNBOlJWAX)  ← accountId 唯一键 upsert
  │     │     ├── 客户名称 / accountId / 主租户 / 视图来源
  │     │     ├── 最近抓取时间 / 近30天总消耗
  │     │     ├── 实际可进入详情 (checkbox)
  │     │     ├── 客户表一致性 (formula，校验 COUNT_DISTINCT == COUNT)
  │     │     └── AI 用量明细 V2 (link 反向)
  │     └── AI 通用额度明细 V2 (tblJ4543DWO44K07)
  │           ├── 唯一键 = ${客户recordId}_${日期} (去重)
  │           ├── 客户 (link) / 客户名称 / accountId / 主租户
  │           ├── 日期 + 14 项分类用量
  │           └── 抓取时间 / 抓取批次 / 数据来源
  │
  └─→ 妙搭 aPaaS app (app_4kesen9z6tbnr)
        └── customer_ai_quota (workspace_aadkgklgugsaw.customer_ai_quota)
              ├── record_id (PK) = ${客户recordId}_${日期}
              ├── customer_name / record_date / total
              ├── fld* (13 列) ← 14 项分类用量（飞书项目 AI / aily 专业版 落 0）
              └── synced_at (自动 now())
              upsert via lark-cli apps +db-execute (INSERT ... ON CONFLICT DO UPDATE)
```

## 防止重复行的设计

- **客户表 upsert 唯一键**：`accountId` 优先，`客户名称` 兜底
- **main 循环 in-memory dedup**：同 accountId / 客户名只处理一次
- **`实际可进入详情` checkbox**：标记当前 `user-67` 视图中可进入详情页的客户
- **`客户表一致性` formula**：`IF(COUNT_DISTINCT(accountId)==COUNT(),"OK",CONCATENATE("重复行:",COUNT()-COUNT_DISTINCT(accountId)))`，Base 视图里实时校验
- **AI 明细去重**：`唯一键 = ${客户recordId}_${日期}` 二次跑同一客户 0 new / 全部 skipped
- **妙搭 DB 幂等**：`record_id` PK + `ON CONFLICT (record_id) DO UPDATE`，重复运行不产生重复行，`synced_at` 自动刷新

## Quick start

```bash
# 1. Start Edge with CDP
open -na "Microsoft Edge" --args \
  --remote-debugging-port=18800 \
  --remote-allow-origins=* \
  --user-data-dir=/tmp/claude-c360-debug-edge \
  "https://c360.larkoffice.com/pc/account/list?viewId=user-67"

# 2. Login to C360 in the Edge window if needed

# 3. Run from skill dir
cd /Users/xqdmacminim4/Desktop/feishu_claude/.agents/skills/lark-c360-ai-quota
export PATH="$HOME/.npm-global/bin:$PATH"
export LARK_CLI="$HOME/.npm-global/bin/lark-cli"
export CDP_PORT=18800

# 4. 5-customer validation (also exercises 妙搭 DB dry-run)
node scripts/c360_collect.mjs --test-mode --dry-run
node scripts/c360_collect.mjs --test-mode

# 5. Full run (~90-100 minutes, 279 customers)
# Detached with nohup so the run survives the bash shell exiting.
DATE="$(date +%Y%m%d_%H%M%S)"
LOG="/tmp/c360_full_${DATE}.log"
PROG="/tmp/c360_progress_${DATE}.txt"
nohup caffeinate -i node scripts/c360_collect.mjs > "$LOG" 2>&1 & disown
nohup node scripts/progress_watcher.mjs --log "$LOG" --interval 15 > "$PROG" 2>&1 & disown

# 6. Watch progress
c360-progress   # after adding the shell function from SKILL.md §7
```

`progress_watcher` 输出 2 行：百分比进度条 + 当前正在抓的公司名。详见 SKILL.md 第 6-7 节。

## 链接

- Base: https://xinqiaodigital.feishu.cn/base/KsGkbl2xZap6HOseBHZck2oKnBg
- 客户表: https://xinqiaodigital.feishu.cn/base/KsGkbl2xZap6HOseBHZck2oKnBg?table=tblwV5oiNBOlJWAX
- AI 通用额度明细 V2: https://xinqiaodigital.feishu.cn/base/KsGkbl2xZap6HOseBHZck2oKnBg?table=tblJ4543DWO44K07
- 妙搭看板: https://xinqiaodigital.aiforce.cloud/app/app_4kesen9z6tbnr

## Notes

- C360 URL `?page=N` does **not** trigger real pagination. The script dispatches a full pointer+mouse event chain on `.ud-c360__pagination-next` (the SPA listens on `pointerdown`/`mousedown`, not `click`).
- C360 reports 293 rows for `user-67`（「鑫企点老客户」）；DOM exposes 279 clickable account links across 15 pages (19×14 + 13). The 14 missing rows are permission-denied, placeholders, or rows without `accountId`.
- AI usage is captured via XHR interceptor on `metrics_list`; direct fetch fails CSRF.
- Customer table upsert key: `accountId` (preferred), `客户名称` (fallback).
- AI detail dedup key: `唯一键 = ${customerRecordId}_${日期}`.
- Link cell format: `[{"id":"recXXX"}]`.
- **妙搭同步（v2.2+）**：默认启用。PK `record_id` 与 Base「唯一键」一致。2026-06-30 起 13 个产品列名由 Base fld ID (`fldEgcpqXP` 等) 改为中文产品名（`知识问答` / `智能纪要` / `妙搭` 等，与看板堆叠面积图标签一致），SQL 必须用双引号包裹。30 行 INSERT 超过 macOS argv 上限，因此走 `lark-cli --file <rel-path>` 临时文件方式。妙搭 `online` 环境禁止 DDL，一次性清空用 `DELETE FROM` 而不是 `TRUNCATE`，schema 变更（重命名/新增列）只能改 dev 或走应用编辑器重发布。
- **进度显示（v2.3+）**：每客户处理完后写一行 `[N/M] OK|FAIL|SKIP <name> ...` 到日志；`progress_watcher.mjs` 把日志 tail 出来输出 2 行（百分比进度条 + 当前正在抓的公司名），适合长任务后台跑时观察。
- v2.1 及更早版本曾用妙搭 `/api/ingest/quota` HTTP + CSRF Cookie 路径，**已废弃**（2026-06-28 妙搭根域名直接 302 到飞书 OAuth）。

See `SKILL.md` for full operational details.
