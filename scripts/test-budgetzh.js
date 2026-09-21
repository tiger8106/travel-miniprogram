// 冒烟测试：复刻 suggestions 页 toText/zhify 的转换逻辑，验证英文键预算 → 中文行
const KEY_ZH = {
  accommodation: '住宿', hotel: '住宿', lodging: '住宿',
  food: '餐饮', dining: '餐饮', meals: '餐饮', restaurant: '餐饮',
  transport: '交通', transportation: '交通', traffic: '交通',
  activities: '门票活动', activity: '门票活动', attractions: '门票活动',
  tickets: '门票', entertainment: '娱乐',
  shopping: '购物', total: '总计', sum: '总计', overall: '总计',
  misc: '其他', other: '其他', others: '其他', insurance: '保险',
  flight: '机票', flights: '机票', train: '火车', railway: '火车',
  daily: '每日', 'per day': '每日', budget: '预算', note: '说明', notes: '说明',
};
const keyZh = (k) => KEY_ZH[String(k).toLowerCase().trim()] || k;

function toText(v, depth) {
  depth = depth || 0;
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (depth > 3) return '';
  if (Array.isArray(v)) return v.map((it) => toText(it, depth + 1)).filter(Boolean).join('\n');
  return Object.keys(v).map((k) => {
    const raw = v[k];
    const val = toText(raw, depth + 1);
    if (!val) return '';
    const shown = typeof raw === 'number' ? `${raw} 元` : val;
    const lines = shown.split('\n');
    return lines.length === 1
      ? `${keyZh(k)}：${lines[0]}`
      : `${keyZh(k)}：\n${lines.map((l) => (l ? '  ' + l : l)).join('\n')}`;
  }).filter(Boolean).join('\n');
}

function zhifyLineKeys(s) {
  if (!s || typeof s !== 'string') return s;
  return s.split('\n').map((line) => {
    const m = line.match(/^\s*([A-Za-z][A-Za-z ]{1,24})\s*[:：]\s*/);
    if (m) {
      const zh = KEY_ZH[m[1].toLowerCase().trim()];
      if (zh) return line.replace(m[0], `${zh}：`);
    }
    return line;
  }).join('\n');
}

let fails = 0;
function ok(cond, name, actual) {
  if (cond) console.log('PASS ' + name);
  else { fails++; console.log('FAIL ' + name + ' => ' + actual); }
}

// 用例 1：截图里的对象型预算（已入库的坏数据）
const b1 = toText({ accommodation: 2500, food: 1500, transport: 1800, activities: 1200, total: 6900 });
ok(b1 === '住宿：2500 元\n餐饮：1500 元\n交通：1800 元\n门票活动：1200 元\n总计：6900 元', '对象型预算转中文', b1);

// 用例 2：已被旧版拍平成字符串的英文键
const b2 = zhifyLineKeys('accommodation：2500\nfood: 1500\nGrand Total: 6900');
ok(b2 === '住宿：2500\n餐饮：1500\nGrand Total: 6900', '字符串行首英文键翻译（未知键保留）', b2);

// 用例 3：嵌套对象
const b3 = toText({住宿: {经济型: '200/晚', 舒适型: '400/晚'}, 总计: 3000});
ok(b3.includes('住宿：\n  经济型：200/晚') && b3.includes('总计：3000 元'), '嵌套对象缩进+数值补元', b3);

// 用例 4：正常中文文本原样通过
const b4 = zhifyLineKeys(toText('国庆期间人流较多，提前预订住宿和景点门票'));
ok(b4 === '国庆期间人流较多，提前预订住宿和景点门票', '纯中文不受影响', b4);

console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
