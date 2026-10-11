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

export const AIRSCRIPT_VERSION = '1.1.1';

export const AIRSCRIPT_SOURCE = `/**
 * 理财、基金现场竞标 · 金山文档同步脚本 v${AIRSCRIPT_VERSION}（协议 1）
 *
 * 用途：本机竞标程序通过「脚本令牌」调用本脚本，读取各单位工作表中领导填写的内容，
 *       并把处理结果写回表格。本脚本不做任何业务判断。
 * 两种用法：
 *   - 一个文件 16 张工作表：脚本放在这个文件里；
 *   - 每家单位一个文件（推荐，各单位互相看不到）：脚本放在只有工作人员能打开的「总控」文件里，
 *     通过 KSDrive.openFile 打开各单位文件读写（需在脚本编辑器的「服务」中添加「云文档API」）。
 * 用法见《金山文档接入说明》。请整体粘贴，不要修改；更新时从管理端重新下载并整体替换。
 */
var PROTOCOL = 1;
var SCRIPT_VERSION = '${AIRSCRIPT_VERSION}';
var MAX_WRITES = 3000;
var MAX_READS = 64;

function listSheetNames(app) {
  var names = [];
  var sheets = app.Sheets;
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

function selfCheck(result) {
  result.selfCheck = true;
  console.log('自检：脚本可以运行（版本 ' + SCRIPT_VERSION + '），本文件工作表：' + listSheetNames(Application).join('、'));
  try {
    var t = typeof KSDrive.openFile;
    console.log('自检：「云文档API」服务可用（' + t + '）。可以回到竞标程序点「一键连接」。');
    result.cloudDocs = true;
  } catch (e) {
    result.ok = false;
    result.cloudDocs = false;
    console.log('自检：「云文档API」服务不可用：' + e);
    console.log('请在左侧「服务」中添加「云文档API」，点工具栏的保存，再点运行；如弹出授权请允许。只用「一个文件 16 张工作表」时可忽略。');
  }
  return result;
}

function main(argv) {
  var result = {
    protocol: PROTOCOL,
    scriptVersion: SCRIPT_VERSION,
    supportsFiles: true,
    ok: true,
    sheets: [],
    missingSheets: [],
    reads: [],
    written: 0,
    errors: []
  };
  // 在脚本编辑器里直接点「运行」（没有参数）：自检，检查脚本与「云文档API」服务是否可用
  if (!argv || argv.protocol === undefined) return selfCheck(result);
  if (argv.protocol !== PROTOCOL) {
    result.ok = false;
    result.errors.push('协议版本不匹配，请从管理端重新下载脚本并整体替换');
    return result;
  }
  var writes = argv.writes || [];
  var reads = argv.reads || [];
  if (writes.length > MAX_WRITES || reads.length > MAX_READS) {
    result.ok = false;
    result.errors.push('单次读写数量超出限制');
    return result;
  }

  // 本文件 + 本次用到的其他文件（每个文件只打开一次，结束时关闭）
  var books = { '': { app: Application, names: listSheetNames(Application), error: null } };
  var opened = [];
  result.sheets = books[''].names;
  function bookOf(file) {
    var key = file || '';
    if (books[key]) return books[key];
    try {
      var f = KSDrive.openFile(file);
      opened.push(f);
      books[key] = { app: f.Application, names: listSheetNames(f.Application), error: null };
    } catch (e) {
      books[key] = { app: null, names: [], error: '无法打开文件（请确认链接正确、脚本所有者有权限，且已在「服务」中添加云文档API）：' + e };
    }
    return books[key];
  }
  var missing = {};
  function sheetOf(file, name) {
    var b = bookOf(file);
    if (b.error) return { error: b.error };
    if (b.names.indexOf(name) < 0) {
      missing[name] = true;
      return { error: null, sheet: null };
    }
    return { error: null, sheet: b.app.Sheets.Item(name) };
  }

  // 先写后读：本次读取的内容已包含本次写入
  for (var i = 0; i < writes.length; i++) {
    var w = writes[i];
    var ws = sheetOf(w.file, w.sheet);
    if (ws.error) {
      result.errors.push(w.sheet + '：' + ws.error);
      continue;
    }
    if (!ws.sheet) continue;
    try {
      ws.sheet.Range(w.range).Value = isSingleCell(w.values) ? w.values[0][0] : w.values;
      result.written++;
    } catch (e) {
      result.errors.push('写入 ' + w.sheet + '!' + w.range + ' 失败：' + e);
    }
  }
  for (var j = 0; j < reads.length; j++) {
    var r = reads[j];
    var rs = sheetOf(r.file, r.sheet);
    if (rs.error || !rs.sheet) {
      result.reads.push({ file: r.file, sheet: r.sheet, range: r.range, values: null, error: rs.error || undefined });
      continue;
    }
    try {
      result.reads.push({ file: r.file, sheet: r.sheet, range: r.range, values: to2D(rs.sheet.Range(r.range).Value2) });
    } catch (e2) {
      result.reads.push({ file: r.file, sheet: r.sheet, range: r.range, values: null, error: String(e2) });
    }
  }
  for (var k = 0; k < opened.length; k++) {
    try {
      opened[k].close();
    } catch (e3) {}
  }
  for (var m in missing) result.missingSheets.push(m);
  if (result.errors.length > 0) result.ok = false;
  return result;
}

return main(Context.argv);
`;
