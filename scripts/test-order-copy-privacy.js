const assert = require('assert');
const fs = require('fs');

let page;
let component;
let copied = '';
let modal = null;
let toast = '';
global.Page = (definition) => { page = definition; };
global.Component = (definition) => { component = definition; };
global.getApp = () => ({});
global.wx = {
  setClipboardData({ data, success }) { copied = data; success(); },
  openPrivacyContract({ fail }) { fail({ errMsg: 'not configured' }); },
  showModal(options) { modal = options; },
  showToast({ title }) { toast = title; },
};
require('../miniprogram/pages/orders/orders');
require('../miniprogram/components/privacy-popup/privacy-popup');

async function run() {
  const context = { setData() {} };
  page.onCopyDetail.call(context, { currentTarget: { dataset: { value: 'VPMUIN9HTGLY7A2R' } } });
  assert.strictEqual(copied, 'VPMUIN9HTGLY7A2R');
  copied = '';
  page.onCopyDetail.call(context, { currentTarget: { dataset: { value: '' } } });
  assert.strictEqual(copied, '', '空订单号不写入剪贴板');
  wx.setClipboardData = ({ fail }) => fail({ errMsg: 'clipboard blocked' });
  page.onCopyDetail.call(context, { currentTarget: { dataset: { value: 'VPMUIN9HTGLY7A2R' } } });
  assert(/复制失败/.test(toast), '剪贴板失败要给出可见的降级提示');
  component.methods.openContract();
  assert(modal && /隐私指引未能打开/.test(modal.title));
  const wxml = fs.readFileSync('miniprogram/pages/orders/orders.wxml', 'utf8');
  assert(/catchtap="onCopyDetail"/.test(wxml));
  console.log('订单号复制与隐私指引失败提示回归通过');
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
