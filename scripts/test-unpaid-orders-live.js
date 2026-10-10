// 真实微信开发者工具自动化；默认只读取。--exercise 会继续签名并取消本人未支付订单，不拉起扣款。
const assert = require('assert');
const path = require('path');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const automator = require(option('--automator', process.env.MINIPROGRAM_AUTOMATOR_PATH || 'miniprogram-automator'));
const appid = require(path.resolve(__dirname, '../project.config.json')).appid;
const wsEndpoint = option('--ws', 'ws://127.0.0.1:9420');
const exercise = args.includes('--exercise');
const uiCancel = args.includes('--ui-cancel');
const audit = exercise || uiCancel || args.includes('--audit');

async function main() {
  const mini = await automator.connect({ wsEndpoint });
  try {
    console.error('[orders-live] 已连接自动化端口，正在核对账号和云环境');
    const call = (data) => mini.evaluate(async (input) => {
      const r = await wx.cloud.callFunction({ name: 'virtualPay', data: input });
      return r.result;
    }, data);
    const identity = await mini.evaluate(async () => {
      const r = await wx.cloud.callFunction({ name: 'admin', data: { action: 'identity' } });
      return { appid: wx.getAccountInfoSync().miniProgram.appId,
        admin: !!(r.result && r.result.code === 0 && r.result.data && r.result.data.isAdmin) };
    });
    assert.strictEqual(identity.appid, appid, '自动化连接到了其他小程序');
    assert(identity.admin, '当前开发者工具微信账号不是本项目管理员');
    console.error('[orders-live] 管理员身份已确认，正在读取本人订单');
    if (args.includes('--page')) {
      const page = await mini.currentPage();
      const data = page && await page.data();
      console.log(JSON.stringify({ page: page && page.path,
        cancellingNo: data && data.cancellingNo, paying: data && data.paying, loadError: data && data.loadError,
        list: data && data.list && data.list.slice(0, 3).map((o) => ({ outTradeNo: o.outTradeNo, status: o.status, notice: o.userNotice })) }, null, 2));
      if (args.includes('--screenshot')) await mini.screenshot({ path: option('--screenshot') });
      return;
    }
    const diag = await call({ action: 'diag' });
    assert.strictEqual(diag.code, 0);
    const listAll = async () => {
      const list = [];
      for (let page = 1; ; page++) {
        const r = await call({ action: 'orderList', page });
        assert.strictEqual(r.code, 0, r.msg);
        list.push(...r.data.list);
        if (!r.data.hasMore) return list;
        assert(r.data.list.length, '分页游标未推进');
      }
    };
    const all = await listAll();
    const creditState = async () => mini.evaluate(async () => {
      const r = await wx.cloud.callFunction({ name: 'quota', data: { action: 'info' } });
      if (!r.result || r.result.code !== 0) throw new Error('无法核对测试前后额度');
      const q = r.result.data;
      return { quota: q.quota, gift: q.gift, giftExpireAt: q.giftExpireAt, vipUntil: q.vipUntil };
    });
    const creditsBefore = exercise || uiCancel ? await creditState() : null;
    const pending = all.filter((o) => ['created', 'verifying', 'paid'].includes(o.status));
    const report = { mode: exercise ? 'exercise' : uiCancel ? 'ui-cancel' : audit ? 'audit' : 'read',
      version: diag.data.version, total: all.length, candidates: pending.length, orders: [] };
    if (!audit) {
      const ledger = await call({ action: 'adminLedger' });
      const details = new Map((ledger.data && ledger.data.list || []).map((o) => [o.outTradeNo, o]));
      report.orders = pending.map((o) => {
        const detail = details.get(o.outTradeNo) || {};
        return { outTradeNo: o.outTradeNo, status: o.status,
          platformStatus: detail.platformStatus, paidFee: detail.paidFee,
          reason: detail.lastQueryReason, detail: detail.lastQueryDetail };
      });
    } else {
      assert.strictEqual(report.version, 'v1.6-unpaid-recovery', '必须先部署本次 virtualPay，再执行完整核查');
      for (const o of pending) {
        const r = await call({ action: 'adminInspectOrder', outTradeNo: o.outTradeNo });
        assert.strictEqual(r.code, 0, r.msg);
        const check = r.data;
        const item = { outTradeNo: o.outTradeNo, status: o.status,
          platformStatus: check.query.status, reason: check.query.reason,
          detail: check.query.detail, canCancel: check.canCancel, canRepay: check.canRepay };
        report.orders.push(item);
        if (!exercise || !check.canRepay) continue;
        const code = await mini.evaluate(async () => (await wx.login()).code);
        const pay = await call({ action: 'repay', outTradeNo: o.outTradeNo, code, platform: 'devtools' });
        item.repayCode = pay.code;
        if (pay.code !== 0) { item.repayMessage = pay.msg; continue; }
        const prepared = pay.data;
        assert(prepared.signData && prepared.paySig && prepared.signature, '续付缺少必要签名');
        const signData = JSON.parse(prepared.signData);
        assert.strictEqual(signData.outTradeNo, prepared.outTradeNo);
        assert.strictEqual(signData.env, prepared.env);
        item.payOrderNo = prepared.outTradeNo;
        const cancelled = await call({ action: 'cancelOrder', outTradeNo: prepared.outTradeNo });
        item.cancelCode = cancelled.code;
        if (cancelled.code !== 0) item.cancelMessage = cancelled.msg;
        else item.repeatCancelCode = (await call({ action: 'cancelOrder', outTradeNo: prepared.outTradeNo })).code;
      }
      if (uiCancel) {
        const code = await mini.evaluate(async () => (await wx.login()).code);
        const created = await call({ action: 'createOrder', goodsId: 'plan_1', code, platform: 'devtools' });
        assert.strictEqual(created.code, 0, created.msg);
        const no = created.data.outTradeNo;
        console.error('[orders-live] 页面测试单已创建：' + no);
        const waitState = async (page, status) => {
          for (let attempt = 0; attempt < 60; attempt++) {
            const list = await page.data('list');
            const row = list && list.find((o) => o.outTradeNo === no);
            if (row && row.status === status) return;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          throw new Error('订单页未展示最新状态：' + status);
        };
        let phase = '进入订单页';
        const mockConfirm = args.includes('--mock-confirm');
        try {
          if (mockConfirm) {
            await mini.reLaunch('/pages/index/index');
            await mini.mockWxMethod('showModal', { confirm: true, cancel: false });
          }
          const page = await mini.navigateTo('/pages/orders/orders');
          await waitState(page, 'created');
          const button = await page.$('.act-del');
          assert(button, '待支付卡片缺少取消按钮');
          phase = '点击取消并确认';
          await button.tap();
          if (!mockConfirm) {
            await page.waitFor(500);
            await mini.native().confirmModal();
          }
          await waitState(page, 'cancelled');
          phase = '取消后刷新';
          await page.callMethod('refresh');
          await waitState(page, 'cancelled');
          assert.strictEqual((await call({ action: 'cancelOrder', outTradeNo: no })).code, 0);
          await mini.navigateBack();
          phase = '重新进入订单页';
          const reopened = await mini.navigateTo('/pages/orders/orders');
          await waitState(reopened, 'cancelled');
          report.ui = { outTradeNo: no, clickedCancel: true,
            confirmation: mockConfirm ? 'mocked-user-confirmation' : 'native-modal', refreshed: true, reopened: true };
        } catch (error) {
          const current = await mini.currentPage();
          const data = current && await current.data();
          console.error(JSON.stringify({ mode: 'ui-cancel', outTradeNo: no, phase,
            row: data && data.list && data.list.filter((o) => o.outTradeNo === no).map((o) => ({ status: o.status, notice: o.userNotice })),
            cancellingNo: data && data.cancellingNo, paying: data && data.paying,
            loadError: data && data.loadError, error: error.message }));
          throw error;
        } finally {
          try {
            if (mockConfirm) await mini.restoreWxMethod('showModal');
          } finally {
            const cleanup = await call({ action: 'cancelOrder', outTradeNo: no });
            assert.strictEqual(cleanup.code, 0, cleanup.msg);
          }
        }
      }
      if (exercise) {
        const after = await listAll();
        const states = new Map(after.map((o) => [o.outTradeNo, o.status]));
        report.protectedOrdersUnchanged = all.filter((o) => !pending.includes(o))
          .every((o) => states.get(o.outTradeNo) === o.status);
        report.creditsUnchanged = JSON.stringify(await creditState()) === JSON.stringify(creditsBefore);
        report.orders.forEach((o) => { o.finalStatus = states.get(o.outTradeNo);
          if (o.payOrderNo) o.payOrderStatus = states.get(o.payOrderNo); });
        report.failed = report.orders.filter((o) => o.canCancel
          && (o.repayCode !== 0 || o.cancelCode !== 0 || o.repeatCancelCode !== 0 || o.finalStatus !== 'cancelled'
            || o.payOrderStatus !== 'cancelled')).length;
        report.unresolved = report.orders.filter((o) => !o.canCancel).length;
        report.remainingUnpaid = after.filter((o) => ['created', 'verifying', 'paid'].includes(o.status)).length;
        if (report.failed || report.unresolved || !report.protectedOrdersUnchanged || !report.creditsUnchanged) process.exitCode = 1;
      }
      if (uiCancel && !exercise) report.creditsUnchanged = JSON.stringify(await creditState()) === JSON.stringify(creditsBefore);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally { mini.disconnect(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
