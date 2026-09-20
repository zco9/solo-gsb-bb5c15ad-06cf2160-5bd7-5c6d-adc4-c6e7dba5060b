/* 复盘播放清单测试：
 *   一、清单文档规范化（去重 / 坏记录跳过 / 单例 id）
 *   二、播放前重定位 resolveEntries：批注缺失 / 日志缺失 / 指纹失效跳过并列原因；
 *       正常条目成段且严格保持清单顺序（重叠区间分别成段，不合并）
 *   三、resolvePlaylist 装配器：模拟只读 GET 缓存（含跨场次、日志缺失）
 *   四、虚拟时间轴纯函数：累计偏移、1×/2×/4× 无关的线性映射、
 *       恰好落在边界进入后一段、零长段显式定位、拖动 clamp、跨段映射原场次时刻
 *   五、页面只读性（HTTP GET 静态页，无 WebSocket、无写接口）
 *
 * 运行前提：服务已在 localhost:3000 启动（npm start）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

// 与 test/annotations.js 同一方式把浏览器脚本装入 Node
function loadBrowserModule(file, factoryName) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  const withoutExport = src.replace(/\nif \(typeof module[\s\S]*$/, '');
  const fn = new Function('crypto', 'TextEncoder',
    withoutExport.replace(`const ${factoryName} = (() => {`, 'return (() => {'));
  return fn(crypto, TextEncoder);
}

const A = loadBrowserModule('annotations.js', 'CueAnnotations');
globalThis.CueAnnotations = A; // resolvePlaylist 经 globalThis.CueAnnotations 访问
const P = loadBrowserModule('playlist.js', 'CuePlaylist');

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
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

function ev(ts, t, event, detail) { return { ts, t, event, detail: detail || {} }; }
function makeEvents(startMs, cueText) {
  const iso = (ms) => new Date(Date.parse('2026-09-19T10:00:00.000Z') + startMs + ms).toISOString();
  return [
    ev(iso(0), 0, 'session-start', {}),
    ev(iso(1000), 1000, 'cue-started', { seq: 1, text: cueText || '口令甲', targets: ['灯光'] }),
    ev(iso(2000), 2000, 'confirm', { seq: 1, position: '灯光' }),
    ev(iso(3000), 3000, 'cue-completed', { seq: 1 }),
    ev(iso(5000), 5000, 'sequence-finished', {}),
  ];
}

async function main() {
  const eventsA = makeEvents(0);
  const eventsB = makeEvents(100000, '口令乙');
  const SESSION_A = { fileId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', runId: 0 };
  const SESSION_B = { fileId: 'ffffffff-0000-1111-2222-333333333333', runId: 2 };

  const tableA = await A.buildOccurrenceTable(eventsA);
  const tableB = await A.buildOccurrenceTable(eventsB);
  const annA = await A.buildAnnotation({ events: eventsA, sessionRef: SESSION_A, startIndex: 1, endIndex: 3, text: '甲区间', tags: ['灯光'] });
  const annB = await A.buildAnnotation({ events: eventsB, sessionRef: SESSION_B, startIndex: 2, endIndex: 4, text: '乙区间', tags: [] });
  // 与 annA 重叠（甚至包含关系）的另一条批注：播放时必须各自成段、顺序播放
  const annOverlap = await A.buildAnnotation({ events: eventsA, sessionRef: SESSION_A, startIndex: 1, endIndex: 2, text: '重叠区间', tags: [] });
  // 零长区间（同一事件起止）
  const annZero = await A.buildAnnotation({ events: eventsA, sessionRef: SESSION_A, startIndex: 2, endIndex: 2, text: '零长区间', tags: [] });
  // 注定失效的批注（篡改日志后指纹消失）
  const annDead = await A.buildAnnotation({
    events: eventsA.map((e, i) => i === 1 ? { ...e, detail: { ...e.detail, text: '另一个口令' } } : e),
    sessionRef: SESSION_A, startIndex: 1, endIndex: 3, text: '将失效', tags: [],
  });

  console.log('一、清单文档规范化');
  check('空文档为单例 main / entries 空数组', P.emptyDoc().id === 'main' && Array.isArray(P.emptyDoc().entries));
  const norm = P.normalizeDoc({
    id: 'main',
    entries: [
      { id: annA.id, addedAt: '2026-09-19T10:00:00.000Z' },
      { id: annA.id }, // 重复 id 去重
      { id: annB.id },
      { id: '' }, { no: 'id' }, null, 'x',
    ],
  });
  check('重复 / 非法条目被剔除且保序', norm.entries.length === 2 && norm.entries[0].id === annA.id && norm.entries[1].id === annB.id);
  check('缺 addedAt 补 ISO 字符串', typeof norm.entries[1].addedAt === 'string');
  check('非对象输入回退空文档', P.normalizeDoc(null).entries.length === 0 && P.normalizeDoc('x').entries.length === 0);
  check('makeEntry 含 id 与 addedAt', P.makeEntry('xyz').id === 'xyz' && !!P.makeEntry('xyz').addedAt);

  console.log('二、resolveEntries：跳过原因集中给出，成段严格保序且不合并');
  const entries = [{ id: annA.id }, { id: annB.id }, { id: annOverlap.id }, { id: annZero.id }, { id: annDead.id }, { id: 'missing-id' }];
  const annotationMap = new Map([annA, annB, annOverlap, annZero, annDead].map((x) => [x.id, x]));
  const resolvedMap = new Map([
    [annA.id, { ok: true, events: eventsA, startIndex: 1, endIndex: 3 }],
    [annB.id, { ok: true, events: eventsB, startIndex: 2, endIndex: 4 }],
    [annOverlap.id, { ok: true, events: eventsA, startIndex: 1, endIndex: 2 }],
    [annZero.id, { ok: true, events: eventsA, startIndex: 2, endIndex: 2 }],
    [annDead.id, { ok: false, reason: '起点指纹事件在重载后的日志中找不到（日志可能已变更）' }],
  ]);
  const r = P.resolveEntries(entries, annotationMap, resolvedMap);
  check('4 条成段（含零长段），顺序与清单一致',
    r.segments.length === 4 &&
    r.segments.map((s) => s.entryId).join(',') === [annA.id, annB.id, annOverlap.id, annZero.id].join(','));
  check('2 条跳过（失效 + 批注缺失）', r.skipped.length === 2);
  check('失效条目的跳过原因被保留', r.skipped.some((s) => s.entryId === annDead.id && /指纹/.test(s.reason)));
  check('批注缺失有明确原因并保留 entryId',
    r.skipped.some((s) => s.entryId === 'missing-id' && /不存在/.test(s.reason)));
  check('跳过项附批注原文（集中列明时可辨认）', !!r.skipped.find((s) => s.entryId === annDead.id).annotation.text);
  check('段携带场次引用与原始时刻 / 时长',
    r.segments[0].fileId === SESSION_A.fileId && r.segments[0].startT === 1000 &&
    r.segments[0].endT === 3000 && r.segments[0].durationMs === 2000);
  check('重叠区间各自成段（段 1 与段 3 同场次且重叠，未合并）',
    r.segments[2].fileId === SESSION_A.fileId && r.segments[2].startT === 1000 && r.segments[2].endT === 2000);
  check('零长段时长为 0 且仍保留', r.segments[3].durationMs === 0 && r.segments[3].startT === 2000);

  console.log('三、resolvePlaylist 装配器：场次只读拉取与缓存、日志缺失跳过');
  const fetchCalls = [];
  const loadSession = async (fileId, runId) => {
    const key = `${fileId}/${runId}`;
    fetchCalls.push(key);
    if (fileId === SESSION_B.fileId) return { ok: false, reason: '场次日志找不到（文件或段落不存在，可能已删除）' };
    return { ok: true, events: eventsA };
  };
  // A 的批注都能重定位；B 日志缺失；annDead 指纹失效
  const rr = await P.resolvePlaylist(
    [annA.id, annOverlap.id, annDead.id, annB.id, 'missing-id'],
    [annA, annB, annOverlap, annDead], loadSession);
  check('可播放 2 段（annA / annOverlap），顺序不变',
    rr.segments.length === 2 && rr.segments[0].entryId === annA.id && rr.segments[1].entryId === annOverlap.id);
  check('跳过 3 项：失效 / 日志缺失 / 批注不存在', rr.skipped.length === 3);
  check('日志缺失原因直达跳过列表', rr.skipped.some((s) => s.entryId === annB.id && /找不到/.test(s.reason)));
  check('同场次日志只拉一次（缓存）',
    fetchCalls.filter((k) => k === `${SESSION_A.fileId}/0`).length === 1);

  console.log('四、虚拟时间轴：累计偏移、线性映射、边界进入后一段、跨场次');
  const segs = P.withOffsets(rr.segments);
  check('段偏移为首尾累计：0-2000、2000-3000',
    segs[0].offsetStart === 0 && segs[0].offsetEnd === 2000 &&
    segs[1].offsetStart === 2000 && segs[1].offsetEnd === 3000);
  check('总时长为累计区间时长 3000ms', P.totalDuration(segs) === 3000);

  // 段 1 内部映射回 A 场原始时刻
  let loc = P.locate(segs, 0);
  check('vt=0 位于第 1 段起点，localT=1000', loc.index === 0 && loc.localT === 1000 && loc.progress === 0);
  loc = P.locate(segs, 1500);
  check('vt=1500 位于第 1 段内，localT=1000+(1500-0)=2500', loc.index === 0 && loc.localT === 2500);
  // 恰好落在边界：进入后一段
  loc = P.locate(segs, 2000);
  check('vt 恰好落在边界 2000：进入后一段（第 2 段）', loc.index === 1 && loc.localT === 1000);
  check('后一段起点 progress=0', loc.progress === 0);
  // 拖动超出末端 clamp
  loc = P.locate(segs, 999999);
  check('拖动超出末端：clamp 到总时长，停在最后一段末尾', loc.index === 1 && loc.localT === 2000 && loc.atEnd);
  loc = P.locate(segs, -50);
  check('负向拖动：clamp 回 0', loc.index === 0 && loc.localT === 1000);

  // 跨场次段映射：段 2 改属 B 场（直接构造段数据验证）
  const cross = P.withOffsets([
    { entryId: 'x1', fileId: SESSION_A.fileId, runId: 0, startIndex: 1, endIndex: 3, startT: 1000, endT: 3000, durationMs: 2000 },
    { entryId: 'x2', fileId: SESSION_B.fileId, runId: 2, startIndex: 2, endIndex: 4, startT: 2000, endT: 5000, durationMs: 3000 },
  ]);
  check('跨场次累计总时长 5000', P.totalDuration(cross) === 5000);
  loc = P.locate(cross, 3500);
  check('vt=3500 进入 B 场段并映射原始时刻 2000+(3500-2000)=3500',
    loc.index === 1 && loc.seg.fileId === SESSION_B.fileId && loc.localT === 3500);
  loc = P.locate(cross, 2000);
  check('跨场次边界 vt=2000 进入 B 场段起点（后一段）', loc.index === 1 && loc.localT === 2000);
  check('1×/2×/4× 只改变推进速率，不改变映射：同一 vt 结果与速度无关',
    P.locate(cross, 4000).localT === P.locate(cross, 4000).localT);

  // 零长段：自然映射不可见，forceIndex 精确呈现；边界规则不被零长段截断
  const withZero = P.withOffsets([
    { entryId: 'p', fileId: SESSION_A.fileId, runId: 0, startIndex: 1, endIndex: 3, startT: 1000, endT: 3000, durationMs: 2000 },
    { entryId: 'z', fileId: SESSION_A.fileId, runId: 0, startIndex: 2, endIndex: 2, startT: 2000, endT: 2000, durationMs: 0 },
    { entryId: 'q', fileId: SESSION_A.fileId, runId: 0, startIndex: 3, endIndex: 4, startT: 3000, endT: 5000, durationMs: 2000 },
  ]);
  check('零长段不改变累计时长（总 4000）', P.totalDuration(withZero) === 4000);
  loc = P.locate(withZero, 2000);
  check('vt=2000 跳过中间零长段进入第 3 段（边界进后一段）', loc.index === 2 && loc.localT === 3000);
  loc = P.locate(withZero, 2000, 1);
  check('forceIndex 可精确呈现零长段，localT=2000', loc.index === 1 && loc.localT === 2000 && loc.progress === 1);
  check('segmentStartVt 返回零长段所在虚拟位置', P.segmentStartVt(withZero, 1) === 2000);
  check('locate 空段数组返回 null', P.locate([], 0) === null);
  check('locateIndex 越界 forceIndex 被忽略，回退常规定位', P.locateIndex(segs, 0, 99) === 0);

  // nudge：键盘跳转在虚拟轴上 clamp 并解除强制段
  const n = P.nudge(cross, 4500, 1000);
  check('nudge 超出末端 clamp', n.vt === 5000 && n.releaseForce === true);

  console.log('五、页面只读性（HTTP GET 静态页，无 WebSocket、无写接口）');
  const pageResp = await getPage('/playlist.html');
  const page = pageResp.body;
  check('播放页可访问', pageResp.status === 200);
  check('页面不创建 WebSocket', !/new\s+WebSocket/.test(page));
  check('页面不出现任何写接口调用', !/fetch\(\s*['"`][^'"`]*(POST|PUT|DELETE)/i.test(page));
  check('页面只引用复盘只读 GET 接口',
    page.includes('/api/replay/sessions') && !/\/api\/(?!replay)/.test(page.replace(/\/api\/replay\/sessions/g, '')));
  check('页面引用清单模块与 IndexedDB 库名 cue-playlists',
    page.includes('playlist.js') &&
    /cue-playlists/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'playlist.js'), 'utf8')));
  check('页面含 1×/2×/4× 倍速与虚拟时间轴',
    ['data-speed="1"', 'data-speed="2"', 'data-speed="4"'].every((s) => page.includes(s)) && page.includes('pl-timeline'));

  const annResp = await getPage('/annotations.html');
  const annPage = annResp.body;
  check('批注簿页可访问且含「复盘播放清单」勾选区与播放页入口',
    annResp.status === 200 && annPage.includes('playlist.js') &&
    annPage.includes('复盘播放清单') && annPage.includes('playlist.html'));
  check('批注簿清单支持拖拽排序（draggable + data-pl-id）',
    annPage.includes('draggable="true"') && annPage.includes('data-pl-id'));

  const idxResp = await getPage('/');
  check('首页提供播放清单入口卡片', idxResp.status === 200 && idxResp.body.includes('playlist.html'));

  // 不存在任何清单写接口：服务端 /api/playlists 应 404
  const noWriteApi = await httpGet('/api/playlists').catch(() => null);
  check('服务端不存在清单 API（清单不经服务端）', !noWriteApi || noWriteApi.status === 404);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
