/**
 * 额度规则单测（纯逻辑，不联网、不依赖 wx-server-sdk）
 *   node scripts/test-quota.js
 *
 * 钉的是「钱相关」的规则：扣费顺序、日限额、会员周期、邀请封顶、发货加权益。
 * 这些错了要么用户骂娘，要么你亏钱，必须钉死。
 */
const R = require('../cloudfunctions/quota/rules');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`); }
}

const DAY = 86400000;
const T0 = Date.now();

console.log('== 1. 新用户：注册送 3 次，30 天有效 ==');
{
  const u = R.normalizeUser({});
  ok(u.quota === 0 && u.giftQuota === 0, '空档案归一化后额度为 0', u);
  const fresh = { giftQuota: R.LIMITS.gift, giftExpireAt: T0 + 30 * DAY };
  ok(R.available(fresh, T0).total === 3, '新用户可用 3 次', R.available(fresh, T0));
  ok(R.available(fresh, T0 + 31 * DAY).total === 0, '超过 30 天赠送额度失效', R.available(fresh, T0 + 31 * DAY));
  ok(R.canConsume(fresh, T0 + 31 * DAY).reason === 'no_quota', '过期后判定为没额度（需付费）');
  ok(R.canConsume(fresh, T0 + 31 * DAY).needPay === true, '没额度时带 needPay，前端弹付费引导');
}

console.log('== 2. 扣费顺序：先用快过期的赠送，再用长期额度 ==');
{
  // 会员优先
  const vip = { vipUntil: T0 + 10 * DAY, quota: 5, giftQuota: 2, giftExpireAt: T0 + 5 * DAY };
  ok(R.applyConsume(vip, T0).source === 'vip', '有会员时先扣会员次数', R.applyConsume(vip, T0).source);
  // 无会员：先赠送
  const g = { quota: 5, giftQuota: 2, giftExpireAt: T0 + 5 * DAY };
  const r1 = R.applyConsume(g, T0);
  ok(r1.source === 'gift' && r1.patch.giftQuota === 1, '无会员时先扣赠送额度（避免过期浪费）', r1.patch);
  // 赠送用完 → 扣长期
  const g2 = { quota: 5, giftQuota: 0 };
  const r2 = R.applyConsume(g2, T0);
  ok(r2.source === 'quota' && r2.patch.quota === 4, '赠送用完后扣长期额度', r2.patch);
}

console.log('== 3. 会员每月 50 次，跨月自动重置 ==');
{
  const vip = { vipUntil: T0 + 40 * DAY, vipMonth: R.monthKey(T0), vipUsed: 49 };
  ok(R.vipLeft(vip, T0) === 1, '本月已用 49 → 还剩 1 次', R.vipLeft(vip, T0));
  const after = R.applyConsume(vip, T0);
  ok(after.patch.vipUsed === 50, '再扣一次变 50', after.patch);
  const used = Object.assign({}, vip, after.patch);
  ok(R.canConsume(used, T0).ok === false, '用满 50 次后不能再生成', R.canConsume(used, T0));
  // 跨月：下个月 vipUsed 归零
  const nextMonth = T0 + 32 * DAY;
  const vip2 = Object.assign({}, vip, { vipUntil: T0 + 60 * DAY, vipUsed: 50 });
  ok(R.vipLeft(vip2, nextMonth) === 50, '跨月后会员次数重置为 50', R.vipLeft(vip2, nextMonth));
  ok(R.isVip(vip2, T0 + 61 * DAY) === false, '会员到期后不再是会员', R.isVip(vip2, T0 + 61 * DAY));
}

console.log('== 4. 每日生成上限（防刷，也保护高德日配额）==');
{
  const u = { quota: 100, dayStat: { d: R.dayKey(T0), gen: R.LIMITS.freeDayGen } };
  const r = R.canConsume(u, T0);
  ok(r.ok === false && r.reason === 'day_limit', '非会员每天最多 3 次生成', r);
  ok(r.needPay === false, '撞日限额不该让用户去付费（付费也用不了）', r.needPay);
  const vip = { vipUntil: T0 + DAY, dayStat: { d: R.dayKey(T0), gen: 4 } };
  ok(R.canConsume(vip, T0).ok === true, '会员每天 5 次，第 5 次放行', R.canConsume(vip, T0));
  // 跨天重置
  const u2 = { quota: 100, dayStat: { d: '2020-01-01', gen: 99 } };
  ok(R.canConsume(u2, T0).ok === true, '换一天后日计数归零', R.todayStat(u2, T0));
}

console.log('== 5. 大纲重生成 / 建议刷新的日限额（不扣额度，只计次）==');
{
  const u = { dayStat: { d: R.dayKey(T0), outline: R.LIMITS.dayOutlineFree } };
  ok(R.canHit(u, T0, 'outline').ok === false, '非会员每天最多换 5 次方案');
  const vip = { vipUntil: T0 + DAY, dayStat: { d: R.dayKey(T0), outline: 19 } };
  ok(R.canHit(vip, T0, 'outline').ok === true, '会员可换 20 次');
  const t = { dayStat: { d: R.dayKey(T0), tips: R.LIMITS.tipsPerTripDay } };
  ok(R.canHit(t, T0, 'tips').ok === false, '每个行程每天最多刷新 5 次建议');
  const hit = R.applyHit({ dayStat: { d: R.dayKey(T0) } }, T0, 'outline');
  ok(hit.patch.dayStat.outline === 1, '计次写回当天统计', hit.patch.dayStat);
}

console.log('== 6. 退款（生成失败不收钱）==');
{
  const u = { quota: 5, dayStat: { d: R.dayKey(T0), gen: 2 }, totalGen: 7 };
  const r = R.applyRefund(u, T0, 'quota');
  ok(r.patch.quota === 6, '退款把额度还回去', r.patch.quota);
  ok(r.patch.dayStat.gen === 1 && r.patch.totalGen === 6, '日计数与总计数一起回退', r.patch);
  const rv = R.applyRefund({ vipUsed: 3, vipMonth: R.monthKey(T0) }, T0, 'vip');
  ok(rv.patch.vipUsed === 2, '会员退款退回会员次数', rv.patch);
}

console.log('== 7. 发货：次卡加次数、月卡延长期限 ==');
{
  const u = { quota: 2 };
  const r1 = R.applyDeliver(u, T0, 'plan_1');
  ok(r1.ok && r1.patch.quota === 3, '单次卡 +1 次', r1.patch);
  const r2 = R.applyDeliver(u, T0, 'plan_5');
  ok(r2.ok && r2.patch.quota === 7, '5 次卡 +5 次', r2.patch);
  const r3 = R.applyDeliver({ vipUntil: 0 }, T0, 'vip_month');
  ok(r3.ok && r3.patch.vipUntil > T0 + 29 * DAY, '月卡从今天起 +30 天', r3.patch.vipUntil);
  // 连买两个月：从到期日续，不覆盖
  const has = { vipUntil: T0 + 10 * DAY };
  const r4 = R.applyDeliver(has, T0, 'vip_month');
  ok(r4.patch.vipUntil > T0 + 39 * DAY, '已有会员期时从到期日续（连买不吃亏）', r4.patch.vipUntil - T0);
  ok(R.applyDeliver(u, T0, 'not_exist').ok === false, '未知商品拒绝发货');
}

console.log('== 8. 邀请：双方各得 1 次，封顶 10 次 ==');
{
  const a = { quota: 0, inviteCount: 0, inviteRewarded: 0 };
  const b = { quota: 0 };
  const r = R.inviteReward(a, b, T0);
  ok(r.inviterPatch.quota === 1 && r.inviteePatch.quota === 1, '双方各 +1 次', r);
  ok(r.inviterPatch.inviteCount === 1 && r.inviterPatch.inviteRewarded === 1, '邀请人数与已奖励次数都记');
  const capped = { quota: 0, inviteCount: 10, inviteRewarded: R.LIMITS.inviteCap };
  const r2 = R.inviteReward(capped, b, T0);
  ok(r2.inviterPatch.quota === undefined && r2.inviterPatch.inviteCount === 11,
    '达到封顶后只记人数不加次数（防刷小号）', r2.inviterPatch);
  const code = R.genInviteCode('openid-abc');
  ok(/^[A-Z2-9]{6}$/.test(code), '邀请码 6 位、去掉易混淆字符', code);
  ok(R.genInviteCode('openid-abc') !== R.genInviteCode('openid-abc'), '每次生成的邀请码不同');
}

console.log('== 9. 商品表与价格（分）==');
{
  const ids = R.GOODS.map((g) => g.id);
  ok(ids.length === 3, '三档套餐', ids);
  ok(R.goodsById('plan_1').price === 300, '单次 ¥3 = 300 分');
  ok(R.goodsById('plan_5').price === 1000, '5 次卡 ¥10 = 1000 分');
  ok(R.goodsById('vip_month').price === 2000, '月卡 ¥20 = 2000 分');
  ok(R.GOODS.every((g) => Number.isInteger(g.price) && g.price > 0), '价格都是正整数分（微信要求）');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
