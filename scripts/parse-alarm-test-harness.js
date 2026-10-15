// 直接加载生产函数的内部纯规则；只替换云 SDK，不复制清洗/去重实现。
const fs = require('fs');
const path = require('path');
const Module = require('module');

module.exports = function loadParsingRules() {
  const filename = path.resolve(__dirname, '../cloudfunctions/parseTravelPlan/index.js');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    if (name === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'test' };
    if (name === 'mammoth') return {};
    return originalLoad.call(this, name, parent, isMain);
  };
  try {
    compiled._compile(`${fs.readFileSync(filename, 'utf8')}\nexports.rules = { cleanAlarms, prepareAlarmRecords, dedupeAlarmRecords };`, filename);
  } finally {
    Module._load = originalLoad;
  }
  return compiled.exports.rules;
};
