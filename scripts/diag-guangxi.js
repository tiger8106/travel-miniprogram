// 临时诊断：把广西行程翻车地址全部用当前 geocodeOne 真跑一遍，
// 打印命中坐标/步骤/命中名，与用户截图逐一对照。
// 用法：node scripts/diag-guangxi.js
const fs = require('fs');
const path = require('path');

// 先注入真实 Key（geocode.js 在 require 时读取环境变量）
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((l) => {
    const m = l.trim().match(/^([A-Za-z_]+)\s*=\s*(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  });
}

const G = require('../cloudfunctions/generatePlan/geocode.js');
process.env.AMAP_MIN_GAP_MS = process.env.AMAP_MIN_GAP_MS || '120';

const REGION = '广西壮族自治区 桂林 阳朔 南宁 崇左 大新';

const CASES = [
  ['金童路一奥天地', '重庆'],
  ['金童路一奥天地', REGION],
  ['重庆西站', '重庆'],
  ['重庆北站', REGION],
  ['重庆北站', '重庆'],
  ['南宁东站', REGION],
  ['金坑大寨停车场', REGION],
  ['大寨停车场', REGION],
  ['龙脊梯田金坑大寨停车场', REGION],
  ['椿记烧鹅（中山店）', REGION],
  ['椿记烧鹅', REGION],
  ['象鼻山', REGION],
  ['正阳步行街', REGION],
  ['磨盘山码头', REGION],
  ['阳朔西街附近', REGION],
  ['阳朔西街', REGION],
  ['德天跨国瀑布', REGION],
  ['德天瀑布服务中心', REGION],
  ['逸喆酒店（南宁朝阳广场地铁站店）', REGION],
  ['刘姐啤酒鱼（西街总店）', REGION],
  ['大新明仕酒店', REGION],
];

(async () => {
  for (const [addr, city] of CASES) {
    const r = await G.geocodeOne(addr, city);
    if (r) {
      console.log('OK   | %-22s @%-14s → (%s, %s) %s', addr, city.slice(0, 12), r.lon, r.lat, r.matchedName);
    } else {
      console.log('FAIL | %-22s @%s', addr, city.slice(0, 12));
    }
    await new Promise((s) => setTimeout(s, 400)); // QPS 限速
  }
})();
