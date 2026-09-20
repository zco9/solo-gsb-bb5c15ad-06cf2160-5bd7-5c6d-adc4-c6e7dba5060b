/* 可验证复盘归档测试：canonical JSON、SHA-256 哈希链、归档导出、本地校验与只读 HTTP 接口。
 *
 * 运行前提：服务已在 localhost:3000 启动（npm start）。
 * 导出 / 校验算法部分直接调用 archive.js 与 public/archive.js（合成日志写入临时目录），
 * HTTP 接口部分对真实 data 目录断言。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const archive = require('../archive');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

// 浏览器版 public/archive.js 的纯函数实现，在 Node 中加载以复用同一份代码交叉验证
function loadBrowserArchive() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'archive.js'), 'utf8');
  const fn = new Function('crypto', 'TextEncoder',
    src.replace('const CueArchive = (() => {', 'return (() => {'));
  return fn(crypto, TextEncoder);
}

const SESSION_ID = 'cccccccc-dddd-eeee-ffff-000000000000';

// 构造闭合场次：场内含 1 行坏数据（计入归档告警），场外闭合后再含 1 行坏数据（不计入）
function writeSynthLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    ['2026-09-19T10:00:00.000Z', 'sequence-set', { version: 1, count: 1, timeoutSec: 5, cues: [
      { seq: 1, text: '口令甲', targets: ['灯光', '音响'] }] }],
    ['2026-09-19T10:00:01.000Z', 'session-start', {}],
    ['2026-09-19T10:00:01.000Z', 'cue-started', { seq: 1, text: '口令甲', targets: ['灯光', '音响'], revision: 1, attemptId: 'a1' }],
    ['2026-09-19T10:00:02.000Z', 'confirm', { seq: 1, position: '灯光' }],
    '__CORRUPT_IN__', // 场内坏行：必须进入归档 warnings
    ['2026-09-19T10:00:03.000Z', 'confirm', { seq: 1, position: '音响' }],
    ['2026-09-19T10:00:04.000Z', 'cue-completed', { seq: 1 }],
    ['2026-09-19T10:00:10.000Z', 'sequence-finished', {}],
    ['2026-09-19T10:00:11.000Z', 'session-reset', {}],
    '__CORRUPT_OUT__', // 场外坏行：不属于本归档
  ];
  const body = lines.map((l) => {
    if (l === '__CORRUPT_IN__') return '{坏数据-场内';
    if (l === '__CORRUPT_OUT__') return '{坏数据-场外';
    return JSON.stringify({ ts: l[0], event: l[1], detail: l[2] });
  }).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `events-${SESSION_ID}.jsonl`), body);
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${urlPath}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: buf ? JSON.parse(buf) : null }));
    }).on('error', reject);
  });
}

// 手工逐步构造哈希链（与实现无关的独立计算路径）
function manualChainHex(events) {
  let h = Buffer.alloc(32);
  for (const ev of events) {
    h = crypto.createHash('sha256')
      .update(Buffer.concat([h, Buffer.from(archive.canonicalJson(ev), 'utf8')]))
      .digest();
  }
  return h.toString('hex');
}

async function main() {
  const BA = loadBrowserArchive();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-archive-'));
  writeSynthLog(dir);

  console.log('一、canonical JSON：键递归排序、数组保序、浏览器与服务端逐字节一致');
  const tricky = {
    b: 1, a: 'x', '键名': 'unicode', 'quote"键': 'esc"ape\n换行',
    nested: { z: [3, 2, 1], y: { b: 2, a: 1 } },
    arr: [{ k2: 'v', k1: 'v' }, [1, 2], '中文　全角', 1.5, -0, true, false, null],
  };
  const serverCanon = archive.canonicalJson(tricky);
  check('对象键递归排序（外层与嵌套均按键序）',
    serverCanon.indexOf('"a"') < serverCanon.indexOf('"b"') &&
    serverCanon.includes('"y":{"a":1,"b":2}'));
  check('数组保序（不重排）', serverCanon.includes('"z":[3,2,1]'));
  check('浏览器与服务端 canonical JSON 逐字节一致', BA.canonicalJson(tricky) === serverCanon);
  check('非有限数字被拒绝',
    (() => { try { archive.canonicalJson({ x: NaN }); return false; } catch { return true; } })());

  console.log('二、哈希链：h0 零值、逐事件串接、双端一致');
  check('空事件流的摘要即 h0（32 字节零值 hex）',
    archive.chainDigestHex([]) === '0'.repeat(64));
  const ev1 = { ts: '2026-09-19T10:00:01.000Z', event: 'session-start', detail: {} };
  const ev2 = { ts: '2026-09-19T10:00:02.000Z', event: 'confirm', detail: { seq: 1, position: '灯光' } };
  check('单事件链与手工计算一致', archive.chainDigestHex([ev1]) === manualChainHex([ev1]));
  check('多事件链与手工逐步计算一致', archive.chainDigestHex([ev1, ev2]) === manualChainHex([ev1, ev2]));
  check('链对事件顺序敏感（交换顺序摘要不同）',
    archive.chainDigestHex([ev1, ev2]) !== archive.chainDigestHex([ev2, ev1]));
  check('浏览器重算的链摘要与服务端一致',
    (await BA.chainDigest([ev1, ev2])) === archive.chainDigestHex([ev1, ev2]));

  console.log('三、归档导出：格式版本 / 场次摘要 / 冻结序列 / 有效事件 / 逐行告警 / manifest');
  const built = archive.buildArchive(dir, SESSION_ID, '0');
  check('导出成功', !!built.archive);
  const a = built.archive;
  check('格式标识与版本', a.format === 'cue-archive' && a.version === 1);
  check('场次摘要（起止 / 时长 9s / 1 口令 / 6 事件 / 时限 5s）',
    a.session.startedAt === '2026-09-19T10:00:01.000Z' &&
    a.session.finishedAt === '2026-09-19T10:00:10.000Z' &&
    a.session.durationMs === 9000 && a.session.cueCount === 1 &&
    a.session.eventCount === 6 && a.session.timeoutSec === 5 &&
    a.session.fileId === SESSION_ID && a.session.runId === 0);
  check('冻结序列为本场首次 cue-started 快照',
    a.sequence.length === 1 && a.sequence[0].seq === 1 &&
    a.sequence[0].text === '口令甲' &&
    JSON.stringify(a.sequence[0].targets) === JSON.stringify(['灯光', '音响']));
  check('有效事件保持日志行序且首尾为场次边界',
    a.events.length === 6 && a.events[0].event === 'session-start' &&
    a.events[5].event === 'sequence-finished');
  check('事件原样保留 ts/event/detail（无多余字段）',
    a.events.every((e) => JSON.stringify(Object.keys(e).sort()) === JSON.stringify(['detail', 'event', 'ts'])));
  check('逐行告警仅含本场行区间内坏行（场内 1 行，场外不计入）',
    a.warnings.length === 1 && a.warnings[0].line === 5 && a.warnings[0].raw.includes('坏数据-场内'));
  check('manifest 保存事件数与最终摘要',
    a.manifest.eventCount === 6 && /^[0-9a-f]{64}$/.test(a.manifest.digest));
  check('manifest 摘要等于对导出事件重算的链摘要',
    a.manifest.digest === archive.chainDigestHex(a.events));
  check('非法 fileId 被拒', archive.buildArchive(dir, '../evil', '0').error === 'badId');
  check('越界 runId 返回 notFound', archive.buildArchive(dir, SESSION_ID, '9').error === 'notFound');
  check('不存在文件返回 notFound',
    archive.buildArchive(dir, '99999999-9999-9999-9999-999999999999', '0').error === 'notFound');

  console.log('四、本地校验：有效归档通过，篡改逐项定位');
  const ok = await BA.verify(JSON.parse(JSON.stringify(a)));
  check('有效归档校验通过', ok.ok === true);
  check('通过时返回归档摘要（场次 / 计数 / 摘要）',
    ok.summary && ok.summary.eventCount === 6 && ok.summary.cueCount === 1 &&
    ok.summary.warningCount === 1 && ok.summary.digest === a.manifest.digest &&
    ok.summary.session.fileId === SESSION_ID);

  const tamper = (fn) => { const c = JSON.parse(JSON.stringify(a)); fn(c); return c; };
  let r;
  r = await BA.verify(tamper((c) => { c.events[2].detail.position = '道具'; }));
  check('篡改事件内容：摘要校验失败并定位 manifest.digest',
    !r.ok && r.error.field === 'manifest.digest');
  r = await BA.verify(tamper((c) => { const t = c.events[2]; c.events[2] = c.events[3]; c.events[3] = t; }));
  check('交换事件顺序：摘要校验失败', !r.ok && r.error.field === 'manifest.digest');
  r = await BA.verify(tamper((c) => { c.manifest.eventCount += 1; }));
  check('篡改 manifest 事件数：定位 manifest.eventCount',
    !r.ok && r.error.field === 'manifest.eventCount');
  r = await BA.verify(tamper((c) => { c.session.eventCount += 1; }));
  check('篡改场次摘要事件数：定位 session.eventCount',
    !r.ok && r.error.field === 'session.eventCount');
  r = await BA.verify(tamper((c) => { c.events.shift(); }));
  check('删除首个事件：边界缺失定位索引 0',
    !r.ok && r.error.index === 0 && r.error.field === 'events[0].event');
  r = await BA.verify(tamper((c) => { c.events.splice(3, 0, { ts: c.events[3].ts, event: 'session-reset', detail: {} }); }));
  check('场中插入 session-reset：边界被破坏并定位该事件索引',
    !r.ok && r.error.index === 3 && r.error.field === 'events[3].event');
  r = await BA.verify(tamper((c) => { c.events[2].event = ''; }));
  check('事件字段损坏：定位首个事件索引与字段',
    !r.ok && r.error.index === 2 && r.error.field === 'events[2].event');
  r = await BA.verify(tamper((c) => { c.version = 2; }));
  check('格式版本不支持：定位 version 字段', !r.ok && r.error.field === 'version');
  r = await BA.verify(tamper((c) => { c.session.cueCount = 99; }));
  check('口令数与冻结序列不一致：定位 session.cueCount',
    !r.ok && r.error.field === 'session.cueCount');
  r = await BA.verify(tamper((c) => { c.session.durationMs += 1; }));
  check('时长与起止时间差不符：定位 session.durationMs',
    !r.ok && r.error.field === 'session.durationMs');
  r = await BA.verify('not-an-object');
  check('归档不是对象：定位根节点', !r.ok && r.error.field === '(root)');

  console.log('五、HTTP 接口（只读，GET）');
  const bad = await httpGet('/api/archive/sessions/..%2F..%2Fetc%2Fpasswd/0');
  check('路径穿越 / 非法 ID 返回 400', bad.status === 400);
  const missing = await httpGet('/api/archive/sessions/99999999-9999-9999-9999-999999999999/0');
  check('不存在场次返回 404', missing.status === 404);
  const list = await httpGet('/api/replay/sessions');
  if (list.json.sessions.length) {
    const s0 = list.json.sessions[0];
    const got = await httpGet(`/api/archive/sessions/${s0.fileId}/${s0.runId}`);
    check('真实场次归档 200 且含 format/session/sequence/events/warnings/manifest',
      got.status === 200 && got.json.format === 'cue-archive' && got.json.session &&
      Array.isArray(got.json.sequence) && Array.isArray(got.json.events) &&
      Array.isArray(got.json.warnings) && got.json.manifest &&
      /^[0-9a-f]{64}$/.test(got.json.manifest.digest));
    check('归档以附件形式下载（Content-Disposition）',
      /attachment/.test(got.headers['content-disposition'] || '') &&
      /cue-archive-/.test(got.headers['content-disposition'] || ''));
    check('真实归档通过浏览器本地校验',
      (await BA.verify(got.json)).ok === true);
  }
  const page = await new Promise((resolve) => {
    http.get('http://localhost:3000/archive.html', (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
  });
  check('归档页面可访问且不创建 WebSocket（无 /ws 引用）',
    page.status === 200 && !/new\s+WebSocket/.test(page.body) && page.body.includes('/api/archive/sessions'));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
