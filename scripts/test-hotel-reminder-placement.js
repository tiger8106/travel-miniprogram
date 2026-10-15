const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'miniprogram/pages');
const homeWxml = fs.readFileSync(path.join(root, 'index/index.wxml'), 'utf8');
const homeJs = fs.readFileSync(path.join(root, 'index/index.js'), 'utf8');
const remindersWxml = fs.readFileSync(path.join(root, 'tickets/tickets.wxml'), 'utf8');
const remindersJs = fs.readFileSync(path.join(root, 'tickets/tickets.js'), 'utf8');

assert(!/hotel-booking-hint|hotelBookingHint/.test(homeWxml + homeJs),
  '首页行程页不得再显示酒店提前预订提示');
assert(/wx:if="\{\{hotelHint\}\}"[^>]*hotel-booking-hint/.test(remindersWxml),
  '酒店预订引导应只在提醒页面按酒店待办显示');
assert(/酒店可随时提前预订/.test(remindersWxml));
assert(/hotelHint:\s*items\.some\(\(a\) => a\.type === 'hotel'/.test(remindersJs));
assert(/key: 'hotel', label: '酒店住宿'/.test(remindersJs), '酒店事项仍须保留在提醒分类');
console.log('✅ 酒店提前预订提示只在提醒页面展示，行程页不再重复出现');
