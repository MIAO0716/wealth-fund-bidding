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

export const AIRSCRIPT_VERSION = '1.2.0';

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

  // 按文件分组：金山同一时刻只能额外打开一个文件，所以逐个打开 → 读写 → 关闭，再处理下一个
  var groups = {};
  var order = [];
  function groupOf(file) {
    var key = file || '';
    if (!groups[key]) {
      groups[key] = { file: key, writes: [], reads: [] };
      order.push(key);
    }
    return groups[key];
  }
  for (var i = 0; i < writes.length; i++) groupOf(writes[i].file).writes.push(writes[i]);
  for (var j = 0; j < reads.length; j++) groupOf(reads[j].file).reads.push({ index: j, read: reads[j] });
  var readResults = [];
  var missing = {};
  result.sheets = listSheetNames(Application);

  for (var g = 0; g < order.length; g++) {
    var grp = groups[order[g]];
    var app = Application;
    var opened = null;
    var openError = null;
    if (grp.file) {
      try {
        opened = KSDrive.openFile(grp.file);
        app = opened.Application;
      } catch (e) {
        openError = '无法打开文件（请确认链接正确、脚本所有者有权限，且已在「服务」中添加云文档API）：' + e;
      }
    }
    try {
      var names = openError ? [] : listSheetNames(app);
      // 先写后读：本次读取的内容已包含本次写入
      for (var wi = 0; wi < grp.writes.length; wi++) {
        var w = grp.writes[wi];
        if (openError) {
          result.errors.push(w.sheet + '：' + openError);
          continue;
        }
        if (names.indexOf(w.sheet) < 0) {
          missing[w.sheet] = true;
          continue;
        }
        try {
          app.Sheets.Item(w.sheet).Range(w.range).Value = isSingleCell(w.values) ? w.values[0][0] : w.values;
          result.written++;
        } catch (e1) {
          result.errors.push('写入 ' + w.sheet + '!' + w.range + ' 失败：' + e1);
        }
      }
      for (var ri = 0; ri < grp.reads.length; ri++) {
        var r = grp.reads[ri].read;
        var out = { file: r.file, sheet: r.sheet, range: r.range, values: null };
        if (openError) {
          out.error = openError;
        } else if (names.indexOf(r.sheet) < 0) {
          missing[r.sheet] = true;
        } else {
          try {
            out.values = to2D(app.Sheets.Item(r.sheet).Range(r.range).Value2);
          } catch (e2) {
            out.error = String(e2);
          }
        }
        readResults[grp.reads[ri].index] = out;
      }
    } finally {
      if (opened) {
        try {
          opened.close();
        } catch (e3) {}
      }
    }
  }
  result.reads = readResults;
  for (var m in missing) result.missingSheets.push(m);
  if (result.errors.length > 0) result.ok = false;
  return result;
}

return main(Context.argv);
`;
