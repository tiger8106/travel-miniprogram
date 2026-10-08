# 🧳 微信旅游小程序

基于微信云开发的旅游攻略小程序。上传 .docx 攻略文档，AI 自动解析生成每日行程、旅行提醒和旅行建议；点击行程中的"从 A 到 B"按钮直接跳转高德地图；提醒事项会按办理时间和用户设置的提前量触发。

> 出品：阿稳 🧰  
> 最后更新：2026-09-27

---

## ✨ 核心功能

- 📤 **攻略解析**：上传 .docx 攻略 → AI 自动生成结构化每日行程
- 🧭 **制定新攻略**：先生成路线大纲，再后台分轮细化；首页显示进度，完成后自动补齐提醒和建议
- 📅 **每日行程**：清晰展示每天的活动安排，支持编辑/新增/删除
- ⏰ **旅行提醒**：自动提取车票、酒店、门票、预约和行前准备事项，按类别保存并提醒
- 💡 **旅行建议**：AI 生成天气、装备、必吃、注意事项等实用建议
- 🗺️ **高德地图导航**：行程涉及跨城移动时，一键跳转高德地图，自动填入起终点
- 👥 **多用户**：每个用户用 openid 隔离数据，互不干扰

---

## 🏗️ 架构

```
travel-miniprogram/
├── miniprogram/                  # 前端
│   ├── pages/                    # 7 个页面
│   │   ├── index/                # 首页 - 行程概览 + 提醒一览
│   │   ├── itinerary/            # 每日行程详情（可编辑）
│   │   ├── upload/               # 上传攻略
│   │   ├── tickets/              # 旅行提醒列表（可编辑）
│   │   ├── suggestions/          # 旅行建议
│   │   ├── mine/                 # 个人中心
│   │   └── webmap/               # 高德地图 web-view
│   ├── components/               # 4 个自定义组件
│   │   ├── day-card/             # 行程卡
│   │   ├── activity-item/        # 行程项（含编辑）
│   │   ├── ticket-alarm/         # 提醒卡片（含编辑和完成状态）
│   │   └── map-button/           # 地图跳转按钮
│   ├── utils/                    # request / auth / time / map / alarm
│   └── services/                 # API 服务层
└── cloudfunctions/               # 云函数（多用户后端）
    ├── login/                    # 微信登录拿 openid
    ├── parseTravelPlan/          # 解析 docx + LLM 生成结构化行程
    ├── generatePlan/             # 制定新攻略、后台续跑、12306 班次核对
    ├── genWorker/                # 定时接力后台生成任务
    ├── itinerary/                # 行程 CRUD
    ├── ticketAlarm/              # 闹钟 CRUD
    ├── suggestions/              # 旅行建议 get / refresh
    ├── initdb/                   # 初始化 trips、gen_jobs、schedule_cache 等集合
    └── sendAlarm/                # 定时触发器（每分钟检查推送）
```

### 数据流

1. **上传流程**：用户选择 .docx → `uploadDoc` 上传到云存储 → `parseTravelPlan` 云函数下载 → mammoth 解析 → LLM 生成 JSON → 入库
2. **制定攻略**：前端生成大纲 → `generatePlan` 创建生成中占位行程 → `genWorker` 与前端共同续跑 → 每轮写回进度 → 完成后从大纲和最终详细行程补齐提醒与建议；12306 官方候选用于校准车次和时间
3. **行程展示**：前端先拉摘要列表，只拉当前攻略的完整条目 → 渲染每日行程卡片 → 可编辑/导航/删除；生成中的条目只读
4. **提醒触发**：
   - **前台**：`utils/alarm.js` 每 30 秒轮询，按每条事项的提前量和办理时刻各提醒一次
   - **后台**：`sendAlarm` 云函数每分钟跑一次，按 `remindAt` 推送订阅消息

### 提醒事项模型

提醒记录中的 `fireAt` 表示目标办理时刻，例如 12306 起售时刻、门票放票时刻或酒店预订时刻；`leadMinutes` 是用户设置的提前分钟数；`remindAt` 始终由 `fireAt - leadMinutes` 计算。前端和后台都按这套含义处理，避免把“提前提醒时间”误当成“实际办理时间”。如果来源没有给出明确放票时刻，规则会先用当地常见时刻建立待办，并在备注中要求用户以官方公告核对；用户可以直接编辑办理/放票时间。

每条提醒都有 `type` 分类（`train`、`plane`、`bus`、`ticket`、`hotel`、`other`）和 `completed` 完成状态。完成后从首页“正在进行 / 即将进行”移出，但分类清单仍保留，可以查看或恢复待办。重新生成攻略时会按事项 key 复用原记录，保留 `_id`、完成状态和提前量；被新攻略删掉的已完成事项也作为历史记录保留。

生成时会从 AI 提名、行程大纲和最终详细行程三层补齐车票、住宿、门票预约和证件/装备等事项。火车票开票日按乘车日减 14 天计算，具体起售时刻仍以 12306 当日公告为准；生成的车次和乘车时刻只有在 12306 官方查询命中时才写入，查不到就标记待核实并清除模型臆造值。

## 🌿 分支说明与开发约定

当前仓库使用三个主要分支：

| 分支 | 用途 | 开发约定 |
|---|---|---|
| `main` | 线上稳定版本 | 只保留已发布、可回滚的代码，不直接进行日常开发 |
| `1.0.0` | 1.0.0 版本备份 | 固定指向刚发布的 1.0.0 版本，用于回溯、对比和紧急修复基线 |
| `develop` | 下一个版本开发 | 日常功能开发、修复和联调都在此分支进行 |

三个分支当前均从发布提交 `f5a2d3c` 建立。后续开发流程：

1. 从 `develop` 创建功能分支进行较大改动，完成后合并回 `develop`。
2. 下一个版本准备发布时，从 `develop` 创建对应版本备份分支，例如 `1.1.0`，并确认测试通过。
3. 发布确认后，将发布提交合并到 `main`，并保留版本分支作为该版本的固定备份。
4. 日常开发前先同步远程并切换到开发分支：

   ```bash
   git fetch origin
   git switch develop
   git pull --ff-only
   ```

不要直接在 `1.0.0` 或 `main` 上开发；如果需要修复已发布版本，应从对应版本分支创建临时修复分支，验证后再按发布流程合并。

---

## 🚀 部署步骤

### 0. 当前状态（mock 模式）

如果只是想本地看 UI，**不需要做任何下面这些事**。`USE_MOCK=true` 直接跑就行。

下面是"真的让 LLM 跑起来"的完整流程，按顺序做完即可。

### 1. 准备工作

- 微信开发者账号（已认证）
- 微信开发者工具：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
- 一个 AppID（个人测试可用「测试号」，正式上线需注册）
- 一个大模型 API Key（DeepSeek / 通义 / OpenAI / 腾讯混元 任选）

### 2. 开通云开发

1. 微信开发者工具打开本项目（导入项目 → 选择 `travel-miniprogram` 目录）
2. 点左上角「云开发」按钮 → 开通云开发（免费版即可）
3. 记下云开发环境 ID（形如 `myenv-abc123`）
4. **填到 `miniprogram/app.js` 顶部的 `CLOUD_ENV_ID` 常量**（不填会临时走默认环境，控制台会打 warning）

### 3. 配置云函数环境变量

**只给需要 LLM 的函数配**：`parseTravelPlan` 和 `suggestions`。

云开发控制台 → 云函数 → 选函数 → 「函数配置」→「环境变量」：

**方案 A：通义千问 Qwen 3.5 Plus（推荐）**
```
LLM_PROVIDER=qwen
LLM_API_KEY=<你的 DashScope API Key>
LLM_MODEL=qwen3.5-plus
```

**方案 B：MiniMax-M3**（如果 MiniMax 对外开放了 API）
```
LLM_PROVIDER=minimax
LLM_API_KEY=<你的 MiniMax API Key>
LLM_MODEL=MiniMax-M3
LLM_BASE_URL=https://api.minimaxi.com/v1   ← 默认值，若不通改这里
```

**变量说明**：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | ✅ | `deepseek` / `openai` / `qwen` / `hunyuan` / `minimax` |
| `LLM_API_KEY` | ✅ | 你的 API Key |
| `LLM_BASE_URL` | ⛔ | 自定义时填，否则按 provider 推断 |
| `LLM_MODEL` | ⛔ | 自定义模型名（如 `qwen3.5-plus` / `MiniMax-M3`） |
| `AMAP_KEY` | ✅ | 高德地图 Web 服务 Key（地理编码与导航定位） |
| `SUBSCRIBE_TEMPLATE_ID` | ⛔ | 订阅消息模板 ID（闹钟后台推送用） |

### 4. 上传云函数

右键 `cloudfunctions/login` → 上传并部署：云端安装依赖  
右键 `cloudfunctions/parseTravelPlan` → 上传并部署：云端安装依赖（mammoth）  
右键 `cloudfunctions/generatePlan` → 上传并部署：云端安装依赖
右键 `cloudfunctions/genWorker` → 上传并部署：云端安装依赖
右键 `cloudfunctions/itinerary` → 上传并部署  
右键 `cloudfunctions/ticketAlarm` → 上传并部署  
右键 `cloudfunctions/suggestions` → 上传并部署  
右键 `cloudfunctions/initdb` → 上传并部署
右键 `cloudfunctions/sendAlarm` → 上传并部署

云函数请逐个上传，等开发者工具中上一个函数离开 `Updating` 状态后再上传下一个；并发上传会触发腾讯云 `FailedOperation.UpdateFunctionCode`。本次提醒改造涉及 `generatePlan`（`v1.8-stateful-reminders`）、`parseTravelPlan`（`v3.9-stateful-reminders`）、`ticketAlarm`（`v1.2-stateful-reminders`）和 `sendAlarm`（`v4-stateful-reminders`），四个函数都要重新部署并在日志中核对版本。若提示函数处于 `Updating`，等待状态恢复为可用后再上传，避免重复提交覆盖中的版本。

首次部署或更换云环境后，在开发者工具控制台调用一次 `initdb`。它会创建 `trips`、`gen_jobs`、`schedule_cache` 等集合；生成函数也会在缺集合时自动兜底创建，但初始化一次更容易检查权限和环境是否正确。

### 5. 配置定时触发器（闹钟推送）

云开发控制台 → 云函数 → `sendAlarm` → 触发器 → 创建触发器：

- 触发周期：定时触发
- Cron 表达式：`0 * * * * * *`（每分钟）

### 6. 申请订阅消息模板（可选）

小程序后台 → 订阅消息 → 公共模板库 → 搜索"提醒" → 选一个合适的模板，记下模板 ID 填到上面环境变量。

### 7. 准备 tabBar 图标

`miniprogram/images/` 下准备 8 张 81×81 PNG 图标（普通态 + 选中态各 4 个）。

或者临时删除 `app.json` 里的 `tabBar` 字段跳过这一步。

### 8. 修改 project.config.json

把 `appid` 字段改为你自己的 AppID。

### 9. 上传体验版

微信开发者工具 → 上传 → 设为体验版 → 扫码体验。

---

## 🧪 本地调试（不开通云开发）

**默认就是 mock 模式** —— `miniprogram/services/api.js` 顶部 `USE_MOCK = true`，所有 API 调用走本地 mock 数据，**不需要云开发**。

### 怎么用

1. 打开微信开发者工具 → 导入项目 → 选 `travel-miniprogram` 目录 → 填 AppID（可以是测试号）
2. 点"编译"按钮（或 Ctrl+B）
3. 模拟器立即显示完整行程（广西 7 天游 mock 数据）
4. 体验 5 个 tab、上传、闹钟、高德跳转等所有交互

### 切回真实云函数模式

只需改 2 处：

1. `miniprogram/services/api.js` → `const USE_MOCK = false;`
2. `miniprogram/app.js` → `const USE_MOCK = false;` + `CLOUD_ENV_ID = '你的真实环境ID'`

### mock 数据位置

`miniprogram/services/mock-data.js` —— 可直接改数据看效果，不需要重启服务。

### 🔬 测试 LLM Key 是否有效（不部署云函数）

不部署云函数也能验证两个 key 能不能用：

```bash
cd travel-miniprogram
node scripts/test-llm.js
```

会自动：
1. 读 `.env.local` 里的 LLM 配置
2. 连接到对应 LLM 服务（默认测 Qwen）
3. 测一次简单对话 + 一次完整攻略解析
4. 输出成功/失败信息

要测另一个 key（MiniMax），编辑 `.env.local` 把对应的 4 行取消注释 + 把 qwen 4 行注释掉，再次跑脚本。

---

## 🔑 LLM Provider 切换

`cloudfunctions/parseTravelPlan/llm.js` 已封装好兼容 OpenAI 格式的 LLM。切换：

```bash
# DeepSeek（中文强，便宜）
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxx
# 模型默认 deepseek-chat

# OpenAI
LLM_PROVIDER=openai
LLM_API_KEY=sk-xxx
# 模型默认 gpt-4o-mini

# 通义千问
LLM_PROVIDER=qwen
LLM_API_KEY=sk-xxx
# 模型默认 qwen-turbo

# 腾讯混元（云函数里走内网更快）
LLM_PROVIDER=hunyuan
LLM_API_KEY=sk-xxx
# 模型默认 hunyuan-pro
```

---

## 📝 数据库集合

云开发数据库会自动创建以下集合（首次写入时自动建）：

- `users` — 用户档案
- `trips` — 行程主表
- `ticket_alarms` — 旅行提醒事项（包含完成状态和分类）
- `suggestions` — 旅行建议

每个集合都按 `_openid` 隔离，自动多用户。

---

## 🐛 常见问题

**Q: LLM 解析不准确？**  
A: 攻略文档结构化越好，解析越准。建议在文档里按日期分段、时间明确、起终点清晰。

**Q: 高德地图跳转打不开？**  
A: 检查小程序后台「业务域名」配置 + 高德地图 URL 白名单。`uri.amap.com` 需要加白。

**Q: 提醒不震动？**
A: 小程序前台轮询只能在小程序运行时震动；锁屏提醒需要把事项同步到系统日历，后台订阅消息还需要用户授权并配置模板。

**Q: 云函数调用失败？**  
A: 检查云开发环境是否初始化、openid 是否注入（`wxContext.OPENID`）。

**Q: 开发者工具提示 `cloud init error: no baseresponse`？**
A: 这是小程序在 `wx.cloud.init` 阶段没有拿到云环境响应，常见原因是项目 AppID、云环境 ID、开发者工具当前选中的环境或登录账号不一致，也可能是网络/代理暂时无法访问云开发。当前项目的 AppID 在 `project.config.json`，环境 ID 在 `miniprogram/app.js` 顶部；两者必须属于同一个小程序和账号。打开开发者工具「云开发」，确认右上角环境与代码中的 `CLOUD_ENV_ID` 完全一致，确认环境仍可用后重新编译。代码现在会在初始化失败时停止后续云函数请求，并弹出当前 AppID、环境 ID 和排查步骤。

---

## 📄 License

MIT — 自由使用，改造成你的专属小程序。

---

_遇到问题不要硬扛，先在 issue 区复现路径，贴上云函数日志 + 客户端报错截图。_ 🧰
