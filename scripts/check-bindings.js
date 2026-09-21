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
const jsFiles = [
  'pages/itinerary/itinerary.js',
  'pages/tickets/tickets.js',
  'pages/index/index.js',
  'components/activity-item/activity-item.js',
  'components/ticket-alarm/ticket-alarm.js',
  'components/map-button/map-button.js',
];
jsFiles.forEach((rel) => {
  const abs = path.join(MP, rel);
  const r = cp.spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  ok(`JS 语法 ${rel}`, r.status === 0, r.status === 0 ? '' : (r.stderr || '').trim().split('\n')[0]);
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
ok('组件声明 devMode 属性', /devMode:\s*\{/.test(taJs) && /devMode="\{\{devMode\}\}"/.test(tkWxml));
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

console.log(failed ? `\n${failed} 项失败 ✗` : '\n全部通过 ✓');
process.exit(failed ? 1 : 0);
