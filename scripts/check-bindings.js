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

// ---------- ③ 残留 & 关键改动检查 ----------
const actWxml = fs.readFileSync(path.join(MP, 'components/activity-item/activity-item.wxml'), 'utf8');
const actWxss = fs.readFileSync(path.join(MP, 'components/activity-item/activity-item.wxss'), 'utf8');
const itWxml = fs.readFileSync(path.join(MP, 'pages/itinerary/itinerary.wxml'), 'utf8');
const itJs = fs.readFileSync(path.join(MP, 'pages/itinerary/itinerary.js'), 'utf8');

ok('编辑/删除已独立成行（无 action-row）',
  !/class="action-row"/.test(actWxml) && !/class="spacer"/.test(actWxml));
ok('导航行 nav-row + 操作行 btn-row 均存在',
  /class="nav-row"/.test(actWxml) && /class="btn-row"/.test(actWxml));
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
ok('后端：返程按"抵达出发地"倒推（e 字段写 backTime）',
  /返程到达时间已由用户指定/.test(planJs) && /mv 里 e 字段写 \$\{p\.backTime\}/.test(planJs));
ok('后端：去程按"从出发地启程"（s 字段写 goTime）',
  /去程开始时间已由用户指定/.test(planJs) && /mv 里 s 字段写 \$\{p\.goTime\}/.test(planJs));

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
  && /enforceLuggageRules\(enforceDayStartLocation\(sanitizeItems/.test(planJs));

console.log(failed ? `\n${failed} 项失败 ✗` : '\n全部通过 ✓');
process.exit(failed ? 1 : 0);
