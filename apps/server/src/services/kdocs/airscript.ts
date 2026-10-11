/**
 * 粘贴到金山表格「AirScript 脚本编辑器」中的脚本（管理端可下载）。
 *
 * 设计原则：脚本只按本机程序的指令读写单元格，不做任何业务判断；规则全部在本机完成，
 * 以后调整规则无需重新粘贴脚本。模拟金山文档也执行这同一份源码，保证演练与正式一致。
 *
 * 只使用 AirScript 1.0 表格 API 中最基础的部分：Application.Sheets（Count / Item）、Sheet.Name、
 * Sheet.Range(地址).Value2（读）/ .Value（写）、Context.argv，以及脚本末尾 return 返回结果。
 * 语法保持 ES5（var / function），不依赖新语法。
 */

export const AIRSCRIPT_VERSION = '1.0.0';

export const AIRSCRIPT_SOURCE = `/**
 * 理财、基金现场竞标 · 金山文档同步脚本 v${AIRSCRIPT_VERSION}（协议 1）
 *
 * 用途：本机竞标程序通过「脚本令牌」调用本脚本，读取各单位工作表中领导填写的内容，
 *       并把处理结果写回表格。本脚本不做任何业务判断。
 * 用法：见《金山文档接入说明》。请整体粘贴，不要修改；更新时从管理端重新下载并整体替换。
 */
var PROTOCOL = 1;
var MAX_WRITES = 3000;
var MAX_READS = 64;

function listSheetNames() {
  var names = [];
  var sheets = Application.Sheets;
  for (var i = 1; i <= sheets.Count; i++) {
    names.push(String(sheets.Item(i).Name));
  }
  return names;
}

function to2D(v) {
  if (v === undefined || v === null) return [[null]];
  if (!Array.isArray(v)) return [[v]];
  if (v.length > 0 && !Array.isArray(v[0])) return [v];
  return v;
}

function isSingleCell(values) {
  return values.length === 1 && Array.isArray(values[0]) && values[0].length === 1;
}

function main(argv) {
  var result = { protocol: PROTOCOL, ok: true, sheets: [], missingSheets: [], reads: [], written: 0, errors: [] };
  if (!argv || argv.protocol !== PROTOCOL) {
    result.ok = false;
    result.errors.push('协议版本不匹配，请从管理端重新下载脚本并整体替换');
    return result;
  }
  var names = listSheetNames();
  result.sheets = names;
  var writes = argv.writes || [];
  var reads = argv.reads || [];
  if (writes.length > MAX_WRITES || reads.length > MAX_READS) {
    result.ok = false;
    result.errors.push('单次读写数量超出限制');
    return result;
  }
  var missing = {};
  function sheetOf(name) {
    if (names.indexOf(name) < 0) {
      missing[name] = true;
      return null;
    }
    return Application.Sheets.Item(name);
  }
  // 先写后读：本次读取的内容已包含本次写入
  for (var i = 0; i < writes.length; i++) {
    var w = writes[i];
    var ws = sheetOf(w.sheet);
    if (!ws) continue;
    try {
      ws.Range(w.range).Value = isSingleCell(w.values) ? w.values[0][0] : w.values;
      result.written++;
    } catch (e) {
      result.errors.push('写入 ' + w.sheet + '!' + w.range + ' 失败：' + e);
    }
  }
  for (var j = 0; j < reads.length; j++) {
    var r = reads[j];
    var rs = sheetOf(r.sheet);
    if (!rs) {
      result.reads.push({ sheet: r.sheet, range: r.range, values: null });
      continue;
    }
    try {
      result.reads.push({ sheet: r.sheet, range: r.range, values: to2D(rs.Range(r.range).Value2) });
    } catch (e2) {
      result.reads.push({ sheet: r.sheet, range: r.range, values: null, error: String(e2) });
    }
  }
  for (var k in missing) result.missingSheets.push(k);
  if (result.errors.length > 0) result.ok = false;
  return result;
}

return main(Context.argv);
`;
