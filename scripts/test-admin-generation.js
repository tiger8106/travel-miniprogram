const assert = require('assert');
const { generationCount } = require('../cloudfunctions/admin/generation-count');

async function main() {
  let query;
  const db = {
    collection(name) {
      assert.strictEqual(name, 'quota_logs');
      return {
        where(value) {
          query = value;
          return { count: async () => ({ total: 3 }) };
        },
      };
    },
  };
  assert.strictEqual(await generationCount(db, { _openid: 'old-admin', totalGen: 0 }), 3);
  assert.deepStrictEqual(query, { _openid: 'old-admin', action: 'consume' });
  assert.strictEqual(await generationCount(db, { _openid: 'normal-user', totalGen: 5 }), 5);
  assert.strictEqual(await generationCount({ collection() { throw new Error('unavailable'); } },
    { _openid: 'normal-user', totalGen: 2 }), 2);
  console.log('✅ 管理后台生成次数：历史流水补齐、旧统计优先、查询失败兜底');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
