// cloudfunctions/login/index.js
// 微信登录：拿 openid + 用户档案（users 表）
// action:
//   （默认）登录：查询/初始化用户档案，返回 openid + profile
//   updateProfile：保存昵称/头像

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  if (!openid) {
    return { code: -1, msg: '未获取到 openid' };
  }

  const db = cloud.database();
  const usersColl = db.collection('users');

  // 查询/初始化用户档案
  let user;
  try {
    const res = await usersColl.where({ _openid: openid }).limit(1).get();
    user = res.data && res.data[0];
  } catch (e) {
    // collection 可能不存在等情况，忽略
  }

  if (!user) {
    const now = Date.now();
    const doc = {
      _openid: openid,
      createdAt: now,
      lastLoginAt: now,
      nickname: '旅行者',
      avatarUrl: '',
    };
    await usersColl.add({ data: doc }).catch(() => {});
    user = doc;
  } else {
    await usersColl.doc(user._id).update({
      data: { lastLoginAt: Date.now() },
    }).catch(() => {});
  }

  // 保存昵称/头像
  if (event.action === 'updateProfile' && event.profile && typeof event.profile === 'object') {
    const patch = {};
    if (typeof event.profile.nickname === 'string' && event.profile.nickname.trim()) {
      patch.nickname = event.profile.nickname.trim().slice(0, 30);
    }
    if (typeof event.profile.avatarUrl === 'string') {
      patch.avatarUrl = event.profile.avatarUrl.slice(0, 500);
    }
    if (Object.keys(patch).length) {
      if (user._id) {
        await usersColl.doc(user._id).update({ data: patch }).catch(() => {});
      } else {
        await usersColl.where({ _openid: openid }).update({ data: patch }).catch(() => {});
      }
      user = Object.assign({}, user, patch);
    }
  }

  return {
    code: 0,
    data: {
      openid,
      appid: wxContext.APPID,
      unionid: wxContext.UNIONID,
      profile: {
        nickname: user.nickname || '旅行者',
        avatarUrl: user.avatarUrl || '',
      },
    },
  };
};
