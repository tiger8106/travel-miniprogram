# AGENT 开发手册 · travel-miniprogram

> 给后续接手本项目做开发的 AI Agent / 协作者看。
> **动手前先读完，尤其是「一、铁律」和「二、踩过的坑」。**
> 最后更新：2026-09-21（引擎版本 `v3.6-alarm-fix`）

---

## 一、铁律（必须遵守，不许打折）

### 1. Git 工作流：本地提交，不推远端

| 时机 | 动作 | 说明 |
|---|---|---|
| 每次改动跑通后 | `git add -A` + `git commit` | **必须做**，一个功能/一次修复一个提交 |
| 推送远端 | ❌ 默认**不做** | 用户要能随时 `git reset` 撤回重来 |
| 用户明确说「推送 / push / 上传 GitHub」 | ✅ 才推 | 每条指令只推一次，别顺手多推 |

远端：`git@github.com:tiger8106/travel-miniprogram.git`（origin）

提交信息格式（中文，简明）：
```
feat: 行程编辑支持底部抽屉式弹窗
fix: 闹钟时间多加了 8 小时（云函数 UTC 时区问题）
chore: 更新 agent.md
```

**绝对禁止**：`git push --force`、`git reset --hard` 丢弃用户未提交内容、帮用户删 `.workbuddy/`（那是项目记忆目录，不是缓存）。

### 2. 改完云函数 ≠ 生效

云函数改完必须**在微信开发者工具里右键 → 上传并部署（云端安装依赖）**，否则跑的还是旧代码。
验证是否部署成功：看日志里的版本标记
- `cloudfunctions/parseTravelPlan/index.js` → `PARSE_VERSION`（当前 `v3.6-alarm-fix`）
- `cloudfunctions/sendAlarm/index.js` → `DEPLOY_TAG`（当前 `v3-layout`）

改逻辑时**顺手把版本号 +1**，否则无法判断手机端跑的是哪一版。

### 3. 不要只依赖大模型，代码层必须有兜底

LLM 输出不可信、不稳定。凡是影响正确性的字段（时间、地点、导航、跨天上下文），
都要在 `normalize.js` 里做**确定性清洗**。改解析问题时优先改代码兜底，其次再调 prompt。

### 4. 交付前跑自检

```bash
node scripts/check-bindings.js
```
校验 wxml 绑定的 handler 是否都在 js 里实现、config 引用是否齐全、语法是否正确（50 条断言）。
**全绿才能说做完了。**

> ⚠️ 本机已知假报错：`JS 语法 xxx.js` 这 6 条在本机会因为 `spawnSync` 报 **EBUSY**（沙箱不允许脚本再启 node 子进程）而恒失败，
> 但这**不代表文件有语法错误**。验证方式：手动 `node --check miniprogram/<文件路径>` 通过即可。
> wxml/js 事件对齐部分不受影响，正常可信。**

---

## 二、踩过的坑（血泪清单，按复发概率排序）

### 🕐 时区：云函数 UTC，用户在中国（UTC+8）→ 曾经整体偏移 +8 小时

- 云函数**服务器跑 UTC**。`new Date("2026-09-21T15:15:00")` 会被当成 UTC 解析，存库再显示就多了 8 小时。
- 解决：`cloudfunctions/parseTravelPlan/cn-time.js`
  - `parseCnTime(s)` → 按**北京时间**解析字符串成时间戳
  - `tsToDateStr(ts)` → 按北京时间格式化
- 存闹钟时**同时存 `fireAtStr`（"YYYY-MM-DD HH:mm" 北京时间字符串）+ `fireAt`（时间戳）**。
- 小程序端 `utils/alarm.js` 的 `calcTriggerAt()` **优先用 `fireAtStr` 按手机本地时区重新解释**，
  这样用户换时区也对；并把修正后的 `fireAt` 回写云端。
- 原则：**最终展示/触发的时间，以用户手机所在时区为准。**

### 📢 微信订阅消息 47003（argument invalid）

- 报错形如 `data.date4.value is empty` 或 `argument invalid`。
- 原因：**模板字段编号和自己想的不一样**。用户实际模板是 `thing2 / date4 / time30 / thing11`，
  不是常见的 `thing1 / date2 / time3 / thing4`。
- 解决：`cloudfunctions/sendAlarm/index.js` 里的 `LAYOUTS` 表，把匹配用户模板的
  `H_thing2_date4_time30_thing11` **放在第一位**（代码按顺序尝试）。
- 调试入口：小程序 → 闹钟页 → **推送自检**（返回 deployTag / 模板尾号 / openid），
  以及闹钟卡片上的 **🔔 测试** 按钮（会真发一条订阅消息 + 弹完整链路 JSON）。
- 换模板时：把新模板的字段编号告诉 Agent，改 `LAYOUTS` 即可。

### 🎯 开发者工具不能进生产版

- `miniprogram/config.js` → `SHOW_DEV_TOOLS`
  - `'auto'`（推荐）：develop/trial 显示，release 自动隐藏
  - `true`：任何环境都显示（本地排查用）
  - `false`：任何环境都隐藏（提前演练正式版效果）
- 判断逻辑在 `miniprogram/utils/env.js`（读 `wx.getAccountInfoSync().miniProgram.envVersion`）。
- 新增调试入口时，**必须加 `wx:if="{{devMode}}"`**，别裸奔上线。

### 🔑 编辑/删除点不动：云端数据没有 `_id`

- 从云函数返回的对象**没有 `_id`**，用 `_id` 当 key 会导致 `editingId` 永远匹配不上。
- 解决：`pages/itinerary/itinerary.js` 的 `withItemKeys()` 给每项算**稳定 key**
  （日期+时间+标题+序号），`itemKeyOf()` 统一取用；`editingId` 初始化为 `''` 而不是 `null`。

### 🧭 导航链接：别造假的，别漏掉单头的

- `龙脊别院 → 龙脊别院` 这种**没发生移动的**，不生成导航。
- 只写了到达点（`到达重庆北站`）的**单头导航要保留**，起点从前一天/上一项的终点继承。
- 一句话里多段移动（`8:00 桂林站→金坑大寨 10:30 抵达…`）要**拆成多条顺序导航项**。
- 跨天：下一天的起点 = 上一天最后一个有位置的项。

### 🧭 从首页跳到某一天：必须传原始 `dayIndex`，不是数组下标

- `pages/index` 的 `days` 数组会**重排**（过期天沉到末尾），所以数组下标 ≠ 第几天。
- `itinerary` 页按 `(it.dayIndex||0) === dayIdx` 过滤，首页必须传 `days[idx].dayIndex`，
  传错就会打开错误的一天。统一走 `gotoDay(dayIndex)`，别再手写 navigateTo。

### 🧠 LLM 提取闹钟的三条硬规则（写在 prompt 里）

1. **标题必须用原文语言**，不许翻译成英文。
2. **`fireAt` 严格取自原文**（`9月21日15:15开抢` → `2026-09-21 15:15`），不许编。
3. **模糊日期跳过**（`X日起`、`前后`、`待定`）；只有日期没时间的，默认 09:00 / 20:00 并在备注说明；**去重**。

### ⏱️ 云函数 60 秒上限：生成类任务必须拆阶段

一次请求让 LLM 吐出「8 天大纲 + 8 天逐天详情」实测要 **80 秒**，必然超时。
`generatePlan` 因此拆成两次调用：`action=outline`（~28s）→ 前端确认 → `action=build`（~34s）。
新增任何"让 LLM 写很多"的功能，先估算输出 token×速率，超 40 秒就要拆。

### 🔔 闹钟不能让 LLM 算时间——只能让它提名

LLM 算抢票日期必翻车。正确姿势：`plan.js` 里用**确定性规则**算 fireAt
（12306 预售期 15 天含当日 → 乘车日 **减 14 天**；机票 -30 天；酒店出发前 7 天；门票 -7 天），
LLM 只负责提名"哪些事情要抢"。算出已经过去的日期时，若行程还没出发，降级成
"已进入抢票期"的近期提醒而不是丢掉。

### 🐛 其它小坑

- **chooseAvatar / type="nickname" 是隐私接口**（对应隐私指引「微信昵称、头像」，官方映射表明确列出）。
  开了 `__usePrivacyCheck__: true` 后，未授权时点击**静默无反应、无报错**——别以为是代码问题。
  解法：后台隐私指引勾「微信昵称、头像」+ 页面挂 privacy-popup 并在 onShow 注册 `app._privacyHandler`。
  （「头像昵称填写是用户主动填写、不算隐私接口」是错误认知，已踩过一次。）
- **chooseAvatar 按钮不要用 opacity:0 透明覆盖层**，直接让 button 当圆形容器（官方写法），
  并用 min/max-width/height 锁死尺寸——button 默认样式会把容器撑成椭圆。
- **昵称 bindinput 实时同步后，blur 保存判定要跟「云端已存值」比**（refresh 时存 this._saved），
  跟 data 比会因实时同步永远相等、永远不保存。
- 组件向页面传值：`this.triggerEvent('xxx', {...})`，页面取 `e.detail.xxx`。
- 小程序组件样式隔离：需要覆盖时显式设置 `styleIsolation`。
- `require` 别漏：曾经 `api-real.js` 少了 `require('../config')` 导致 `config is not defined`，
  `check-bindings.js` 已加守护，但新文件仍要自查。
- **Windows + PowerShell 中文输出乱码**：git/命令输出先 `Out-File -Encoding utf8` 写文件再读，
  别直接在终端看中文。Bash 工具在本机 shim 有问题（报 `dirname: command not found`），优先用 PowerShell。

---

## 三、项目结构速查

```
travel-miniprogram/
├─ miniprogram/                  小程序前端
│  ├─ config.js                  模板ID、开发者工具开关
│  ├─ app.json                   页面 & tabBar 注册
│  ├─ pages/
│  │  ├─ index/      首页（行程列表、上传入口）
│  │  ├─ upload/      上传行程文档
│  │  ├─ planner/     AI 制定新攻略（填需求 → 确认大纲 → 生成入库）
│  │  ├─ itinerary/  行程详情（按天时间轴、编辑/删除）
│  │  ├─ tickets/    车票/闹钟管理
│  │  ├─ mytrips/    我的行程（已结束 + 进行中，全量按时间顺序）
│  │  ├─ suggestions/ 旅行建议
│  │  ├─ mine/       我的
│  │  └─ webmap/     地图导航中转
│  ├─ components/    activity-item / day-card / map-button / ticket-alarm
│  ├─ services/      api.js（切 mock/real）、api-real.js、api-mock.js
│  └─ utils/         env.js / alarm.js / time.js / map.js / auth.js / request.js / trip.js
├─ cloudfunctions/               云函数（改完要部署！）
│  ├─ parseTravelPlan/  文档解析主力：splitter.js(确定性切天) → llm.js(并行按天) → normalize.js(清洗) → cn-time.js
│  ├─ generatePlan/     AI 制定新攻略：plan.js(大纲→逐天细化→闹钟→建议，两阶段) → llm.js / normalize.js / cn-time.js / geocode.js
│  ├─ sendAlarm/        订阅消息推送（LAYOUTS 字段布局表、sendTestNow、pollAndPush）
│  ├─ ticketAlarm/      闹钟 CRUD
│  ├─ itinerary/        行程 CRUD
│  ├─ suggestions/      旅行建议
│  ├─ login/            登录
│  └─ initdb/           初始化数据库集合
├─ scripts/                      本地验证脚本
│  ├─ check-bindings.js  ★ 交付前必跑（wxml/js 对齐、config 引用、语法）
│  └─ test-*.js          单元测试：parse / normalize / alarms / splitter / timezone / longji 等
└─ demo/index.html               独立演示页
```

云开发环境：`cloudbase-d1gjisaab4e470218`（体验版）
云函数超时 60s → 解析走**按天并行** LLM，别改成串行。

---

## 四、改动的正确姿势（SOP）

1. **读**：先定位相关文件，别猜。
2. **改**：能确定性解决的不交给 LLM；改了 prompt 也要在 `normalize.js` 兜底。
3. **验**：
   - `node scripts/check-bindings.js`
   - 相关 `node scripts/test-xxx.js`
   - 云函数改动：本地跑通 → **部署** → 真机看日志里的版本号确认
4. **提交**：`git add -A && git commit -m "..."`，**不 push**。
5. **告诉用户怎么验**：需要重新部署哪个云函数、重新上传哪个文档、看什么现象。
6. **写记忆**：有价值的过程追加到 `.workbuddy/memory/YYYY-MM-DD.md`。

---

## 五、常用命令

```powershell
cd 'D:\on_homework\workbody\代码开发\travel-miniprogram'

# 自检（必跑）
node scripts/check-bindings.js

# 提交到本地（默认动作，不推远端）
git add -A
git commit -m "fix: xxx"

# 查看历史 / 撤回（用户想重来时用）
git log --oneline -10
git reset --soft HEAD~1     # 保留改动，只撤提交
git reset --hard HEAD~1     # 慎用：改动一起丢弃

# 仅当用户明确要求时才推
git push origin main
```

> ⚠️ 本机推送到 GitHub 的已知情况（2026-09-21 配好）：
> SSH 用 `~/.ssh/id_ed25519`，`~/.ssh/config` 里对 `github.com` 设了
> `AddressFamily inet` + `ConnectTimeout 30`（强制 IPv4）。
> 网络偶尔抽风会 `banner exchange: Connection timed out`，**多试几次就行**，不是配置坏了。

---

## 六、用户偏好

- 称呼 **Tiger**，重庆人（GMT+8）。叫我 **阿稳**。
- 沟通：中文，幽默但别耽误正事；**不要填表式一问一答**，不要反复追问个人信息。
- 讨厌来回截图确认——**能自己验证的就自己验证**，直接给结论和修好的东西。
- 要「靠谱的助理」：先交付，再贫嘴；严肃场景不硬抖机灵。
- 涉及外部动作（发邮件、公开发布、推远端）**先确认再执行**。
