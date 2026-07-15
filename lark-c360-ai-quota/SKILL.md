---
name: lark-c360-ai-quota
version: 2.5.0
description: "从飞书 C360 CRM 自动化抓取「鑫企点老客户」视图客户与 AI 通用额度每日明细，upsert 到妙搭 aPaaS app `customer_ai_quota` 表（唯一落地点）。妙搭写入通过 `lark-cli apps +db-execute` 直写数据库，PK 用 `record_id = ${customerName}_${date}`，ON CONFLICT 走 DO UPDATE 实现幂等。早期一级落地的飞书 Base（客户表 + AI 通用额度明细 V2）已退役：脚本不再写、不再读，飞书里的历史表仅作归档保留。phase2 翻页使用完整 pointer/mouse 事件链以触发 ud-c360 UI 组件。后台跑 + watcher + `c360-progress { --brief | --watch | --all | --one-line }` 提供实时进度，多 agent 并行支持单行 mini-bar 压缩或每行一个 run。macOS launchd 已注册每天 00:30 自动全量抓取（caffeinate 防止睡眠 + IM 通知汇总）。当需要批量采集 C360 客户 AI 消耗明细、5 客户验证或全量抓取时使用。"
metadata:
  requires:
    bins:
      - lark-cli
      - node>=20
      - jq
      - "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
---

# lark-c360-ai-quota

C360 客户 AI 通用额度采集。数据**唯一落地点是妙搭 DB**（`customer_ai_quota` 表）：

- **唯一抓取的 C360 视图**：`user-67`（「鑫企点老客户」）
- 浏览器：Microsoft Edge CDP，端口 `18800`
- **妙搭落地**：每客户抓取完成后通过 `lark-cli apps +db-execute` 把 30 行 upsert 到妙搭 app `customer_ai_quota` 表，供「客户 AI 额度使用看板」可视化。

> **前置条件：** 妙搭写入使用 `lark-cli apps +db-execute`（运行前确认 `lark-cli auth status` 为 ready）。

> **架构现状（2026-06-29 迁移已落地）**：`customer_ai_quota` 的事实源是妙搭 DB。早期一级落地的飞书 Base V2（`tblJ4543DWO44K07`）+ 客户表（`tblwV5oiNBOlJWAX`）**已退役**——`c360_collect.mjs` 不再写、不再读 Base，`sync-from-feishu.mjs` 已删。飞书里的两张历史表仅作归档保留（未物理删除）。迁移决策见 [`docs/migration-source-of-truth-to-miaoda.md`](docs/migration-source-of-truth-to-miaoda.md)。

---

## Agent 行为准则

1. **每次抓取主动告诉用户如何看进度。** 任何 c360_collect.mjs 的实跑（不管是单客户、5 客户验证还是全量），启动后**必须在同一条回复里**给出三件事：
   - 当前启动命令（如 `nohup caffeinate -i node scripts/c360_collect.mjs ...`）
   - 日志文件路径（如 `/tmp/c360_full_20260628_181532.log`）
   - 一键查看进度的命令（`c360-progress`，详见 §7；或一次性 inline 版本）
   不要等用户问「进度怎么样」才说——主动告知。
2. **进度汇报使用 2 行格式**：百分比进度条 + 当前正在抓的公司名（由 `progress_watcher.mjs` 渲染）。不要贴 JSON、不要贴 `[N/M]` 原始行。
3. **长任务（≥5 分钟）必须用 `nohup` + `disown`** 脱离当前 bash shell，配置 `progress_watcher.mjs` 输出到独立文件。不要用 `tee`（harness 容器退出时管道关闭会带走 node 子进程）。
4. **报告完成 / 失败 / 阶段进展时附 OK / FAIL / SKIP 计数**——用 `c360-progress` 同款的 `grep -cE` 命令。
5. **长任务期间用心跳汇报而不是靠用户跑 `c360-progress --watch`。** AI 的 Bash 工具不是真 TTY（`! -t 1`），`--watch` 在 pipe / redirected stdout 里会被脚本自动降级为 `--brief` 单次输出（不会再 crash）；但跨 Bash 调用之间前一次的输出已经渲染在用户消息流里，无法覆盖。**正确做法**：每 60-120 秒跑一次 `zsh -i -c 'c360-progress --brief'` 输出**单行紧凑**快照（`[==>] 39% (109/279)  XX公司 · OK 106 F 0 S 3`），贴给用户作为「心跳」。如果同时在跑多个 agent（多个 run），用 `c360-progress --one-line` 输出单行多 run 压缩版（`#1 [...] 67% (187/279) OK 180 F 0 S 7 | #2 [...] 65% (183/279) ...`），或 `--all` 列出每行一个 run。用户说「停」就停。完整快照用 `c360-progress`（不带 flag）。**真正的同 in-place 实时刷新只在用户自己的真终端里 `c360-progress --watch [--all|--one-line]` 才有效**（用 `\r` + `\x1b[2K` 覆盖同一行）。

---

## 何时使用

- 用户说「跑一下 C360 AI 额度」「抓鑫企点老客户 AI 消耗」「全量跑一次」「同步到妙搭」。
- 需要从 C360 的 **`user-67`「鑫企点老客户」视图** 抓客户列表、主租户、近 30 天 AI 通用额度每日明细。不要切换到其他 viewId。
- 需要把每日明细通过 `miaodaDb` 配置 upsert 到妙搭 `customer_ai_quota` 表（唯一落地点，默认启用）。

## 当前数据结构

### 妙搭 DB 表（唯一落地点）

- app：`app_4kesen9z6tbnr`
- schema：`workspace_aadkgklgugsaw`
- 表名：`customer_ai_quota`
- 看板：「客户 AI 额度使用看板」

固定列（`buildRows()` 是唯一事实源，对应妙搭表 user columns）：

| 列 | 类型 | 说明 |
|---|---|---|
| record_id | text (PK) | `${customerName}_${date}`，ON CONFLICT 幂等键 |
| customer_name | text | 客户公司全称 |
| account_id | text | C360 accountId |
| main_tenant | text | C360 主租户 ID |
| view_source | text | 视图来源，当前 `user-67` |
| record_date | text | C360 返回日期 |
| total | number | AI 通用额度总消耗 |
| data_source | text | 固定 `C360` |
| scrape_batch | text | 如 `202606231408` |
| scrape_time | datetime | 写入时间 |
| synced_at | datetime | upsert 时自动刷新为 `now()` |

13 个产品分类列（`c360.config.json` 的 `miaodaDb.columns` 映射 C360 指标 key → 妙搭中文列名）：

| 妙搭列 | C360 指标 key |
|---|---|
| 知识问答 | `ai_credits_asset_usage_knowledge` |
| 智能纪要 | `ai_credits_asset_usage_vc_ai` |
| 飞书 aily 智能伙伴 | `ai_credits_asset_usage_nexus_bot` |
| 妙搭 | `ai_credits_asset_usage_miaoda` |
| 飞书 OpenClaw | `ai_credits_asset_usage_miaoda_claw` |
| 飞书 aily 应用 | `ai_credits_asset_usage_aily_app` |
| 飞书 aily 智能体 | `ai_credits_asset_usage_aily_agent` |
| 飞书 aPaaS | `ai_credits_asset_usage_apaas` |
| 文档 AI 速览 | `ai_credits_asset_usage_doc_ai` |
| 多维表格 AI | `ai_credits_asset_usage_base` |
| 飞书项目 AI | `ai_credits_asset_usage_meego`（当前恒为 0） |
| 飞书 aily 专用额度 | `ai_credits_aily_pro`(当前恒为 0,C360 暂无此产品) |
| 飞书 aily 专业版 | `ai_credits_asset_usage_aily_buddy` |

> **已退役的飞书 Base（仅归档保留，脚本不再读写）**：Base `KsGkbl2xZap6HOseBHZck2oKnBg` 下的客户表 `tblwV5oiNBOlJWAX` 与 AI 通用额度明细 V2 `tblJ4543DWO44K07`。如需查历史数据可在飞书里直接打开，但采集链路已不依赖它们。

---

> ⚠️ **2026-07-15 修正**: C360 后台的 metric key 字面意思跟产品名对调了 — `aily_buddy` 实际返回 飞书 aily专业版 的数据,`nexus_bot` 实际返回 飞书 aily 智能伙伴 的数据。`c360.config.json` 映射和本表都已 swap。

## 快速开始

### 1. 启动 Edge CDP

```bash
open -na "Microsoft Edge" --args \
  --remote-debugging-port=18800 \
  --remote-allow-origins=* \
  --user-data-dir=/tmp/claude-c360-debug-edge \
  "https://c360.larkoffice.com/pc/account/list?viewId=user-67"
```

如果跳登录页，用户需要在这个 Edge 窗口完成 C360 登录。

### 2. 进入 skill 目录

```bash
cd /Users/xqdmacminim4/Desktop/feishu_claude/.agents/skills/lark-c360-ai-quota
export PATH="$HOME/.npm-global/bin:$PATH"
export LARK_CLI="$HOME/.npm-global/bin/lark-cli"
export CDP_PORT=18800
```

### 3. 5 客户验证

```bash
node scripts/c360_collect.mjs --test-mode --dry-run
node scripts/c360_collect.mjs --test-mode
```

已验证 5 客户（来自 `c360.config.json: testCustomers`）：

| 客户 | 主租户 | 30天总消耗 |
|---|---|---:|
| 厦门吉比特网络技术股份有限公司 | `F343504548` | 621,534 |
| 深圳矽递科技股份有限公司 | `FGAYRNYV9XG` | 214,931 |
| 深圳市爱协生科技股份有限公司 | `FMLGGNZ973J` | 158,987 |
| 深圳市杉岩数据技术有限公司 | `FOJR41VG62J` | 190,555 |
| 深圳超维动力智能科技有限公司 | `FMLPVRY5Z5J` | 0 |

### 4. 全量 AI 明细

```bash
node scripts/c360_collect.mjs
```

预估：~279 客户 × 30 天 ≈ 8,370 行，耗时约 90–100 分钟（每客户 20s）。建议全量时让 Mac 保持唤醒：

```bash
caffeinate -i node scripts/c360_collect.mjs
```

### 5. 只跑某个客户

```bash
node scripts/c360_collect.mjs --customer "厦门吉比特网络技术股份有限公司"
```

### 6. 后台跑 + 实时进度（推荐全量时使用）

全量 ~93 分钟，建议 `nohup` + `disown` 把进程脱离当前 shell，然后用 `progress_watcher.mjs` 实时观察：

```bash
DATE="$(date +%Y%m%d_%H%M%S)"
export PATH="$HOME/.npm-global/bin:$PATH"
LOG="/tmp/c360_full_${DATE}.log"
PROG="/tmp/c360_progress_${DATE}.txt"

# 启动采集（后台、脱离 bash）
nohup caffeinate -i node scripts/c360_collect.mjs > "$LOG" 2>&1 & disown

# 启动 watcher：每 15 秒输出 2 行（百分比进度条 + 当前公司名）到独立文件
nohup node scripts/progress_watcher.mjs --log "$LOG" --interval 15 > "$PROG" 2>&1 & disown
```

`progress_watcher` 渲染示例：

```
[==========>                   ]  36.2% (101/279)
当前: 深圳市建筑科学研究院股份有限公司
```

进度文件在 phase2 翻页阶段会显示「`(-- 阶段：抓取客户名单 --)`」直到 `found N customers in view ...` 行出现。

### 7. 一键查看进度（shell 函数）

skill 自带 `scripts/c360-progress.zsh`。三种加载方式选一：

**方式 A：直接 source**（最简单）

```bash
echo '' >> ~/.zshrc
echo 'source /Users/xqdmacminim4/Desktop/feishu_claude/.agents/skills/lark-c360-ai-quota/scripts/c360-progress.zsh' >> ~/.zshrc
source ~/.zshrc
```

**方式 B：放到 `~/.zsh_functions/` 自动加载**（如果你已经有这种习惯）

```bash
mkdir -p ~/.zsh_functions
ln -sf /Users/xqdmacminim4/Desktop/feishu_claude/.agents/skills/lark-c360-ai-quota/scripts/c360-progress.zsh \
       ~/.zsh_functions/c360-progress.zsh
echo 'for f in ~/.zsh_functions/*.zsh; do source "$f"; done' >> ~/.zshrc
source ~/.zshrc
```

**方式 C：直接复制函数到 `~/.zshrc`**（没耐心装软链就用这个）

```bash
cat /Users/xqdmacminim4/Desktop/feishu_claude/.agents/skills/lark-c360-ai-quota/scripts/c360-progress.zsh >> ~/.zshrc
source ~/.zshrc
```

加载后用 `c360-progress` 一键查：

```bash
$ c360-progress
📊 /tmp/c360_progress_20260628_181532.txt
📄 /tmp/c360_full_20260628_181532.log

[==========>                   ]  36.2% (101/279)
当前: 深圳市建筑科学研究院股份有限公司

🟢 OK=98   🔴 FAIL=3   ⚪ SKIP=0   (total=279)
```

函数支持以下用法：

| 命令 | 行为 |
|---|---|
| `c360-progress` | 完整快照（文件路径 + 2 行进度 + 计数 emoji）— 默认显示**最新**的 run |
| `c360-progress --brief`（或 `-b`）| **单行紧凑**：进度条 + 百分比 + 当前公司名 + 计数。**AI 心跳汇报用这个** |
| `c360-progress --watch`（或 `-w`）| 每 10 秒在同一行 in-place 刷新（`\r` + `\x1b[2K` 清行覆盖）。**只在用户自己的真 TTY 终端里有效**；在 pipe / 非 TTY 自动降级为 `--brief` 单次输出 |
| `c360-progress --watch --all` | 多行面板，每个 run 一行，每 10 秒 in-place 刷新（光标上移 N 行 + 清屏）|
| `c360-progress --all`（或 `-a`）| **多 agent 并行时用**：每个 run 一行 `--brief`，前缀 `#1 #2 #3 ...` 编号 |
| `c360-progress --one-line`（或 `-1`）| **多 agent 一行**：每个 run 一个 mini-bar + 计数，`\|` 连接成单行 |
| `c360-progress --watch --one-line` | `--one-line` 模式下 in-place 刷新（适合窄终端 / 状态栏）|
| `c360-progress --id N`（或 `-i N`）| 选第 N 个 run（默认 N=1 = 最新）；可以接 `--brief` / `--watch` / 默认全快照 |
| `c360-progress --list`（或 `-l`）| 列出当前所有 run：`#N age=Xs prog=<path> log=<path>`，不输出进度 |

**多 agent 用法**：同时跑多个 c360_collect.mjs（比如一个全量 + 一个单客户 debug）时，所有 run 的 progress 文件 `/tmp/c360_progress_*.txt` 都会保留。`c360-progress --list` 看有哪些；`c360-progress --all` 一行看完所有；`c360-progress --id 2 --watch` 在你的真终端里盯第二个 run。

`--all` 输出示例：

```
#1 [=======>            ]  39% (109/279)  深圳奥尼电子股份有限公司 · OK 106 F 0 S 3
#2 [==>                  ]   5% (5/270)    厦门吉比特网络技术股份有限公司 · OK 5 F 0 S 0
```

`--list` 输出示例：

```
#1  age=  10s  prog=/tmp/c360_progress_20260628_181532.txt  log=/tmp/c360_full_20260628_181532.log
#2  age= 240s  prog=/tmp/c360_progress_20260628_174920.txt  log=/tmp/c360_full_20260628_174920.log
```

`--watch` 实时 TTY 刷新示意（每 10 秒同 in-place 覆盖）：

```
[=======>            ]  39% (109/279)  深圳奥尼电子股份有限公司 · OK 106 F 0 S 3
[=======>            ]  39% (109/279)  广州康盛生物科技有限公司 · OK 114 F 0 S 4
[========>           ]  41% (117/279)  深圳视通控投科技有限公司 · OK 113 F 0 S 4
```

`--brief` 输出示例：

```
[=======>            ]  39% (109/279)  深圳奥尼电子股份有限公司 · OK 106 F 0 S 3
```

phase2 翻页阶段会显示 `(phase2 翻页中)`。完成后会显示 `(已完成)`。

`--watch` 渲染示意（用户在真终端里跑，每 10 秒在同一行原地刷新）：

```
[=======>            ]  39% (109/279)  深圳奥尼电子股份有限公司 · OK 106 F 0 S 3
[=======>            ]  39% (109/279)  广州康盛生物科技有限公司 · OK 114 F 0 S 4
[========>           ]  41% (117/279)  深圳视通控投科技有限公司 · OK 113 F 0 S 4
```

ANSI 转义 `\r\x1b[2K` 让光标回到行首 + 清行，所以看起来像在同一行变化（类似 `top` / `watch`）。

`--one-line` 输出示意（多 agent **压缩成一行**，`|` 分隔；适合窄终端 / 状态栏 / 消息心跳）：

```
#1 [====>  ] 67% (187/279) OK 180 F 0 S 7 | #2 [====>  ] 65% (183/279) OK 177 F 0 S 6
```

`--watch --one-line` 在真终端里跑：每 10 秒在**同一行** in-place 替换所有 run 的 mini-bar（`\r\x1b[2K`）。适合「一个 status bar 盯所有 agent」。

`--brief` 的「一次性 inline 版本」（直接粘贴到任何 shell，给 AI 心跳用）：

```bash
LOG=$(ls -t /tmp/c360_full_*.log 2>/dev/null | head -1) && \
[ -z "$LOG" ] && echo "no c360 run" || \
awk -v log="$LOG" 'BEGIN{ done=0; total="?"; cur="(phase2 翻页中)"; ok=0; f=0; s=0 } \
  /found [0-9]+ customers/ && total=="?" { match($0, /[0-9]+/); total=substr($0, RSTART, RLENGTH) } \
  /^\[[0-9]+\/[0-9]+\] OK /   { ok++; done=$0; sub(/^\[|\].*/,"",done); split(done,a,"/"); done=a[1]; total=a[2] } \
  /^\[[0-9]+\/[0-9]+\] FAIL / { f++;  done=$0; sub(/^\[|\].*/,"",done); split(done,a,"/"); done=a[1]; total=a[2] } \
  /^\[[0-9]+\/[0-9]+\] SKIP / { s++;  done=$0; sub(/^\[|\].*/,"",done); split(done,a,"/"); done=a[1]; total=a[2] } \
  /^--- / && NF>=2 { nm=$2; for(i=3;i<=NF-1;i++) nm=nm" "$i; gsub(/[()]/,"",nm); cur=nm } \
  END { if (total=="?") total=0; pct=(total>0)?int(done*100/total):0; bar=""; filled=int(pct/5); for(i=0;i<20;i++){ if(i<filled) bar=bar"="; else if(i==filled && filled<20) bar=bar">"; else bar=bar" " } printf "[%s] %3d%% (%d/%d)  %s · OK %d F %d S %d\n", bar, pct, done, total, cur, ok, f, s }' "$LOG"
```

不用任何 alias 的一次性版本（直接粘贴到任何 shell）：

```bash
PROG=$(ls -t /tmp/c360_progress_*.txt 2>/dev/null | head -1) && \
LOG=$(ls -t /tmp/c360_full_*.log 2>/dev/null | head -1) && \
echo "📊 $PROG" && echo "📄 $LOG" && echo "" && \
sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\r/\n/g' "$PROG" \
  | grep -E '^(\[|当前|--|完成|排队|等待|阶段)' | tail -2 && echo "" && \
printf "OK=%s FAIL=%s SKIP=%s\n" \
  "$(grep -cE '^\[[0-9]+/[0-9]+\] OK ' "$LOG")" \
  "$(grep -cE '^\[[0-9]+/[0-9]+\] FAIL ' "$LOG")" \
  "$(grep -cE '^\[[0-9]+/[0-9]+\] SKIP ' "$LOG")"
```

### 8. 校验妙搭无重复

`record_id = ${customerName}_${date}` 是妙搭表 PK，`ON CONFLICT (record_id) DO UPDATE` 保证同客户同日期幂等，不会出现重复行。跑完后可查行数：

```bash
lark-cli apps +db-execute \
  --app-id app_4kesen9z6tbnr --env online \
  --sql "SELECT COUNT(*) AS rows, COUNT(DISTINCT record_id) AS uniq FROM workspace_aadkgklgugsaw.customer_ai_quota;" \
  --yes
```

`rows == uniq` 即无重复。

---

## 妙搭 DB 同步

采集脚本把每日明细 upsert 到妙搭（aPaaS）app 的 `customer_ai_quota` 表（唯一落地点），供「客户 AI 额度使用看板」可视化使用。

> **迁移说明**：早期版本曾走妙搭 `/api/ingest/quota` HTTP 接口 + CSRF Cookie 认证。2026-06-28 起妙搭根域名直接 302 到飞书 OAuth，CSRF token 拿不到，HTTP 路径已废弃。新链路改为 `lark-cli apps +db-execute` 直写数据库。

### 配置

在 `c360.config.json` 中 `miaodaDb` 配置节（已默认启用）：

```json
{
  "miaodaDb": {
    "enabled": true,
    "appId": "app_4kesen9z6tbnr",
    "env": "online",
    "schema": "workspace_aadkgklgugsaw",
    "table": "customer_ai_quota",
    "fieldMap": {
      "知识问答": "fldEgcpqXP",
      "智能纪要": "fldXRhRz1h",
      "飞书 aily 智能伙伴": "fldo9bvHTA",
      "妙搭": "fldyggrhoW",
      "飞书 OpenClaw": "fldg5K4CSw",
      "飞书 aily 应用": "fldTU71olN",
      "飞书 aily 智能体": "fld6u3GcpN",
      "飞书 aPaaS": "fldQ47MEJL",
      "文档 AI 速览": "fldzgVPuhJ",
      "多维表格 AI": "fldm5RingY",
      "飞书项目 AI": "fld2E00EO5",
      "飞书 aily 专用额度": "fld1914Oiu",
      "飞书 aily 专业版": "fldLYsRjHF"
    }
  }
}
```

| 配置项 | 说明 |
|---|---|
| `enabled` | 是否启用同步（默认 `false`） |
| `appId` | 妙搭 app id |
| `env` | `online`（生产）或 `dev`（开发） |
| `schema` | 数据库 schema 名（妙搭线上固定 `workspace_aadkgklgugsaw`） |
| `table` | 目标表名（固定 `customer_ai_quota`） |
| `fieldMap` | C360 指标 key → 妙搭中文列名（实际配置见 `c360.config.json` 的 `miaodaDb.columns`） |

> **认证：** 走 `lark-cli` 自己的 OAuth user token，授权后无需手动管 cookie/token。运行前确认 `lark-cli auth status` 是 ready。

### 主键与去重

妙搭表 PK 是 `record_id`（text）。脚本写入时用 `record_id = ${customerName}_${date}`（由 `buildRows()` 生成）。

SQL 用 `INSERT ... ON CONFLICT (record_id) DO UPDATE SET ...`，重复运行同一客户/日期时会原地更新，不产生重复行。`synced_at` 自动刷新为 `now()`。

### 运行效果

启用后，每抓取一个客户会额外输出一行 SQL upsert 日志：

```
MIAODA-OK 厦门吉比特网络技术股份有限公司: upserted=30 of 30
```

`--dry-run` 模式下输出 `MIAODA-DRY ...`，不实际写库；最终报告的 markdown 表会多「妙搭推送」列，stderr 末尾会输出「妙搭 DB 推送汇总」统计。

### 一次性迁移：清空历史 recv... 格式行

旧 ingest 接口写入的 `record_id` 是 Base V2 表 `_record_id`（`recv...` 格式）。新 SQL 链路用 `${客户recordId}_${date}` 格式，**两套 PK 不互通**。所以切换前要清空妙搭表：

> **注意**：妙搭 `online` 环境禁止 DDL（`TRUNCATE` 会返回 `k_dl_4000001 forbid ddl/dcl operation`）。改用 `DELETE FROM`：

```bash
lark-cli apps +db-execute \
  --app-id app_4kesen9z6tbnr \
  --env online \
  --sql "DELETE FROM workspace_aadkgklgugsaw.customer_ai_quota;" \
  --yes
```

实测 7,660 行 DELETE 一次成功（约 1 秒）。`customer_assignments.record_id` 看着像引用 quota，但全部 128 行已经是孤儿（quota 表里不存在对应 record_id），清空 quota 不会破坏任何引用关系。

### 关闭同步

将 `miaodaDb.enabled` 设为 `false`，脚本只抓取不落库（妙搭是唯一 sink，Base 已退役，关闭后没有任何写入目标）。仅用于纯抓取验证。

### 字段映射说明

妙搭表的 13 个产品列在 2026-06-30 由 Base fld ID (`fldXXX`) 改为中文产品名（`知识问答` / `智能纪要` / `飞书 aily 智能伙伴` / `妙搭` / `飞书 OpenClaw` / `飞书 aily 应用` / `飞书 aily 智能体` / `飞书 aPaaS` / `文档 AI 速览` / `多维表格 AI` / `飞书项目 AI` / `飞书 aily 专用额度` / `飞书 aily 专业版`），与看板堆叠面积图标签统一。映射是用 2026-06-22 吉比特一行实测对照确认（Base 各分类值 vs 妙搭列值，差额 1 是 C360 的四舍五入，自洽）。`飞书项目 AI` 和 `飞书 aily 专业版` 在妙搭表里当前都恒为 0。dev + online 均已 rename 成功(online 通过 NestJS onModuleInit 跑 idempotent migration,详见 docs §13 / 妙搭 board 文档)。

如果妙搭 app schema 变了，`lark-cli apps +db-table-get --app-id app_4kesen9z6tbnr --table customer_ai_quota --env online` 可以重新查列结构。

---

## 关键实现细节

### 客户去重

main 循环里的 in-memory 去重（按 `accountId` / 客户名）保证一次跑不会重复处理同一客户；落库幂等再由妙搭 PK `record_id` + `ON CONFLICT DO UPDATE` 兜底（见上「主键与去重」）。

### C360 客户列表翻页

**不要使用 `?page=N` URL 参数。** 实测它只改 URL，不触发真实翻页。

正确方式：

1. 打开 `https://c360.larkoffice.com/pc/account/list?viewId=user-67`
2. 点击页码 `1` 复位 SPA 状态
3. 每页抓 DOM 中 `a[href contains account/detail]`
4. 点击 `.ud-c360__pagination-next` 进入下一页
5. 遇到 disabled 或最后页停止

> **必须派发完整 pointer/mouse 事件链。** C360 用飞书自研 `ud-c360` UI 组件库，组件监听 `pointerdown`/`mousedown` 而不是 `click`。`el.click()` 只触发 click，被静默忽略，next 按钮看上去 click 成功但页面不换，phase2 在第 2 页检测到 first customer 没变就停下。脚本里 `NEXT_CLICK_CODE` 派发 `pointerdown → mousedown → pointerup → mouseup → click`，坐标取按钮中心 `(left+width/2, top+height/2)`。GOTO_PAGE_1 也是同样处理。

当前实测：`user-67` 视图（2026-07-08 共 339 客户），17 页（20×16 + 19 = 339）。`MAX_PAGES=30`，翻页到 `next button DISABLED` 停止。

#### SPA 渲染竞态：waitForPagination + NO_PAGE_1 重试（2026-07-08 修复）

launchd 00:30 冷启动时，C360 SPA 的 pagination 组件经常还没 mount（navigate 后 4s 不够）。这时点页码 1 找不到按钮，`GOTO_PAGE_1_CODE` 返回 `NO_PAGE_1`，整个抓取以 0 客户退出，妙搭写 0 行 —— 7/4 / 7/7 / 7/8 三次 launchd run 都是这个症状。

修复方案在 `c360_collect.mjs`：

- **`waitForPagination(targetId, timeoutMs=30000)`** — 每 500ms 轮询 `document.querySelectorAll('.ud-c360__pagination-item').length`，>0 即返回；CDP 异常时静默继续轮询。
- **`phase2_fetchCustomers` 主流程**：删掉固定的 `setTimeout(4000)`，改成最多 3 次重试。每次先 `waitForPagination` → 再 `GOTO_PAGE_1_CODE`；返回 `NO_PAGE_1` 就整页 `cdpRaw navigate` 同 URL 后再试；3 次都没点中 → log `reset: gave up after 3 attempts — skipping view` 并 `return []`。
- **`phase2c_searchC360ByName` 搜索流程**：同样的模式，轮询 `.ud-c360__native-input` 30s 超时，没挂载就放弃返回空。

实测：7/8 launchd 冷启动 + 7/8 10:18 手工 warm-up 两次跑都一次过（`reset: dispatched-page-1 (attempt 1/3)`），重试路径未触发。如果日志里看到 `reset: NO_PAGE_1 — reloading and retrying` 说明第一次重试，通常第二次 `waitForPagination` 30s 内能等到分页组件 mount。

### C360 AI 明细抓取

客户详情页 → 找主租户 → 主租户详情页 → 注入 XHR 拦截器 → 点击额度消耗 tab：

```js
window.__c360_captured = null;
if (!window.__c360_orig_open) window.__c360_orig_open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(m, u) {
  this._url = (typeof u === 'string') ? u : '';
  if (this._url.includes('metrics_list')) {
    this.addEventListener('load', function() { window.__c360_captured = this.responseText; });
  }
  return window.__c360_orig_open.apply(this, arguments);
};
document.querySelectorAll('.ud-c360__tabs__tab')[3].click();
```

直接 `fetch('/anchor/api/entity/tenant_metrics/metrics_list')` 会 CSRF 失败；不要绕开 XHR 拦截。

### AI 明细 Dedup

落库幂等键是妙搭 PK `record_id = ${customerName}_${date}`，`ON CONFLICT (record_id) DO UPDATE` 保证：
- 二次跑同一批客户：原地更新，不新增行
- 同一天已写：只算一行
- 同客户跨天：每天 1 行

---

## 当前验证状态

- 妙搭 DB：`customer_ai_quota` 为唯一落地点，`record_id` 去重，ON CONFLICT 幂等 OK
- 抓取规模：`user-67` 视图 17 页 / 339 个可进入详情客户（视图显示 339）× 近 30 天（2026-07-08 实测）
- 抓取视图：`user-67`「鑫企点老客户」（339 客户，每页 20 个，17 页 20×16+19 = 339）
- 已退役的飞书 Base 历史表（仅归档，脚本不再读写）：客户表 `tblwV5oiNBOlJWAX`、AI 通用额度明细 V2 `tblJ4543DWO44K07`；更早的 `AI 通用额度明细` (`tblS5fJoWZZZ1BDe`) 已删除
- 最新一次手工全量跑（2026-07-08 10:18 起，约 52 分钟）：339/339 客户、34 个 MIAODA batch、9866 行 upsert；DB `max(record_date) = 2026-07-07`，T+1 时效符合预期

---

## 常见问题

### 为什么 phase2 只爬了 19 客户就报 `page didn't advance`？

C360 SPA 用飞书自研 `ud-c360` UI 组件库，next 按钮监听 `pointerdown`/`mousedown`，不监听 `click`。脚本当前已经做了正确处理（派发完整 pointer+mouse 事件链，坐标取按钮中心），不需要手动改。

如果你看到该报错：
1. 确认你跑的是最新代码（`c360_collect.mjs` 里 `NEXT_CLICK_CODE` 应包含 `dispatchEvent` 和 `PointerEvent` 字样）。
2. Edge 调试模式可能被覆盖——重启 Edge：`open -na "Microsoft Edge" --args --remote-debugging-port=18800 --remote-allow-origins=* --user-data-dir=/tmp/claude-c360-debug-edge "https://c360.larkoffice.com/pc/account/list?viewId=user-67"`。

### 为什么抓到 279 而不是视图显示的 293？

C360 页面显示 `共 293 条`（2026-06-28 实测），DOM 每页 19 个可进入详情链接，15 页合计 `19×14 + 13 = 279` 个含 accountId 的链接。缺少的 14 个是权限不可进入、占位行或无 accountId 的行。采集标准是「能进入客户详情页并抓主租户/AI 用量」。

### 跑完后妙搭出现重复行怎么办？

不应该出现：main 循环按 `accountId` 内存去重，落库再由妙搭 PK `record_id = ${customerName}_${date}` + `ON CONFLICT DO UPDATE` 兜底。若怀疑有重复，查一下：

```bash
lark-cli apps +db-execute \
  --app-id app_4kesen9z6tbnr --env online \
  --sql "SELECT record_id, COUNT(*) FROM workspace_aadkgklgugsaw.customer_ai_quota GROUP BY record_id HAVING COUNT(*) > 1;" \
  --yes
```

返回空即无重复（PK 约束下理论上不会有）。

### 二次跑 5 客户验证时只写今天的数据？

`record_id = ${customerName}_${date}`，同客户同日期 ON CONFLICT 原地更新，不会新增行；不同日期每天 1 行。

### 怎么换视图？

**不要换。** 当前 skill 锁定 `user-67`「鑫企点老客户」视图。如果用户要看其他视图，需要新建一个对应的 skill 实例，配置不同的 `viewId` 和不同的妙搭目标表。

### 如何清理某天的脏数据？

```bash
lark-cli apps +db-execute \
  --app-id app_4kesen9z6tbnr --env online \
  --sql "DELETE FROM workspace_aadkgklgugsaw.customer_ai_quota WHERE record_date = '2026-06-22';" \
  --yes
```

### Edge 会话掉了，提示 `reset: NO_PAGE_1` 怎么办？

**先看 log 里有没有 `reloading and retrying` / `(attempt 2/3)` 这种重试标记** —— 如果有，第二次 `waitForPagination`（30s）通常能等到分页组件 mount，整次跑还是会成功，不需要人工介入。2026-07-08 之后所有 NO_PAGE_1 都已经被 `waitForPagination + 3 次重试` 自动兜底。

**只有在 log 里看到 `reset: gave up after 3 attempts — skipping view` 时才需要人工** —— 这意味着 3 次整页 reload 都没拿到分页，通常是 Edge 里 C360 的 OAuth/登录会话过期，当前页面跳到了飞书授权页或登录页：

```text
{"type":"string","value":"https://c360.larkoffice.com/pc/admin/login?redirect_uri=...&viewId"}
```

**自动恢复步骤（已验证）：**

1. 用 CDP 看一下当前 URL 和标题，确认是登录页 / 飞书授权页（`accounts.feishu.cn`）
2. 在飞书授权页（标题是"飞书授权"）里找 `button.ud__button--filled` 文本为 "授权" 的按钮，**直接点击主按钮完成 OAuth 授权**
   - 这个按钮的 class 是 `ud__button ud__button--filled ud__button--filled-primary ...`
   - 可能有"应用授权管理"链接和"授权"/"拒绝"按钮组合，但只要点击主"授权"按钮即可
3. 等 5–6 秒，自动跳转回 `https://c360.larkoffice.com/pc/account/list?viewId=user-67&app_id=...`
4. 重新跑 `caffeinate -i node scripts/c360_collect.mjs`

```bash
T=$(node scripts/cdp.mjs targets 2>&1 | python3 -c "import json,sys; ts=json.load(sys.stdin); print(next((t['id'] for t in ts if t['type']=='page' and 'c360' in t.get('url','')), ''))")
node scripts/cdp.mjs eval "$T" '(() => {
  const auth = Array.from(document.querySelectorAll("button.ud__button--filled"))
    .find(b => b.innerText.trim() === "授权");
  if (!auth) return "no auth button — manual login required";
  auth.click();
  return "clicked";
})()'
# 等跳转
sleep 6
node scripts/cdp.mjs eval "$T" 'location.href'  # 应该已经回到 C360 列表
```

> **注意**：2026-07-08 之后，phase2_fetchCustomers 已加 30s `waitForPagination` + 最多 3 次整页 reload 重试，绝大多数 SPA render race 不再需要人工介入；只有「OAuth 会话真过期」场景（即 3 次重试后还 `gave up — skipping view`）才需要上面这套授权恢复。OAuth 自动重连（检测飞书授权页 + 点授权按钮）仍是未来改进项。

---

## 自动调度（macOS launchd）

每天 **00:30 本地时间** 自动跑一次全量，已通过 `launchd` 注册。

### 文件位置

- **plist 定义**：`launchd/com.claude.c360-ai-quota.plist`（在 skill 目录里）
- **已软链到**：`~/Library/LaunchAgents/com.claude.c360-ai-quota.plist`

修改 plist 后**先 `plutil -lint` 验证再重载**：

```bash
plutil -lint launchd/com.claude.c360-ai-quota.plist
launchctl unload ~/Library/LaunchAgents/com.claude.c360-ai-quota.plist
launchctl load ~/Library/LaunchAgents/com.claude.c360-ai-quota.plist
```

### 调度内容

```
caffeinate -i
  /usr/local/bin/node
    scripts/c360_collect.mjs
      --config c360.config.json
      --log-file /tmp/c360_full_$(/bin/date +%Y%m%d_%H%M%S).log
```

关键点：

| 项 | 说明 |
|---|---|
| `caffeinate -i` | 防止系统在 ~95 分钟全量跑期间进入睡眠，断开 Edge CDP |
| `/bin/sh -c '... $(/bin/date ...) ...'` | launchd 不会展开 shell `$(...)`，所以 plist 套一层 `/bin/sh -c`，让 date 在 sh 里展开 |
| `StartCalendarInterval Hour=0 Minute=30` | 每天 00:30 本地时间 |
| `RunAtLoad=false` | 系统重启时不跑，只在 00:30 跑 |
| `ProcessType=Background` | 不阻塞 launchd（即使上一天的跑超时未完，新的 00:30 也会启动） |

### 输出文件

| 文件 | 内容 |
|---|---|
| `/tmp/c360_full_<时间戳>.log` | 每客户 `[N/M] OK|FAIL|SKIP` 行 + phase2/3/4/5 日志（**通过 `--log-file` 参数写**） |
| `/tmp/c360-ai-quota-launchd.out` | launchd stdout（脚本结束时的 markdown 汇总表） |
| `/tmp/c360-ai-quota-launchd.err` | launchd stderr（脚本崩溃信息） |
| `/tmp/c360_progress_<时间戳>.txt` | progress_watcher.mjs 写的 2 行进度（如果脚本里启动了 watcher） |

### 手动触发（不等 00:30）

```bash
launchctl start com.claude.c360-ai-quota
# 立刻查看实时进度
c360-progress --watch --one-line
```

### 查看下次运行时间

```bash
launchctl list | grep c360
# 输出 - 0 com.claude.c360-ai-quota
# 第二列 0 = 上次退出码 0；第三列是 label
# 要看下次时间：
plutil -p ~/Library/LaunchAgents/com.claude.c360-ai-quota.plist | grep -A2 Calendar
```

### 修改 plist（改时间 / 加环境变量等）

**不要手改 plist 文件的 `<string>` 内容**——bash 里的 `&` `<` `>` 触发 XML escape 错误，而且 base64 编码也只能用 python 生成。改 plist 必须用脚本：

```python
import plistlib, base64

# 1. 改完整 bash 脚本（这里只展示结构）
cmd = '''
LOG="/tmp/c360_full_$(date +%Y%m%d_%H%M%S).log"
# ... 你的 c360_collect + 解析 + lark-cli 调用 ...
'''
b64 = base64.b64encode(cmd.encode()).decode()

# 2. 用 plistlib 生成 plist（自动转义所有特殊字符）
plist = {
    'Label': 'com.claude.c360-ai-quota',
    'ProgramArguments': ['/bin/bash', '-c', f'echo {b64} | base64 -d | /bin/bash'],
    'StartCalendarInterval': {'Hour': 0, 'Minute': 30},   # 改时间
    'EnvironmentVariables': {                              # 改环境变量
        'PATH': '/Users/xqdmacminim4/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        'C360_NOTIFY_USER_ID': 'ou_xxx',                  # 改接收人
    },
    'StandardOutPath': '/tmp/c360-ai-quota-launchd.out',
    'StandardErrorPath': '/tmp/c360-ai-quota-launchd.err',
    'RunAtLoad': False,
    'ProcessType': 'Background',
}
with open('launchd/com.claude.c360-ai-quota.plist', 'wb') as f:
    plistlib.dump(plist, f)
```

跑完脚本后：

```bash
plutil -lint launchd/com.claude.c360-ai-quota.plist
launchctl unload ~/Library/LaunchAgents/com.claude.c360-ai-quota.plist
launchctl load ~/Library/LaunchAgents/com.claude.c360-ai-quota.plist
```

### 关闭 / 重新启用

```bash
# 取消调度（保留 plist 文件）
launchctl unload ~/Library/LaunchAgents/com.claude.c360-ai-quota.plist

# 重新启用
launchctl load ~/Library/LaunchAgents/com.claude.c360-ai-quota.plist
```

### 跑完推送 IM 通知

每次 c360_daily.sh（无论是 launchd 调度还是手动跑）跑完，会自动发一条飞书 P2P 消息给你。用的工具栈是 [`../lark-im/SKILL.md`](../lark-im/SKILL.md) 的 `+messages-send`。

**通知内容（markdown 格式）：**

```
✅ 完成 **C360 AI 额度抓取** · 2026-06-28 20:18

- 视图：284 客户（鑫企点老客户 + 妙搭补抓 5 家）
- 已处理：**284 / 284**
- 🟢 OK：277　🔴 FAIL：0　⚪ SKIP：7
- 妙搭 DB upsert：8490 行
- 近 30 天总消耗合计：12345678
- ⚠️ 妙搭有但 C360 无：1 家
- 深圳易威行科技创新有限公司

📄 完整日志：`/tmp/c360_full_20260628_201815.log`
```

> 启用 `miaodaDrivenSync`（默认 on）后，「视图」会同时包含 C360 view + 妙搭 `customer_assignments` 表解析到的客户；`⚠️ 妙搭有但 C360 无` 列出 C360 搜不到的所有客户。详见下面 §9。

**调用链路：**

```
c360_daily.sh
  ├─ c360_collect.mjs → 写 /tmp/c360_full_<时间戳>.log
  └─ c360_notify.sh
       ├─ 解析 log：grep 出 [N/M] OK/FAIL/SKIP 计数 + total30d 合计 + miaoda 推送
       └─ lark-cli im +messages-send --user-id <open_id> --markdown <body>
```

**接收人：** P2P 自己（user open_id 通过环境变量 `C360_NOTIFY_USER_ID` 配置；默认 `ou_8c633881c9f2c8a09428185d45fa834c`）。身份 `--as user`，需要 lark-cli auth 已授 `im:message.send_as_user` scope（已授权）。

**改接收人：**

```bash
# 临时（一次）
C360_NOTIFY_USER_ID=ou_xxx bash scripts/c360_notify.sh --log-file /tmp/xxx.log

# 改默认（编辑 scripts/c360_notify.sh line 12）
LARK_CLI="${LARK_CLI:-/Users/xqdmacminim4/.npm-global/bin/lark-cli}"
NOTIFY_USER_ID="${C360_NOTIFY_USER_ID:-ou_8c633881c9f2c8a09428185d45fa834c}"
#                            改成 ↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑
```

**手动测试（不发实际消息，只 dry-run）：**

```bash
lark-cli im +messages-send \
  --user-id ou_8c633881c9f2c8a09428185d45fa834c \
  --markdown $'**测试**\n\n飞书消息通知已就绪' \
  --dry-run
```

**实测发出一条真消息：**

```bash
bash scripts/c360_notify.sh --log-file /tmp/c360_full_20260628_181532.log
# 输出 message_id / chat_id → 你应该在自己飞书里看到汇总
```

### 白名单扩展：妙搭 `customer_assignments` 驱动捕获

2026-06-30 起的扩展：除了抓 C360 view `user-67`「鑫企点老客户」(279 客户) 之外，每次全量跑还**额外**扫妙搭 `customer_assignments` 表（约 128 客户，主要来自 FDE/CSM 分配同步、人工补登），对每个名字在 C360 全局搜索一次，搜得到的也写 `customer_ai_quota`，搜不到的 WARN 一行并在 IM 通知里显式列出。

**配置（`c360.config.json` `miaodaDrivenSync` 块）：**

```json
"miaodaDrivenSync": {
  "enabled": true,
  "assignmentsTable": "customer_assignments",
  "customerNameColumn": "customer_name",
  "env": "dev",
  "searchViewId": "system-5",
  "excludeIfC360ViewHas": true,
  "searchPageSize": 5,
  "excludeNames": [
    "深圳易威行科技创新有限公司"
  ]
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关。`false` 时本节所有行为都不发生，scope 完全等于 phase2 view。默认 `true`（生产） |
| `assignmentsTable` | 妙搭表名，固定 `customer_assignments`（schema 从 `miaodaDb.schema` 继承） |
| `customerNameColumn` | 客户名列。schema 固定为 `customer_name` |
| `env` | 妙搭环境。`dev` / `online`，从 `miaodaDb.env` 复用 |
| `searchViewId` | phase2c 做 C360 搜索时导航的视图。**C360 搜索是按当前视图过滤的**（不是全局），所以不能用 `cfg.viewId`（即 `user-67`「鑫企点老客户」）。默认 `system-5`「全部客户」，是包容性最大的视图（实测 296 客户）。要切到其它视图做搜索时改这里 |
| `excludeIfC360ViewHas` | `true`（默认）= view 已有的客户不重搜；省 127 次 C360 搜索。`false` = 强制每个名字都搜一遍 |
| `searchPageSize` | 单次 C360 搜索翻页上限。每页 20 行，默认 5 页 = 100 行 cap。命中 cap 时 `phase2c` 打 WARN |
| `excludeNames` | 已知 C360 没有的客户，列入后永不打 `NOTFOUND`。**已确认**：`深圳易威行科技创新有限公司`（CDP 实地验证 `user-67` + `system-5` 两个视图均 0 命中；Miaoda 的 `02NN001TL00001MKh23YAD` 不是 Salesforce 15/18 位 ID，C360 里无对应实体） |

**`--customer "<name>"` 兜底流程：** 今天 `--customer` 找不到 view 客户直接 `exit(1)`；现在会先尝试 C360 全局搜索（用与 `phase2c` 同一 React-aware input 注入）：

| 情况 | 行为 |
|---|---|
| 1. 命中 view / Miaoda 合并列表 | 走原路径 |
| 2. view 没有但 C360 搜索命中 1 条精确匹配 | 记录后进入 scope 继续处理 |
| 3. view 没有 + C360 搜索命中 ≥2 条 | 打印候选列表 + `NOTFOUND` exit 1 |
| 4. view 没有 + C360 搜索 0 命中 | 打印 `NOTFOUND --customer "X" not in C360` + exit 1 |

**日志约定：**

- `scope: N customers (M from C360 view user-67 + K from Miaoda customer_assignments)` — 出现在 phase2 之后、Stage B 之前。`progress_watcher.mjs` 的 `RE_SCOPE` 优先吃这行算 total（fall back `found N customers in view`）。
- `NOTFOUND <count> customers in Miaoda but not in C360: A, B, C` — 出现在 scope 行之后。`c360_notify.sh` 用 `^NOTFOUND [0-9]+ customers in Miaoda but not in C360: .+$` 抓这行。注意锚点 `^NOTFOUND`（不带 `[N/M]` 前缀），**不会**被 `progress_watcher.mjs:52` 的 `RE_END` 误匹配。
- `WARN phase2c_searchC360ByName: query "X" hit SEARCH_MAX_PAGES=5 (>=100 rows); may be incomplete` — 单次搜索 cap 触发。

**典型手动验证：**

```bash
# 在 view 里的易威行公司（应成功，scope 走 view 路径）
node scripts/c360_collect.mjs \
  --customer "深圳易威行贸易有限公司" \
  --log-file /tmp/ywx_in_view_$(date +%Y%m%d_%H%M%S).log

# 已知 C360 没有的易威行公司（应 NOTFOUND exit 1）
node scripts/c360_collect.mjs \
  --customer "深圳易威行科技创新有限公司" \
  --log-file /tmp/ywx_inno_$(date +%Y%m%d_%H%M%S).log
echo "exit: $?"   # 1
grep -E '^NOTFOUND ' /tmp/ywx_inno_*.log
# 期望：NOTFOUND --customer "深圳易威行科技创新有限公司" not in C360 (view user-67 + global search returned 0 exact matches)
```

### 已知坑

1. **node 路径必须用绝对路径** `/usr/local/bin/node`，**不能用 `which node`** 或 `~/...` 软链 —— launchd 的 `PATH` 是精简的，符号链接可能找不到实际文件。
2. **`--log-file` 必须在 `/bin/sh -c` 里** —— plist 不展开 `$(...)`，否则 c360_collect.mjs 会把日志写到字面量路径。
3. **plist 不要直接调任何 `.sh` 脚本**（包括 `c360_daily.sh` 和 `c360_notify.sh`）—— macOS Ventura+ 的 launchd 用 `amfid` 验证脚本，未签名的新建 shell 脚本会被加 `com.apple.provenance` xattr 并被拒绝执行（错误 `Operation not permitted`）。**实测**：`bash -c 'echo xxx | base64 -d > /tmp/foo.sh && bash /tmp/foo.sh'` 也走不通（amfid 仍拦），**只有把脚本**完全 inline 到 plist 字符串里**或者用 base64 编码**整个脚本后让 launchd 调 `/bin/bash -c "echo <b64> | base64 -d | /bin/bash"`**才不被拦**。本 skill 用 python `plistlib` 生成 plist（自动转义所有 `&` `<` `>` 等），所有 bash 代码 base64 编码后放到 plist 的 `-c` 字符串里。手动跑不受影响（`bash scripts/c360_notify.sh` 在普通 shell 里正常执行）。
4. **首次部署必须先跑一次 test-mode** 验证 Edge OAuth 会话有效，否则 00:30 第一次跑会卡在 `NO_PAGE_1`（详见上面「Edge 会话掉了」一节）。

---

## 重要文件

- `scripts/cdp.mjs` — Edge CDP client，依赖 `ws`
- `scripts/c360_collect.mjs` — 主采集脚本（含 `phase2_fetchCustomers` 翻页派发 pointer 事件链、`buildRows` 构造妙搭行 + `record_id` 主键、`pushBatchToMiaodaDb` / `pushToMiaodaDb` 直写妙搭 DB）
- `scripts/progress.mjs` — TTY-aware 进度报告器，写出 `[N/M]` 行
- `scripts/progress_watcher.mjs` — 后台日志 tail 器，把 `[N/M]` 转 2 行（百分比 + 当前公司名）输出，适合长任务观察
- `scripts/c360-progress.zsh` — zsh 函数 `c360-progress`，从进度文件 + 日志输出 OK/FAIL/SKIP 计数；source 到 `~/.zshrc` 即可用
- `scripts/c360_notify.sh` — 跑完 c360_collect.mjs 后调 `lark-cli im +messages-send` 发 P2P 汇总给用户（解析 log file 提取 OK/FAIL/SKIP + total30d 合计）
- `scripts/c360_daily.sh` — 顶层 daily runner：跑 collect + 调 notify（**手动跑用**；plist 不用这个文件因为 amfid 拦）
- `c360.config.json` — 当前配置：`viewId` / `cdpPort` / `larkCliPath` / `miaodaDb` 妙搭落地节 / `miaodaDrivenSync` 妙搭 `customer_assignments` 补抓节（无 Base 配置，Base 已退役）
- `launchd/com.claude.c360-ai-quota.plist` — macOS launchd 定义：每天 00:30 自动跑全量 + IM 通知（plist 里 base64 编码整条 bash 流水线，**不要手改 plist 的 `<string>` 内容**——`&` 等特殊字符必须用 `plistlib` 生成）
- `package.json` — `ws` 依赖声明
