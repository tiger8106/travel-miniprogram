// cloudfunctions/login/index.js
// 微信登录：拿 openid

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  if (!openid) {
    return { code: -1, msg: '未获取到 openid' };
  }

  // 查询/初始化用户档案
  const db = cloud.database();
  const usersColl = db.collection('users');
  let user;
  try {
    const res = await usersColl.where({ _openid: openid }).limit(1).get();
    user = res.data && res.data[0];
  } catch (e) {
    // ignore
  }

  if (!user) {
    const now = Date.now();
    await usersColl.add({
      data: {
        _openid: openid,
        createdAt: now,
        lastLoginAt: now,
        nickname: '旅行者',
      },
    });
  } else {
    await usersColl.doc(user._id).update({
      data: { lastLoginAt: Date.now() },
    }).catch(() => {});
  }

  return {
    code: 0,
    data: {
      openid,
      appid: wxContext.APPID,
      unionid: wxContext.UNIONID,
    },
  };
};