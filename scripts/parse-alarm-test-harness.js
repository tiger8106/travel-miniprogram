// 直接加载生产函数的内部纯规则；只替换云 SDK，不复制清洗/去重实现。
const fs = require('fs');
const path = require('path');
const Module = require('module');

module.exports = function loadParsingRules() {
  const filename = path.resolve(__dirname, '../cloudfunctions/parseTravelPlan/index.js');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const actualRequire = Module.createRequire(filename);
  compiled.require = (name) => name === 'wx-server-sdk' ? { init() {}, DYNAMIC_CURRENT_ENV: 'test' }
    : name === 'mammoth' ? {} : actualRequire(name);
  compiled._compile(`${fs.readFileSync(filename, 'utf8')}\nexports.rules = { cleanAlarms, prepareAlarmRecords, dedupeAlarmRecords };`, filename);
  return compiled.exports.rules;
};
