// scripts/check-bindings.js
// 校验：① JS 语法 ② wxml 事件名与 js 方法对齐 ③ 关键标记残留检查
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

let failed = 0;
const ok = (name, pass, extra) => {
  console.log(`${pass ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!pass) failed++;
};

// ---------- ① JS 语法 ----------
// ⚠️ 别用 spawnSync(process.execPath, ['--check', f])：本机（Windows + 沙箱）会随机
//    EBUSY，6 个文件恒报"语法失败"，是假警报。改用 vm.Script 在同进程内编译，
//    效果一样（都是只编译不执行），但不会被子进程的调度问题坑到。
const vm = require('vm');
const syntaxOk = (abs) => {
  try {
    new vm.Script(fs.readFileSync(abs, 'utf8'), { filename: abs });
    return null;
  } catch (e) {
    return e.message;
  }
};
const jsFiles = [
  'pages/itinerary/itinerary.js',
  'pages/tickets/tickets.js',
  'pages/index/index.js',
  'components/activity-item/activity-item.js',
  'components/ticket-alarm/ticket-alarm.js',
  'components/map-button/map-button.js',
  'pages/planner/planner.js',
  'utils/eta.js',
];
jsFiles.forEach((rel) => {
  const err = syntaxOk(path.join(MP, rel));
  ok(`JS 语法 ${rel}`, !err, err || '');
});

// 顺带把云函数也过一遍（云函数改动只跑 test-*.js 容易漏掉语法错）
const CF = path.join(ROOT, 'cloudfunctions');
fs.readdirSync(CF).forEach((dir) => {
  const abs = path.join(CF, dir, 'index.js');
  if (!fs.existsSync(abs)) return;
  const err = syntaxOk(abs);
  ok(`JS 语法 cloudfunctions/${dir}/index.js`, !err, err || '');
});

// ---------- ② 事件绑定对齐 ----------
const RE = /(?:bind|catch)[:]?([a-zA-Z]*)\s*=\s*"([a-zA-Z_$][\w$]*)"/g;
function checkPair(wxmlRel, jsRel) {
  const w = fs.readFileSync(path.join(MP, wxmlRel), 'utf8');
  const j = fs.readFileSync(path.join(MP, jsRel), 'utf8');
  const names = new Set();
  let m;
  while ((m = RE.exec(w))) names.add(m[2]);
  const missing = [...names].filter((n) => {
    const re = new RegExp(`(^|\\n)\\s*(async\\s+)?${n}\\s*[:(]`, 'm');
    return !re.test(j);
  });
  ok(`${wxmlRel} 事件对齐`, missing.length === 0,
    missing.length ? `缺失: ${missing.join(', ')}` : `共 ${names.size} 个`);
}

checkPair('components/activity-item/activity-item.wxml', 'components/activity-item/activity-item.js');
checkPair('pages/itinerary/itinerary.wxml', 'pages/itinerary/itinerary.js');
checkPair('components/map-button/map-button.wxml', 'components/map-button/map-button.js');
checkPair('components/ticket-alarm/ticket-alarm.wxml', 'components/ticket-alarm/ticket-alarm.js');
checkPair('pages/tickets/tickets.wxml', 'pages/tickets/tickets.js');
checkPair('pages/pay/pay.wxml', 'pages/pay/pay.js');
checkPair('pages/mine/mine.wxml', 'pages/mine/mine.js');

// ---------- ③ 残留 & 关键改动检查 ----------
const actWxml = fs.readFileSync(path.join(MP, 'components/activity-item/activity-item.wxml'), 'utf8');
const actWxss = fs.readFileSync(path.join(MP, 'components/activity-item/activity-item.wxss'), 'utf8');
const itWxml = fs.readFileSync(path.join(MP, 'pages/itinerary/itinerary.wxml'), 'utf8');
const itJs = fs.readFileSync(path.join(MP, 'pages/itinerary/itinerary.js'), 'utf8');

ok('编辑/删除已独立成行（无 action-row）',
  !/class="action-row"/.test(actWxml) && !/class="spacer"/.test(actWxml));
ok('导航行 nav-row + 操作行 btn-row 均存在',
  /class="nav-row/.test(actWxml) && /class="btn-row"/.test(actWxml));
ok('btn-row 样式已定义', /\.btn-row\s*\{/.test(actWxss));
ok('组件绑定不再用 editingId 做比较', !/editing="\{\{editingId/.test(itWxml));
ok('WXML 使用 item.editing', /editing="\{\{item\.editing\}\}"/.test(itWxml));
ok('wx:key 已换成稳定 key', !/wx:key="_id"/.test(itWxml) && /wx:key="key"/.test(itWxml));
ok('页面已注入 withItemKeys', /trip\.items = this\.withItemKeys\(trip\.items\)/.test(itJs));
ok('editingId 初值为空串', /editingId: '',/.test(itJs));
ok('编辑后重算 items', /this\.applyTimeFlags\(\);\s*\/\/ 重算 items/.test(itJs));

// ---------- ④ 首页快捷入口已移除 ----------
const idxWxml = fs.readFileSync(path.join(MP, 'pages/index/index.wxml'), 'utf8');
const idxWxss = fs.readFileSync(path.join(MP, 'pages/index/index.wxss'), 'utf8');
ok('首页快捷入口已移除',
  !/quick-actions|quick-item/.test(idxWxml) && !/quick-actions|quick-item/.test(idxWxss));

// ---------- ⑤ 闹钟页改动检查 ----------
const tkWxml = fs.readFileSync(path.join(MP, 'pages/tickets/tickets.wxml'), 'utf8');
const tkWxss = fs.readFileSync(path.join(MP, 'pages/tickets/tickets.wxss'), 'utf8');
const tkJs = fs.readFileSync(path.join(MP, 'pages/tickets/tickets.js'), 'utf8');
const taWxml = fs.readFileSync(path.join(MP, 'components/ticket-alarm/ticket-alarm.wxml'), 'utf8');
const taJs = fs.readFileSync(path.join(MP, 'components/ticket-alarm/ticket-alarm.js'), 'utf8');
ok('顶部设置卡改为紧凑两行式', /settings-card/.test(tkWxml) && /settings-row/.test(tkWxml) && /\.settings-row\s*\{/.test(tkWxss));
ok('旧的大按钮同步入口已移除', !/一键同步未来闹钟到日历/.test(tkWxml) && !/锁屏也能提醒/.test(tkWxml));
ok('编辑改为底部抽屉（sheet + 保存按钮）', /class="sheet"/.test(tkWxml) && /onSheetSave/.test(tkWxml) && /onSheetSave/.test(tkJs));
ok('新增/编辑共用抽屉（sheetMode 分支）', /sheetMode === 'new'/.test(tkWxml) && /sheetMode === 'new'/.test(tkJs));
ok('删除改为自定义确认卡', /delItem/.test(tkWxml) && /onConfirmDelete/.test(tkJs) && !/wx.showModal\(\{\s*\n\s*title: '确认删除闹钟'/.test(tkJs));
ok('测试按钮接订阅消息推送', /requestSubscribe/.test(tkJs) && /sendTestAlarm/.test(tkJs) && /SUBSCRIBE_TEMPLATE_ID/.test(tkJs));
ok('组件已无内联编辑表单', !/editing/.test(taWxml) && !/editForm/.test(taJs));
ok('订阅消息工具已导出', /requestSubscribe/.test(fs.readFileSync(path.join(MP, 'utils/alarm.js'), 'utf8')));
ok('云函数支持 test 即时推送', /action === 'test'/.test(fs.readFileSync(path.join(ROOT, 'cloudfunctions/sendAlarm/index.js'), 'utf8')));

ok('调试入口受 devMode 控制', /wx:if="\{\{devMode\}\}"/.test(tkWxml) && /devMode: env\.showDevTools\(\)/.test(tkJs));
ok('测试按钮仅在 devMode 显示', /wx:if="\{\{devMode\}\}"[^>]*bindtap="onTapTest"/.test(taWxml));
// 分类列表已迁移到 alarm-group 分类详情页；组件 devMode 属性仍要声明，
// 且分类页用到 ticket-alarm 时也要能传 devMode（组件默认 false，安全）
const agWxml = fs.readFileSync(path.join(MP, 'pages/alarm-group/alarm-group.wxml'), 'utf8');
const agJs = fs.readFileSync(path.join(MP, 'pages/alarm-group/alarm-group.js'), 'utf8');
ok('组件声明 devMode 属性', /devMode:\s*\{/.test(taJs));
ok('分类详情页复用 ticket-alarm 组件并具备编辑/删除能力',
  /<ticket-alarm/.test(agWxml) && /onTapEdit/.test(agJs) && /onConfirmDelete/.test(agJs));
ok('存在环境判断工具 utils/env.js', /showDevTools/.test(fs.readFileSync(path.join(MP, 'utils/env.js'), 'utf8')));

// ---------- ⑤.5 引用完整性：用了 config 必须先 require ----------
// 背景：api-real.js 曾出现 config.SUBSCRIBE_TEMPLATE_ID 未引入 config 直接 ReferenceError
const scanDirs = ['pages', 'components', 'services', 'utils'];
for (const dir of scanDirs) {
  const absDir = path.join(MP, dir);
  for (const f of fs.readdirSync(absDir)) {
    if (!f.endsWith('.js')) continue;
    const src2 = fs.readFileSync(path.join(absDir, f), 'utf8');
    const uses = /\bconfig\./.test(src2);
    const required = /require\([^)]*config['"]\)/.test(src2);
    ok(`config 引用完整 ${dir}/${f}`, !uses || required, uses && !required ? '用了 config 但没 require' : '');
  }
}

// ---------- ⑥ withItemKeys 逻辑自测 ----------
const KEY_LOGIC = `
  withItemKeys(items) {
    const used = {};
    return (items || []).map((it, i) => {
      if (!it || typeof it !== 'object') return it;
      let k = it.key || it._id || it.id || ('k' + Number(it.dayIndex || 0) + '_' + i);
      while (used[k]) k += '_x';
      used[k] = 1;
      if (it.key === k) return it;
      return Object.assign({}, it, { key: k });
    });
  }
`;
const fake = eval(`({ ${KEY_LOGIC} })`);
const src = [
  { dayIndex: 0, activity: 'a' },                 // 无任何 id → k0_0
  { dayIndex: 0, activity: 'b' },                 // 无任何 id → k0_1
  { dayIndex: 0, activity: 'c', key: 'k0_0' },    // 与第一条撞车 → k0_0_x
  { dayIndex: 1, activity: 'd', _id: 'real1' },   // 用 _id
  { dayIndex: 1, activity: 'e', id: 'real2' },    // 用 id
];
const out = fake.withItemKeys(src);
const keys = out.map((x) => x.key);
ok('生成的 key 全部非空', keys.every((k) => !!k), JSON.stringify(keys));
ok('key 全局唯一', new Set(keys).size === keys.length, JSON.stringify(keys));
ok('已有 _id 优先复用', keys[3] === 'real1');
ok('已有 id 参用', keys[4] === 'real2');
const again = fake.withItemKeys(out);
ok('二次处理 key 稳定不变', JSON.stringify(again.map((x) => x.key)) === JSON.stringify(keys));
ok('二次处理保持引用（不重复拷贝）', again[0] === out[0]);

// ---------- ⑦ 生成耗时预估（页脚不再写死秒数）----------
const plWxml = fs.readFileSync(path.join(MP, 'pages/planner/planner.wxml'), 'utf8');
const plJs = fs.readFileSync(path.join(MP, 'pages/planner/planner.js'), 'utf8');
ok('页脚不再写死"约需 N 秒"',
  !/生成约需\s*\d+\s*秒/.test(plWxml) && !/展开约需\s*\d+\s*秒/.test(plWxml));
ok('页脚绑定动态预估字段',
  /\{\{outlineEta\}\}/.test(plWxml) && /\{\{detailEta\}\}/.test(plWxml));
ok('planner 引入了 utils/eta', /require\(['"][^'"]*utils\/eta['"]\)/.test(plJs));
ok('跑完回写实测耗时（outline/detail 各一次）',
  /eta\.record\('outline'/.test(plJs) && /eta\.record\('detail'/.test(plJs));
ok('倒计时用预估而不是干巴巴的秒数', /还需约/.test(plJs) && /startTicker\(/.test(plJs));

// ---- ETA 模型自测：喂几个样本后，预估要能朝真实值收敛 ----
// eta.js 在 node 下没有 wx，load/save 都包在 try 里，会退化成纯内存，正好可测
delete require.cache[require.resolve(path.join(MP, 'utils/eta.js'))];
const eta = require(path.join(MP, 'utils/eta.js'));
const d = eta.DEFAULTS.outline;
const before = eta.estimate('outline', 8);
for (let i = 0; i < 6; i++) eta.record('outline', 8, 22000); // 真实稳定在 22s
const after = eta.estimate('outline', 8);
ok('反复喂同一实测值后预估向它收敛',
  Math.abs(after - 22000) < Math.abs(before - 22000), `${Math.round(before / 1000)}s → ${Math.round(after / 1000)}s`);
ok('预估不越界（min/max 生效）',
  eta.estimate('outline', 1) >= d.min && eta.estimate('detail', 12) <= eta.DEFAULTS.detail.max);
ok('异常样本被丢弃（<2s 或 >10min 不入模型）', (() => {
  const snap = eta.estimate('outline', 8);
  eta.record('outline', 8, 500);
  eta.record('outline', 8, 99999999);
  return Math.abs(eta.estimate('outline', 8) - snap) < 1;
})());
ok('未跑过时文案带"首次"提示，跑过后带"上次实际"',
  /首次/.test(eta.footerText('detail', 8)) === false || /上次实际/.test(eta.footerText('outline', 8)),
  eta.footerText('outline', 8));
ok('时长格式化可读', eta.fmtDuration(25000) === '25 秒' && eta.fmtDuration(100000) === '1 分 40 秒',
  `${eta.fmtDuration(25000)} / ${eta.fmtDuration(100000)}`);

// ---------- ⑧ 去程/返程时刻语义 ----------
ok('去程标签改为「去程开始时间」', /去程开始时间/.test(plWxml) && !/>\s*去程时间\s*</.test(plWxml));
ok('返程标签改为「返程到达时间」', /返程到达时间/.test(plWxml) && !/>\s*返程时间\s*</.test(plWxml));
const planJs = fs.readFileSync(path.join(ROOT, 'cloudfunctions/generatePlan/plan.js'), 'utf8');
ok('后端：返程按"到家时刻"倒推（大交通到站 = backTime-40 分钟）',
  /返程到家时间已由用户指定/.test(planJs) && /backMin - 40/.test(planJs));
ok('后端：goTime = 离开出发地时刻（发车 = goTime+接驳/安检预留，且有接驳兜底）',
  /去程开始时间已由用户指定/.test(planJs) && /goMin \+ buffer/.test(planJs)
    && /function enforceOriginAccess/.test(planJs));

// ---------- ⑨ 不再用 max_tokens 卡模型输出 ----------
const genLlm = fs.readFileSync(path.join(ROOT, 'cloudfunctions/generatePlan/llm.js'), 'utf8');
ok('chat() 默认不带 max_tokens 字段',
  /if \(opts\.maxTokens > 0\) bodyObj\.max_tokens = opts\.maxTokens;/.test(genLlm));
ok('保留环境变量兜底（LLM_MAX_TOKENS）', /LLM_MAX_TOKENS/.test(genLlm));
ok('plan.js 调用点不再传数字 token 上限',
  !/chatWithRetry\([\s\S]{0,200}?,\s*\d{3,4}\s*,/.test(planJs));
ok('截断会留日志（finish_reason=length）', /finish_reason === 'length'/.test(genLlm));

// ---------- ⑩ 出行方式：高铁/动车优先 + 顺序调整 ----------
const plannerJs = fs.readFileSync(path.join(MP, 'pages/planner/planner.js'), 'utf8');
const transportLine = (plannerJs.match(/const TRANSPORT = \[([^\]]*)\]/) || [])[1] || '';
ok('出行方式含「高铁/动车优先」', /高铁\/动车优先/.test(transportLine), transportLine);
ok('自驾/包车排在飞机优先前面', (() => {
  const list = transportLine.split(',').map((s) => s.replace(/['"]/g, '').trim());
  return list.indexOf('自驾/包车') >= 0 && list.indexOf('飞机优先') >= 0
    && list.indexOf('自驾/包车') < list.indexOf('飞机优先');
})(), transportLine);
ok('后端同时认高铁和动车（railFirst）', /railFirst = \/高铁\|动车\//.test(planJs));
ok('没有合适高铁时允许走动车', /没有合适的高铁[\s\S]{0,120}?动车/.test(planJs));

// ---------- ⑪ 导航定位：城市消歧 ----------
const geoJs = fs.readFileSync(path.join(ROOT, 'cloudfunctions/parseTravelPlan/geocode.js'), 'utf8');
const genGeoJs = fs.readFileSync(path.join(ROOT, 'cloudfunctions/generatePlan/geocode.js'), 'utf8');
ok('定位走 POI 搜索（citylimit 才是硬限制）', /place\/text/.test(geoJs) && /citylimit=true/.test(geoJs));
ok('返回结果要过城市校验，对不上就放弃', /function cityHit/.test(geoJs) && /放弃/.test(geoJs));
// 两份是复制粘贴的（云函数各自独立打包，没法跨目录 require），
// 只比正文部分——文件头的路径注释本来就不一样
const bodyOf = (s) => s.slice(s.indexOf("require('https')"));
ok('两个云函数的 geocode 实现一致', bodyOf(geoJs) === bodyOf(genGeoJs));
ok('城市词清洗：括号补注/行政后缀都能洗掉（脏住宿地值曾让定位全挂）',
  /function cityTokens/.test(geoJs) && /县城/.test(geoJs));
ok('城市校验用多城市词表（跨城段不再被第一个城市卡死）',
  /tokens\.some/.test(geoJs) && /function cityHit/.test(geoJs));
const mapJs2 = fs.readFileSync(path.join(MP, 'utils/map.js'), 'utf8');
ok('导航定位失败时用整行程大地名二次重试（fallbackRegion）',
  /fallbackRegion/.test(mapJs2) && /currentTripRegion/.test(mapJs2));
const idxJs = fs.readFileSync(path.join(MP, 'pages/index/index.js'), 'utf8');
ok('首页导航传 fallbackRegion（首页定位失败的主修复）', /fallbackRegion: \(this\._trip && this\._trip\.region\)/.test(idxJs));
const itinWxml = fs.readFileSync(path.join(MP, 'pages/itinerary/itinerary.wxml'), 'utf8');
ok('导航优先用条目的城市（item.city）', /region="{{item\.city \|\| trip\.region}}"/.test(itinWxml));
const navJs = fs.readFileSync(path.join(MP, 'utils/map.js'), 'utf8');
ok('降级复制时带上城市（避免搜到外省同名点）', /function firstCity/.test(navJs) && /\$\{city\} \$\{/.test(navJs));

// ---------- ⑫ 隐私授权：先授权再调接口，禁止"同意后自动重试"的死循环 ----------
const privacyJs = fs.readFileSync(path.join(MP, 'utils/privacy.js'), 'utf8');
const uploadJs = fs.readFileSync(path.join(MP, 'pages/upload/upload.js'), 'utf8');
const appJs = fs.readFileSync(path.join(MP, 'app.js'), 'utf8');
const popupJs = fs.readFileSync(path.join(MP, 'components/privacy-popup/privacy-popup.js'), 'utf8');
ok('隐私授权统一走 utils/privacy.js',
  /require\(['"](\.\.\/)+utils\/privacy['"]\)/.test(uploadJs)
  && /require\(['"]\.\/utils\/privacy['"]\)/.test(appJs));
ok('调用隐私接口前先主动授权（requirePrivacyAuthorize）', /wx\.requirePrivacyAuthorize/.test(privacyJs));
ok('upload：选文件前先过授权这一关', /await privacy\.ensure/.test(uploadJs) && /pickFile/.test(uploadJs));
ok('upload：不再"同意后自动重试"（循环元凶）', !/_retryChoose/.test(uploadJs) && !/onClosePrivacy[\s\S]{0,200}onChooseFile/.test(uploadJs));
ok('upload：连点防重入', /if \(this\._choosing\) return/.test(uploadJs));
ok('upload：授权没生效只提示一次并给排查路径', /_privacyWarned/.test(uploadJs) && /用户隐私保护指引/.test(uploadJs));
ok('弹窗把结果交回微信（没有 pending 也不卡死）', /privacy\.finish\(/.test(popupJs));
ok('app.js 把拦截回调交给 privacy.onNeed', /wx\.onNeedPrivacyAuthorization\(\(resolve\) => privacy\.onNeed/.test(appJs));

// ---------- ⑬ 行李规则：换住处必须随身带，景区寄存必须提醒取回 ----------
const plWxml2 = fs.readFileSync(path.join(MP, 'pages/planner/planner.wxml'), 'utf8');
ok('返程到达时间说明不再提"AI 倒推发车时间"', !/AI 会据此倒推发车时间/.test(plWxml2));
ok('大纲 prompt 写清"行李随人走"', /行李随人走/.test(planJs));
ok('细化 prompt 按住宿地判定行李走法（第 16 条）', /16\. \*\*行李处理/.test(planJs) && /sameBase/.test(planJs));
ok('换住处禁止把行李留在上一家酒店', /禁止写"把大件行李寄存在/.test(planJs));
ok('行李规则有代码兜底且挂在 sanitize 之后', /function enforceLuggageRules/.test(planJs)
  && /items = enforceLuggageRules\(items, outline\)/.test(planJs));
ok('已确认大交通有确定性对齐兜底（车次错时刻/漏排/重复/起终点错都能拽回）',
  /function enforceMovesAlignment/.test(planJs)
  && /时刻漂移/.test(planJs) && /全天未安排，补一条/.test(planJs));
ok('细化清洗链按序挂全（对齐→去重→起点→接驳→早餐→禁午睡→晚间→餐次纠偏→闭环→行李→顺延）',
  /items = enforceMovesAlignment\(sanitizeItems/.test(planJs)
    && /items = dedupeTransports\(items\);/.test(planJs)
    && /items = enforceDayStartLocation\(items, outline\)/.test(planJs)
    && /items = enforceOriginAccess\(items, p, outline, roundDays\)/.test(planJs)
    && /items = enforceMorningRoutine\(items, outline\)/.test(planJs)
    && /items = enforceNoMiddayHotel\(items, outline\)/.test(planJs)
    && /items = enforceEveningPlan\(items, outline\)/.test(planJs)
    && /items = fixMealLabels\(items, outline\)/.test(planJs)
    && /items = enforceDayClosure\(items, outline, p\)/.test(planJs)
    && /items = enforceLuggageRules\(items, outline\)/.test(planJs)
    && /items = fixDayTimeOverlaps\(items\);/.test(planJs));
ok('细化失败/残缺天有骨架重建（skeletonForEmptyDays，只在非 partial 轮，排除已完成天）',
  /function skeletonForEmptyDays/.test(planJs)
    && /skeletonForEmptyDays\(p, outline, detail\.items, detail\.doneDayIndexes\)/.test(planJs));
ok('包车/大巴段宽松匹配，已有同向交通条目时不重复补（isScheduledMove 分流）',
  /function isScheduledMove/.test(planJs) && /已由细化安排（宽松匹配），不补/.test(planJs));
ok('餐次词按实际时刻纠偏（早上不出现"晚餐"）',
  /function fixMealLabels/.test(planJs) && /t < 10 \* 60 \+ 30/.test(planJs));
ok('同天重复交通条目有确定性去重（dedupeTransports：同班次码/同方向就近去重，不认地名）',
  /function dedupeTransports/.test(planJs) && /function transportCodeOf/.test(planJs));
ok('跨天同类体验差异化写入两段 prompt（大纲 7.4 + 细化规则 19，最多 2 次）',
  /7\.4 \*\*全程体验要差异化（铁律）\*\*/.test(planJs)
    && /19\. \*\*别重复排已安排过的内容\*\*/.test(planJs));
ok('早餐兜底只在上午补，中午后补午餐而不是早餐',
  /fs <= 11 \* 60 \+ 30/.test(planJs) && /补午餐而不是早餐/.test(planJs));
ok('细化 prompt 禁止白天回酒店睡觉（15:00 前）',
  /白天不许回酒店睡觉/.test(planJs) && /15:00 前禁止安排/.test(planJs));
ok('大纲 prompt：相邻两天核心片区相距超 1 小时必须换基地',
  /必须换基地/.test(planJs) && /来回通勤 4 小时/.test(planJs));
ok('大纲 prompt：ml 三餐都要点名（店名或片区+招牌菜）',
  /ml 一日三餐都要点名/.test(planJs));
ok('大纲 prompt：大交通到发站按"下车后接驳最短"选（禁止为车次多舍近求远）',
  /下车（机）后到当天最终景点或今晚住宿地的接驳距离最短/.test(planJs) && /禁止舍近求远/.test(planJs));
ok('大纲 prompt：市内/短途交通按预算选型基调写进 n 提示',
  /7\.3 \*\*市内\/短途交通按预算选型\*\*/.test(planJs) && /基调写进当天 n 提示/.test(planJs));
ok('细化 prompt：市内/短途交通按预算选型（经济=步行+轨交优先，打车写预估车费）',
  /18\. \*\*市内\/短途交通按用户预算/.test(planJs) && /打车约 15-20 元/.test(planJs));
ok('大交通选站：模型自报到站接驳方式+耗时（mv.st），"到站后还得长途打车"判为绕路（通用，不认地名）',
  /"st":"到站后到当天首个目的地的接驳方式与耗时"/.test(planJs)
    && /4\.2 \*\*每段 mv 都要给 st/.test(planJs)
    && /function detourTransfers/.test(planJs)
    && /function isCarTransfer/.test(planJs)
    && /warnDetourTransfers\(outline\)/.test(planJs));
ok('绕路段会触发一次通用复核请求（改站交给模型，方式与时刻不变）',
  /missing\.length \|\| dups\.length \|\| detours\.length/.test(planJs)
    && /repairOutline\(p, outline, missing, dups, detours, outlineDeadline\)/.test(planJs)
    && /到站后还得长途打车才到当天目的地/.test(planJs)
    && /okDetour/.test(planJs));
ok('❗代码里不许写死具体地名/车站做特例优化（通用性红线）',
  !/NEAR_STATION_FIXES|fixNearStations/.test(planJs)
    && !/离堆公园|犀浦|峨眉山站/.test(planJs));
ok('goTime 语义 = 离开出发地时刻（大交通发车按接驳+安检预留后移，goTime+85/160）',
  /goMin \+ buffer/.test(planJs) && /\? 160/.test(planJs) && /\? 85/.test(planJs));
ok('backTime 语义 = 到家时刻（大交通到站 = backTime-40）',
  /backMin - 40/.test(planJs));

// ---------- ⑭ 模型内心独白泄漏防护 + 收尾闭环 ----------
const genNormJs = fs.readFileSync(path.join(ROOT, 'cloudfunctions/generatePlan/normalize.js'), 'utf8');
const parseNormJs = fs.readFileSync(path.join(ROOT, 'cloudfunctions/parseTravelPlan/normalize.js'), 'utf8');
// normalize.js 和 geocode.js 一样是两份复制粘贴的（云函数各自独立打包，没法跨目录 require），
// 改一份必须同步另一份——只比正文，文件头的路径注释本来就不同
const bodyOfNorm = (s) => s.slice(s.indexOf('const MAX_DAY'));
ok('两个云函数的 normalize 实现一致', bodyOfNorm(parseNormJs) === bodyOfNorm(genNormJs));
// 跨天位置继承不能按 startTime 重排：行程跨零点是常态，重排会把"昨晚回民宿"
// 甩到当天最后，次日清晨那条就继承了前一天白天的位置（实测踩过两次）
ok('跨天位置继承按原始叙述顺序（不按时刻重排）',
  /按天序全局遍历/.test(parseNormJs) && !/tOf\(a\.startTime\)/.test(parseNormJs));
ok('人已在目的地时不造 A→A 假移动（保留单头终点给前端导航）',
  /lastKnown !== it\.endLocation/.test(parseNormJs));
ok('细化 prompt 不再把大纲班次说成"用户可能手工改过"（自家大纲的参考时刻被当成圣旨，模型会写独白抗议）',
  !/用户可能手工改过/.test(planJs) && /今天的大交通（路线既定）/.test(planJs));
ok('中间天班次时刻允许静默微调，首末日用户指定时刻才锁死',
  /粗排参考/.test(planJs) && /静默地调/.test(planJs) && /用户指定的硬约束/.test(planJs));
ok('整段"内心独白"条目有硬识别（META_HARD）',
  /const META_HARD/.test(genNormJs) && /鉴于上游/.test(genNormJs) && /倒叙/.test(genNormJs));
ok('有起终点的独白条目抢救成干净交通条目，没起终点的丢弃',
  /从\$\{start\}前往\$\{end\}/.test(genNormJs) && /\.filter\(Boolean\)/.test(genNormJs));
ok('收尾闭环有代码兜底（enforceDayClosure 挂在清洗链中，签名带 p）',
  /function enforceDayClosure\(items, outline, p\)/.test(planJs)
    && /items = enforceDayClosure\(items, outline, p\)/.test(planJs));
ok('返程日不补"回酒店"（ov=返程 或 最后一天）',
  /返程\|回家\/\.test\(tonight\) \|\| di === days\.length - 1/.test(planJs));
// 末日收尾：最后一条常常是"步行返回酒店休息"这种连地名都没有的条目，
// 旧代码只取它的起终点、取不到就放弃 → 末日收在酒店没回家。
ok('返程日兜底：最后一条没地名时按"当天最后已知位置 → 当天城市"兜底找出发点',
  /pickReturnFrom/.test(planJs) && /当天最后一个已知位置/.test(planJs));
// 「在南宁市区（朝阳广场附近）吃早餐」旧逻辑一见"附近"就放弃 → 卡片没导航也没起点。
// 现在先剥模糊词、括号里还留着具体地标就取括号内的（纯泛词才放弃）。
ok('模糊地名"XX（具体地标附近）"先抢救地标再决定是否放弃',
  /附近\|周边\|旁边\|周围\|一带/.test(parseNormJs) && /bm && bm\[1\]\.trim\(\)\.length >= 2/.test(parseNormJs));
ok('收尾判定认"酒店/民宿"字样，不被"眉山站⊃眉山"骗过',
  /酒店\|民宿\|客栈\|宾馆\|青旅\|住宿/.test(planJs));
ok('大纲有每晚推荐酒店（h 字段 → day.hotel，按预算档挑选）',
  /"h":"推荐酒店"/.test(planJs) && /hotel: String\(d\.h \|\| ''\)/.test(planJs)
    && /String\(today\.hotel \|\| ''\)/.test(planJs));
ok('第一天有出发接驳兜底（OriginAccess：没写"从出发地出发"就补一条去车站）',
  /function enforceOriginAccess/.test(planJs) && /出发接驳（按用户填写的出发时间生成）/.test(planJs));
ok('每天有早餐兜底（第 2 天起 10 点前没吃饭补早餐）',
  /function enforceMorningRoutine/.test(planJs) && /收拾行李退房/.test(planJs));
ok('非末日有过早收尾兜底（20:30 前结束补晚餐/夜逛）',
  /function enforceEveningPlan/.test(planJs) && /20 \* 60 \+ 30/.test(planJs));
ok('返程日没回到家有兜底（最后一条不是出发地就补回家接驳）',
  /从\$\{from\}返回\$\{origin\}，到家休息/.test(planJs));

// ---------- ⑮ 地理编码与导航（多城市候选 / 中间点 / 目的地直连） ----------
ok('geocode 支持多候选城市（region 城市词 + 地点自带行政区，如「重庆市金童路」）',
  /const regionCities = tokens\.filter/.test(geoJs) && /const addrCities = addrTokens/.test(geoJs)
    && /candidates\.forEach/.test(geoJs)
    && bodyOf(geoJs) === bodyOf(genGeoJs));
ok('geocode 搜前剥掉括号补注（「XX酒店（XX景区店）」不再拖垮 POI 搜索）',
  /bare = String\(address\)\.replace/.test(geoJs));
ok('geocode 搜前剥掉模糊尾巴（「阳朔西街附近」→「阳朔西街」）',
  /\(附近\|周边\|一带\)/.test(geoJs));
ok('POI 名称锁有类别尾缀（「重庆北站」不再被「重庆鲜面店」顶替）',
  /const TAIL_GROUPS/.test(geoJs) && /tm\.index > 1/.test(geoJs));
ok('geo 模糊结果过名称相关性校验（「德天跨国瀑布」不再编到桂林"德天"路）',
  /function geoNameOk/.test(geoJs) && /isGeo: true/.test(geoJs) && /geoNameOk\(bare, r\.hay\)/.test(geoJs));
ok('全国强名兜底存在（出发地「金童路一奥天地」不在行程城市也能定位）',
  /poi\/last/.test(geoJs) && /strongName/.test(geoJs));
ok('QPS 限速保护（请求间隔 + infocode 重试，QPS 被限时不再掉进 geo 兜底）',
  /AMAP_MIN_GAP_MS/.test(geoJs) && /resp\.infocode/.test(geoJs));
ok('geocode 有关键词放宽兜底（砍开头两字，「大新明仕酒店」→「明仕酒店」）',
  /poi\/relax/.test(geoJs));
ok('geo 有行政区划级防线 + 住宿餐饮类防线（客运站不再定位到市政府、编造酒店名宁可不给坐标）',
  /function geoLevelOk/.test(geoJs) && /function geoClassOk/.test(geoJs)
    && /geoLevelOk\(bare, r\.hay, r\.level\)/.test(geoJs) && /geoClassOk\(bare, r\.hay\)/.test(geoJs));
ok('POI 名剥分支后缀 + 枢纽等价匹配（「XX客栈(客运中心店)」不顶掉真车站、「客运站」≈「市客运中心」）',
  /function hubEquivalent/.test(geoJs)
    && geoJs.includes('[（(]')        // 分支后缀剥除的字符类
    && /HUB_TAIL\.test\(k\) && LODGE_FOOD_WORD\.test\(n\)/.test(geoJs));

ok('geocode 回传命中的城市（item.city 按条目落准，前端实时定位直接用对城市）',
  /cityTagOf/.test(geoJs));
const parseIdxJs = fs.readFileSync(path.join(ROOT, 'cloudfunctions/parseTravelPlan/index.js'), 'utf8');
ok('parseTravelPlan 分步模式齐备（init/day/collect/infer/geocode/commit 六步）',
  /case 'init'/.test(parseIdxJs) && /case 'day'/.test(parseIdxJs)
    && /case 'collect'/.test(parseIdxJs) && /case 'infer'/.test(parseIdxJs)
    && /case 'geocode'/.test(parseIdxJs) && /case 'commit'/.test(parseIdxJs));
ok('分步模式：day 步幂等（重试不重跑已成功的天）',
  /task\.dayStatus && task\.dayStatus\[index\]/.test(parseIdxJs));
ok('分步模式：geocode 步限墙钟（35s 预算，单次跑不完下次续跑）',
  /GEOCODE_DEADLINE_MS/.test(parseIdxJs) && /Date\.now\(\) - t0 > GEOCODE_DEADLINE_MS/.test(parseIdxJs));
ok('分步模式：commit 步幂等（防重复入库）',
  /task\.tripId && task\.resultInfo/.test(parseIdxJs));
ok('分步模式：地理编码传整串 region（geocodeOne 内部拆候选城市）',
  /geocodeOne\(addr, region\)/.test(parseIdxJs));
ok('分步模式与单次模式共用同一份文档元信息（docmeta）',
  /require\('\.\/docmeta'\)/.test(fs.readFileSync(path.join(ROOT, 'cloudfunctions/parseTravelPlan/llm.js'), 'utf8'))
    && /require\('\.\/docmeta'\)/.test(parseIdxJs));
ok('分步模式：step 成功返回必须包 data（callFn 只 resolve res.result.data，平铺字段会让前端拿到 undefined）',
  /code: 0, data: r \}/.test(parseIdxJs));
ok('upload 页走分步流水线（init→day→collect→infer→geocode→commit，断点重试）',
  /runParsePipeline/.test(uploadJs) && /parseTravelPlanStep/.test(uploadJs)
    && /this\._taskState/.test(uploadJs));
ok('upload 页有分步进度文案（stageText）',
  /stageText/.test(uploadJs) && /stageText/.test(fs.readFileSync(path.join(MP, 'pages/upload/upload.wxml'), 'utf8')));
ok('无起终点条目有终点回填（inferDestination 挂在 Pass 2 之前）',
  /function inferDestination/.test(genNormJs) && /inferDestination\(it\.activity\)/.test(genNormJs));
ok('map-button 文案只显示目的地（打开地图只有目的地信息，不误导）',
  !/\$\{s\} → \$\{e\}/.test(fs.readFileSync(path.join(MP, 'components/map-button/map-button.js'), 'utf8'))
    && /label: target, target \}/.test(fs.readFileSync(path.join(MP, 'components/map-button/map-button.js'), 'utf8'))
    && /region: this\.data\.region/.test(fs.readFileSync(path.join(MP, 'components/map-button/map-button.js'), 'utf8')));
const aiWxml = fs.readFileSync(path.join(MP, 'components/activity-item/activity-item.wxml'), 'utf8');
const aiJs = fs.readFileSync(path.join(MP, 'components/activity-item/activity-item.js'), 'utf8');
ok('activity-item 导航区支持多段链接（中间点依次生成导航按钮）',
  /wx:for="\{\{navLegs\}\}"/.test(aiWxml) && /buildNavLegs\(item\)/.test(aiJs));
ok('编辑抽屉支持添加中间点（途 / 删除 / 添加按钮齐备）',
  /place-dot mid/.test(aiWxml) && /onAddWaypoint/.test(aiWxml) && /onRemoveWaypoint/.test(aiWxml));
ok('行程页接入中间点编辑与 fallbackRegion',
  /bind:editwaypoint="onEditWaypoint"/.test(fs.readFileSync(path.join(MP, 'pages/itinerary/itinerary.wxml'), 'utf8'))
    && /onEditWaypoint\(e\)/.test(fs.readFileSync(path.join(MP, 'pages/itinerary/itinerary.js'), 'utf8'))
    && /fallbackRegion="\{\{trip\.region\}\}"/.test(fs.readFileSync(path.join(MP, 'pages/itinerary/itinerary.wxml'), 'utf8')));

// ============================================================
// 收费体系（额度 + 虚拟支付）
//   钱相关的接线一旦断掉就是"白嫖"或"用户付不了款"，全钉死
// ============================================================
const quotaIdx = fs.readFileSync(path.join(CF, 'quota/index.js'), 'utf8');
const quotaRules = fs.readFileSync(path.join(CF, 'quota/rules.js'), 'utf8');
const payIdx = fs.readFileSync(path.join(CF, 'virtualPay/index.js'), 'utf8');
const paySign = fs.readFileSync(path.join(CF, 'virtualPay/sign.js'), 'utf8');
const payRules = fs.readFileSync(path.join(CF, 'virtualPay/quota-rules.js'), 'utf8');
const genPlanIdx = fs.readFileSync(path.join(CF, 'generatePlan/index.js'), 'utf8');
const ptpIdx = fs.readFileSync(path.join(CF, 'parseTravelPlan/index.js'), 'utf8');
const sugIdx = fs.readFileSync(path.join(CF, 'suggestions/index.js'), 'utf8');
const payPageJs = fs.readFileSync(path.join(MP, 'pages/pay/pay.js'), 'utf8');
const payPageWxml = fs.readFileSync(path.join(MP, 'pages/pay/pay.wxml'), 'utf8');
const plannerJs2 = fs.readFileSync(path.join(MP, 'pages/planner/planner.js'), 'utf8');
const uploadJs2 = fs.readFileSync(path.join(MP, 'pages/upload/upload.js'), 'utf8');
const quotaUtil = fs.readFileSync(path.join(MP, 'utils/quota.js'), 'utf8');
const appJson2 = fs.readFileSync(path.join(MP, 'app.json'), 'utf8');

ok('额度中心：三档套餐价格与限额写在 rules.js（¥3/次、¥10/5次、¥20/月卡50次）',
  /id: 'plan_1', name: '单次攻略', price: 300/.test(quotaRules)
    && /id: 'plan_5', name: '5 次卡', price: 1000/.test(quotaRules)
    && /id: 'vip_month', name: '月卡', price: 2000/.test(quotaRules)
    && /vipMonthQuota: 50/.test(quotaRules) && /gift: 3/.test(quotaRules));

ok('新用户送 3 次、30 天有效（ensureUser 里发放，只发一次）',
  /giftQuota: R\.LIMITS\.gift/.test(quotaIdx) && /giftExpireAt: now \+ R\.LIMITS\.giftDays/.test(quotaIdx)
    && /gifted: true/.test(quotaIdx));

ok('存量用户补发赠送额度（老账号升级后不会一上来就 0 次）',
  /收费功能上线前就注册过的/.test(quotaIdx) && /gifted: true/.test(quotaIdx)
    && /!u\.gifted && !x\.quota && !x\.giftQuota && !x\.vipUntil/.test(quotaIdx));

ok('扣费顺序：会员 → 快过期的赠送 → 长期额度（不让用户白亏）',
  /vipLeft\(x, now\) > 0/.test(quotaRules) && /giftLeft\(x, now\) > 0/.test(quotaRules)
    && /patch\.quota = Math\.max\(0, x\.quota - 1\)/.test(quotaRules));

ok('扣费幂等（bizKey 去重，续跑多轮只扣一次）',
  /findLog\(openid, bizKey, 'consume'\)/.test(quotaIdx) && /duplicated: true/.test(quotaIdx));

ok('加额度的操作只认微信上下文 openid（防止自己给自己加次数）',
  /if \(!trusted\) return \{ code: -1, msg: '未登录，不能退额度' \}/.test(quotaIdx)
    && /if \(!trusted\) return \{ code: -1, msg: '未登录，不能发货' \}/.test(quotaIdx)
    && /const trusted = !!ctxOpenid \|\| internal/.test(quotaIdx));

ok('生成入口落库成功后才扣费（大纲/中途失败不收钱）',
  /action: 'consume', scene: 'plan', bizKey: `plan:\$\{data\.tripId\}`/.test(genPlanIdx)
    && /action: 'consume', scene: 'parse', bizKey: `parse:\$\{tripId\}`/.test(ptpIdx));

ok('额度服务不可用时放行（新功能不能把生成功能搞挂）',
  /额度服务不可用，本次不计费/.test(genPlanIdx) && /额度服务不可用，本次不计费/.test(ptpIdx));

ok('防刷：大纲换版本 / 建议刷新有日限额（不扣额度但计次）',
  /action: 'hit', scene: 'outline'/.test(genPlanIdx)
    && /action: 'hit', scene: 'tips'/.test(sugIdx) && /event\.force/.test(sugIdx));

ok('支付签名：paySig=HMAC(AppKey, requestVirtualPayment&body)、signature 不解码 session_key',
  /crypto\.createHmac\('sha256', String\(key \|\| ''\)\)/.test(paySign)
    && /`\$\{uri\}&amp;\$\{body\}`/.test(paySign) === false
    && paySign.includes('${uri}&${body}')
    && /sessionKey 不做 base64 解码|不做 base64 解码/.test(paySign));

ok('signData 字段顺序固定（前端透传，重新 stringify 会验签失败）',
  /offerId: String\(o\.offerId/.test(paySign) && /outTradeNo: String\(o\.outTradeNo/.test(paySign)
    && /前端不能再 JSON\.stringify|重新 stringify|重新序列化/.test(paySign));

ok('发货不只信前端 success（confirm 查单 + 回调 notify 两条路）',
  /action === 'confirm'/.test(payIdx) && /actionNotify/.test(payIdx)
    && /status === 'delivered'/.test(payIdx));

ok('虚拟支付与额度中心商品表同源（改一处必须同步）',
  JSON.stringify(require('../cloudfunctions/quota/rules').GOODS)
    === JSON.stringify(require('../cloudfunctions/virtualPay/quota-rules').GOODS));

ok('前端：制定/上传攻略前先查额度，不够引导付费',
  /quota\.ensureOrPay\('plan'\)/.test(plannerJs2) && /quota\.ensureOrPay\('parse'\)/.test(uploadJs2));

ok('前端：支付走云函数下单（签名不出后端）',
  /action: 'createOrder', goodsId/.test(quotaUtil)
    && /wx\.requestVirtualPayment/.test(quotaUtil)
    && /signData: order\.signData/.test(quotaUtil));

ok('付费页已注册且展示计费说明（避免"为什么又扣钱"的投诉）',
  /pages\/pay\/pay/.test(appJson2) && /计费说明/.test(payPageWxml)
    && /一次完整攻略 = 1 次额度/.test(payPageWxml));

ok('付了钱额度没到账有补救入口（sync 补发，幂等不重复加）',
  /onSync\(\)/.test(payPageJs) && /action: 'sync'/.test(quotaUtil));

// ---------- ⑮ 有额度就不限量 + 后台生成 + 联网班次 ----------
const rulesJs = fs.readFileSync(path.join(CF, 'quota/rules.js'), 'utf8');
const gpIdx = fs.readFileSync(path.join(CF, 'generatePlan/index.js'), 'utf8');
const schedJs = fs.readFileSync(path.join(CF, 'generatePlan/schedule.js'), 'utf8');
const genLlmJs = fs.readFileSync(path.join(CF, 'generatePlan/llm.js'), 'utf8');
const workerIdx = fs.existsSync(path.join(CF, 'genWorker/index.js'))
  ? fs.readFileSync(path.join(CF, 'genWorker/index.js'), 'utf8') : '';
const genrunnerJs = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/genrunner.js'), 'utf8');

ok('还有额度就不限每日次数（canConsume 里没有 day_limit 分支）',
  !/day_limit/.test(rulesJs) && !/dayGenLimit\(/.test(rulesJs)
    && /UNLIMITED_SCENES/.test(rulesJs));

ok('「换个方案」不限次数（云函数不再因为计次被拦截）',
  !/hit\.code === -3/.test(gpIdx) && /只计次不拦截/.test(gpIdx)
    && /UNLIMITED_SCENES\.has\(scene\)/.test(rulesJs));

ok('后台生成：任务落库 + 支持续跑（resume / jobStatus）',
  /COL_JOB = 'gen_jobs'/.test(gpIdx) && /action === 'resume'/.test(gpIdx)
    && /action === 'jobStatus'/.test(gpIdx) && /runJobRound/.test(gpIdx));

ok('后台生成：租约防并发（同一任务不会被跑两遍）',
  /JOB_LEASE_MS/.test(gpIdx) && /leaseUntil/.test(gpIdx)
    && /expectRound/.test(gpIdx) && /const busy/.test(gpIdx));

ok('后台生成：有定时触发器兜底（用户关掉小程序也能跑完）',
  /genWorker/.test(workerIdx) && /action: 'resume'/.test(workerIdx)
    && /"type": "timer"/.test(fs.readFileSync(path.join(CF, 'genWorker/config.json'), 'utf8')));

ok('后台生成：续跑循环跑在全局模块里（离开页面不会断）',
  /api\.resumeGen\(/.test(genrunnerJs) && /module\.exports/.test(genrunnerJs));

ok('行程带生成中状态（列表页能显示进度，不需要额外查任务表）',
  /genStatus: plan\.partial \? 'generating' : 'done'/.test(gpIdx));

ok('联网检索真实班次（车次/时刻这类实时信息不能靠模型记忆）',
  /enableSearch: true/.test(schedJs) && /enable_search/.test(genLlmJs)
    && /forced_search/.test(genLlmJs) && /enableSearch/.test(genLlmJs));

ok('检索结果注入细化 prompt（模型只挑，不许自创车次与时刻）',
  /真实班次（已联网核对）/.test(planJs) && /day\.sched/.test(planJs)
    && /enforceRealSchedule/.test(planJs));

ok('检索失败静默降级（绝不因为查不到就出不了行程）',
  /沿用模型编排/.test(schedJs) && /沿用模型编排/.test(planJs));

ok('大纲超时不报错：云端后台补大纲（失败留下一轮重试）+ 前端转后台继续',
  /后台大纲完成/.test(gpIdx) && /attempts\.outline/.test(gpIdx)
    && /bgGenerateAfterOutlineTimeout/.test(plannerJs2));

ok('gen_jobs / schedule_cache 集合不存在时自动创建（-502005 兜底）',
  /async function ensureCollection/.test(gpIdx) && /createCollection/.test(gpIdx)
    && /ensureCollection\(db, COL_JOB\)/.test(gpIdx) && /ensureCollection\(db, COL_SCHED\)/.test(gpIdx));

ok('模拟器不支持虚拟支付有明确提示（不再让用户以为支付坏了）',
  /isDevtools/.test(quotaUtil) && /模拟器不支持虚拟支付/.test(quotaUtil));

ok('iOS 没有沙箱：下单按设备自动切现网（修复 PAYMENT_ILLEGAL_IN_SANDBOX）',
  /platform === 'ios'/.test(payIdx) && /paySigWith/.test(payIdx)
    && /SANDBOX/.test(quotaUtil) && /platform: devicePlatform\(\)/.test(quotaUtil));

ok('细化轮时间纪律：地理编码有硬预算（不再顶穿 60s）+ 闹钟/建议只在最后一轮生成',
  /deadlineAt/.test(genGeoJs) && /GEOCODE_BUDGET_MS/.test(gpIdx)
    && /likelyFinal/.test(planJs));

ok('生成失败可续：前端超时自动重试（不吓用户）+ 云端 failed 任务可复活',
  /TIMEOUT_RE/.test(genrunnerJs) && /timeouts/.test(genrunnerJs)
    && /revivals/.test(gpIdx));

ok('开发者补测试额度有云端开关（QUOTA_DEV_GRANT，默认关死）',
  /QUOTA_DEV_GRANT/.test(fs.readFileSync(path.join(CF, 'quota/index.js'), 'utf8'))
    && /devGrant/.test(quotaUtil));

// ---------- ⑯ 班次准确性与生成提速（2026-09-26 晚） ----------
ok('班次缓存键带出行日期（同线路不同日期开行方案不同，套用就是错车次）',
  /cacheKeyOf/.test(schedJs) && /@/.test((schedJs.match(/function cacheKeyOf[\s\S]{0,200}/) || [''])[0]));

ok('检索 prompt 要求带日期查询并逐条核对（不许凭常态时刻表猜）',
  /检索与核对步骤/.test(schedJs) && /严禁凭印象编造/.test(schedJs));

ok('班次缓存 36 小时过期（日期键换了本来就查不到旧缓存）',
  /SCHED_TTL_MS = 36 \* 3600 \* 1000/.test(gpIdx));

ok('前台大纲不联网检索（检索塞在大纲尾巴上必撞 60s → 转后台重做一遍）',
  /generateOutline\(event, \{\}\)/.test(gpIdx) && !/scheduleLookup: makeScheduleLookup/.test(gpIdx));

ok('班次专轮：后台任务拿到大纲后单独一轮联网核对（写回 outline + schedDone）',
  /班次专轮/.test(gpIdx) && /schedDone: true/.test(gpIdx)
    && /'input\.outline': input\.outline/.test(gpIdx));

ok('细化波次提到 4 天/轮（并行耗时≈最慢一天，8 天行程少跑一两轮）',
  /const WAVE = 4/.test(planJs));

ok('补测试额度用 KeepCode（callFn 成功只回 data，页面判 r.code===0 会误报"没补上"）',
  /callFnKeepCode\('quota', \{ action: 'devGrant' \}\)/.test(quotaUtil));

console.log(failed ? `\n${failed} 项失败 ✗` : '\n全部通过 ✓');
process.exit(failed ? 1 : 0);
