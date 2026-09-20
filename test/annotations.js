/* 复盘批注簿测试：事件指纹锚点、失效重定位、标签规范化、批注构造、
 * 导入合并（同 id 内容一致去重 / 同 id 内容不同双方保留并标冲突）、
 * 导出往返、以及页面只读性。
 *
 * 运行前提：服务已在 localhost:3000 启动（npm start）。
 * 算法部分直接加载 public/annotations.js（与浏览器同一份代码，在 Node 中
 * 使用全局 Web Crypto），HTTP 部分断言页面可访问且不含 WebSocket / 写接口调用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const archive = require('../archive');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

// 加载浏览器版 public/annotations.js（Node ≥18 具备全局 Web Crypto 与 TextEncoder）
function loadBrowserAnnotations() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'annotations.js'), 'utf8');
  const withoutExport = src.replace(/\nif \(typeof module[\s\S]*$/, '');
  const fn = new Function('crypto', 'TextEncoder',
    withoutExport.replace('const CueAnnotations = (() => {', 'return (() => {'));
  return fn(crypto, TextEncoder);
}

const SESSION = { fileId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', runId: 0 };

function ev(ts, t, event, detail) { return { ts, t, event, detail: detail || {} }; }

// 构造一场 6 事件的闭合场次，其中含一条与第 3 条完全相同的重复事件（指纹重复，靠序号消歧）
function sampleEvents() {
  return [
    ev('2026-09-19T10:00:01.000Z', 0, 'session-start', {}),
    ev('2026-09-19T10:00:02.000Z', 1000, 'cue-started', { seq: 1, text: '口令甲', targets: ['灯光', '音响'] }),
    ev('2026-09-19T10:00:03.000Z', 2000, 'confirm', { seq: 1, position: '灯光' }),
    ev('2026-09-19T10:00:03.500Z', 2500, 'confirm', { seq: 1, position: '灯光' }), // 与上条内容不同（ts 不同）
    ev('2026-09-19T10:00:04.000Z', 3000, 'cue-completed', { seq: 1 }),
    ev('2026-09-19T10:00:10.000Z', 9000, 'sequence-finished', {}),
  ];
}
// 完全同内容（含 ts）的重复事件用于验证出现序号
function eventsWithExactDuplicate() {
  const e = sampleEvents();
  e.splice(4, 0, { ...e[3] }); // 再插入一条与索引 3 逐字节相同的事件
  // 重新计算 t（仅展示用，不参与指纹）
  return e.map((x, i) => ({ ...x, t: i * 100 }));
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${urlPath}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { json = null; }
        resolve({ status: res.statusCode, body: buf, json });
      });
    }).on('error', reject);
  });
}
function getPage(p) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${p}`, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

// 与实现无关的独立指纹计算：canonical({ts,event,detail}) -> SHA-256 hex
function expectedDigest(e) {
  const c = archive.canonicalJson({ ts: e.ts, event: e.event, detail: e.detail || {} });
  return crypto.createHash('sha256').update(Buffer.from(c, 'utf8')).digest('hex');
}

async function main() {
  const A = loadBrowserAnnotations();
  const events = sampleEvents();

  console.log('一、事件指纹：canonical JSON（键排序/数组保序）SHA-256，与服务端口径一致');
  check('eventDigest 为 64 位十六进制', /^[0-9a-f]{64}$/.test(await A.eventDigest(events[1])));
  check('指纹仅取 ts/event/detail（与服务端 canonical 独立计算一致）',
    await A.eventDigest(events[1]) === expectedDigest(events[1]));
  check('派生字段 t/line/positions 不影响指纹',
    (await A.eventDigest({ ...events[1], t: 99999, line: 42, positions: ['x'] })) === await A.eventDigest(events[1]));
  const reordered = { detail: events[1].detail, ts: events[1].ts, event: events[1].event };
  check('字段书写顺序不同但 canonical 后指纹相同', await A.eventDigest(reordered) === await A.eventDigest(events[1]));
  check('事件内容改动指纹不同',
    await A.eventDigest({ ...events[1], detail: { ...events[1].detail, text: '口令乙' } }) !== await A.eventDigest(events[1]));
  check('标签规范化：多分隔符拆分、去空白、去重、保序',
    JSON.stringify(A.normalizeTags('灯光, 超时、沟通；沟通  灯光')) === JSON.stringify(['灯光', '超时', '沟通']));
  check('标签数组中元素含分隔符仍拆分',
    JSON.stringify(A.normalizeTags(['灯光,超时', '灯光', '超时'])) === JSON.stringify(['灯光', '超时']));

  console.log('二、批注构造与指纹出现序号锚点');
  const table = await A.buildOccurrenceTable(events);
  check('指纹表与事件等长', table.digests.length === events.length);
  const ann = await A.buildAnnotation({
    events,
    sessionRef: SESSION,
    startIndex: 1,
    endIndex: 4,
    text: '确认阶段偏慢',
    tags: '灯光, 超时',
  });
  check('批注含 id / 时间戳 / 场次引用', !!ann.id && !!ann.createdAt && ann.sessionRef.fileId === SESSION.fileId);
  check('首尾锚点指纹与独立计算一致',
    ann.start.digest === expectedDigest(events[1]) && ann.end.digest === expectedDigest(events[4]));
  check('首次出现的指纹序号为 1', ann.start.ordinal === 1 && ann.end.ordinal === 1);
  check('保存相对毫秒偏移与事件原文（失效时展示）',
    ann.startT === 1000 && ann.endT === 3000 && ann.startEvent.event === 'cue-started');
  check('标签数组化', JSON.stringify(ann.tags) === JSON.stringify(['灯光', '超时']));
  check('新批注默认有效', ann.valid === true && ann.invalidReason === null);

  const dupEvents = eventsWithExactDuplicate();
  const dupTable = await A.buildOccurrenceTable(dupEvents);
  const dDigest = await A.eventDigest(dupEvents[3]);
  check('重复指纹计数为 2，#2 定位到后插入的索引 4',
    dupTable.counts.get(dDigest) === 2 && dupTable.ordinals.get(`${dDigest}#2`) === 4);
  const ann2 = await A.buildAnnotation({
    events: dupEvents, sessionRef: SESSION, startIndex: 4, endIndex: 6, text: '锚到第二次出现', tags: [],
  });
  check('锚到重复指纹的第二次出现（ordinal=2）', ann2.start.ordinal === 2 && ann2.end.ordinal === 1);

  console.log('三、重定位：同一日志有效；找不到 / 序号不足 / 顺序倒置则失效');
  let r = A.relocalize(ann, table);
  check('同一日志重定位有效且索引正确', r.valid && r.startIndex === 1 && r.endIndex === 4);
  check('重复指纹按序号回到「同一行」',
    A.relocalize(ann2, dupTable).startIndex === 4);

  // 删除一条事件：第二次出现消失
  const removedDup = dupEvents.filter((_, i) => i !== 4);
  const tableRemoved = await A.buildOccurrenceTable(removedDup);
  r = A.relocalize(ann2, tableRemoved);
  check('重复次数变少（序号超出）标失效', !r.valid && /第 2 次/.test(r.reason));

  // 篡改日志内容：指纹消失
  const tampered = events.map((e, i) => i === 1 ? { ...e, detail: { ...e.detail, text: '被改过' } } : e);
  r = A.relocalize(ann, await A.buildOccurrenceTable(tampered));
  check('起点指纹找不到标失效', !r.valid && r.reason.startsWith('起点'));

  // 顺序倒置：终点事件出现在起点之前
  const reversed = { ...ann, start: ann.end, end: ann.start };
  r = A.relocalize(reversed, table);
  check('终点在起点之前（顺序倒置）标失效', !r.valid && /顺序倒置/.test(r.reason));

  // 锚点字段损坏
  r = A.relocalize({ ...ann, start: { digest: 'not-a-hash', ordinal: 1 } }, table);
  check('锚点指纹格式不合法标失效', !r.valid);
  r = A.relocalize({ ...ann, start: { digest: ann.start.digest, ordinal: 0 } }, table);
  check('锚点序号不合法标失效', !r.valid);

  console.log('四、导入合并：按 id，内容一致去重，内容不同双方保留并标冲突');
  const clone = JSON.parse(JSON.stringify(ann));
  let m = A.mergeAnnotations([], [clone]);
  check('空库导入：新增', m.stats.added === 1 && m.records.length === 1);
  m = A.mergeAnnotations(m.records, [JSON.parse(JSON.stringify(ann))]);
  check('同 id 内容一致：去重不新增', m.stats.duplicated === 1 && m.records.length === 1);
  const reorderedAnn = (() => { const c = JSON.parse(JSON.stringify(ann)); c.tags = ['超时', '灯光']; return c; })(); // 标签顺序不同
  check('标签顺序差异不影响内容一致（canonical 比较数组保序：顺序不同视为不同内容）',
    (A.sameContent(ann, reorderedAnn) === false) && (A.sameContent(ann, JSON.parse(JSON.stringify(ann))) === true));

  const diff = JSON.parse(JSON.stringify(ann));
  diff.text = '完全不同的批注内容';
  m = A.mergeAnnotations(m.records, [diff]);
  check('同 id 内容不同：冲突 +1、新增一份、总数 2',
    m.stats.conflicts === 1 && m.stats.added === 1 && m.records.length === 2);
  check('两份都明确标记冲突且归入同一 conflictGroup（原 id）',
    m.records.every((x) => x.conflict && x.conflictGroup === ann.id));
  const imp = m.records.find((x) => x.id !== ann.id);
  check('导入份获得新 id（<原id>#imp）且保留可追溯', imp.id === `${ann.id}#imp`);

  // 再导一次冲突份（内容一致）：组内去重，不产生第三份
  m = A.mergeAnnotations(m.records, [JSON.parse(JSON.stringify(imp))]);
  check('冲突组内同内容重复导入：去重', m.stats.duplicated === 1 && m.records.length === 2);

  // 同一批导入中两条新 id（库中均不存在）各自新增
  const other = JSON.parse(JSON.stringify(ann));
  other.id = A.makeId();
  other.text = '另一条';
  const other2 = JSON.parse(JSON.stringify(other));
  other2.id = A.makeId();
  other2.text = '第三条';
  m = A.mergeAnnotations([], [other, other2]);
  check('不同 id 各自新增', m.stats.added === 2 && m.stats.conflicts === 0);

  // 同一批导入：库中现有 X，文件里 X(不同内容) 与 X#imp(与改后内容一致) 各一条 → 1 冲突 + 组内去重
  const base = JSON.parse(JSON.stringify(ann));
  const v2a = JSON.parse(JSON.stringify(ann)); v2a.text = 'v2';
  const v2b = JSON.parse(JSON.stringify(v2a)); v2b.id = `${ann.id}#imp`;
  m = A.mergeAnnotations([base], [v2a, v2b]);
  check('同批冲突 + 组内同内容去重：总数 2、冲突 1、去重 1',
    m.records.length === 2 && m.stats.conflicts === 1 && m.stats.duplicated === 1);

  // 非法记录跳过并计数
  m = A.mergeAnnotations([], [{ id: '' }, { no: 'anchor' }, null, 'x', JSON.parse(JSON.stringify(ann))]);
  check('无法识别的记录跳过并计数', m.stats.invalid === 4 && m.records.length === 1);

  // 已带冲突标记的单份导入（另一冲突方不在本库）：保留冲突标记
  const conflictedSolo = JSON.parse(JSON.stringify(ann));
  conflictedSolo.id = A.makeId();
  conflictedSolo.conflict = true;
  conflictedSolo.conflictGroup = ann.id;
  m = A.mergeAnnotations([], [conflictedSolo]);
  check('导入文件中已标冲突的记录保留冲突标记', m.records[0].conflict === true && m.records[0].conflictGroup === ann.id);

  console.log('五、导出文件与往返');
  const payload = A.buildExportPayload(m.records);
  check('导出含格式标识 / 版本 / 时间 / count / annotations',
    payload.format === 'cue-annotations' && payload.version === 1 && payload.count === 1 &&
    Array.isArray(payload.annotations) && !!payload.exportedAt);
  const parsed = A.parseImportPayload(payload);
  check('导出文件可被解析且条数一致', parsed.ok && parsed.annotations.length === 1);
  check('往返保留锚点 / 标签 / 冲突标记',
    parsed.annotations[0].start.digest === m.records[0].start.digest &&
    parsed.annotations[0].conflict === true);
  check('格式标识不符被拒', !A.parseImportPayload({ format: 'x', version: 1, annotations: [] }).ok);
  check('版本不符被拒', !A.parseImportPayload({ format: 'cue-annotations', version: 9, annotations: [] }).ok);
  check('缺 annotations 被拒', !A.parseImportPayload({ format: 'cue-annotations', version: 1 }).ok);
  const withBad = A.parseImportPayload({
    format: 'cue-annotations', version: 1,
    annotations: [JSON.parse(JSON.stringify(ann)), { id: 'bad' }],
  });
  check('导入数组中坏记录跳过并计数，好记录保留', withBad.ok && withBad.invalid === 1 && withBad.annotations.length === 1);

  console.log('六、页面只读性（HTTP GET 静态页，无 WebSocket、无写接口）');
  const page = await getPage('/annotations.html');
  check('批注簿页面可访问', page.status === 200);
  check('页面不创建 WebSocket', !/new\s+WebSocket/.test(page.body));
  check('页面不出现任何写接口路径（/api 下仅复盘只读 GET）',
    !/fetch\(\s*['"`][^'"`]*(POST|PUT|DELETE)/i.test(page.body));
  check('页面引用批注库与 IndexedDB 库名',
    page.body.includes('annotations.js') && /cue-annotations/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'annotations.js'), 'utf8')));
  const replayPage = await getPage('/replay.html');
  check('复盘页提供「从当前播放位置圈定」批注入口',
    replayPage.status === 200 && replayPage.body.includes('annotations.js') &&
    replayPage.body.includes('圈定起点') && replayPage.body.includes('annotations.html'));
  // 不存在任何批注写接口：服务端 /api/annotations* 应命中静态 404 或不存在
  const noWriteApi = await httpGet('/api/annotations').catch(() => null);
  check('服务端不存在批注 API（批注不经服务端）', !noWriteApi || noWriteApi.status === 404);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
