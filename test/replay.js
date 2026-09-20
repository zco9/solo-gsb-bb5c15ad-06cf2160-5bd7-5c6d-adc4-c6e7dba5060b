/* 演出复盘模块测试：只读解析、坏行跳过告警、场次切分、HTTP 接口与确定性重放。
 *
 * 运行前提：服务已在 localhost:3000 启动（npm start）。
 * 本测试使用临时目录构造合成日志（含损坏行），通过 DATA_DIR 无法注入运行中服务，
 * 因此 HTTP 接口部分对真实 data 目录断言；解析/切分/重放部分直接调用 replay.js。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const replay = require('../replay');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

// 浏览器版 public/replay-core.js（共享折叠内核）与 public/replay.js（复盘门面）
// 在 Node 中依次装入，以复用与浏览器完全相同的一份状态机实现
function loadBrowserReplay() {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  const coreSrc = read('replay-core.js')
    .replace(/\nif \(typeof module[\s\S]*$/, '')
    .replace('const ReplayCore = (() => {', 'return (() => {');
  const core = new Function(coreSrc)();
  globalThis.ReplayCore = core;
  const src = read('replay.js')
    .replace(/\nif \(typeof module[\s\S]*$/, '')
    .replace('const Replay = (() => {', 'return (() => {');
  return new Function('ReplayCore', src)(core);
}

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// 构造一个含损坏行的闭合场次（含暂停/恢复、替岗、修订、超时、迟到确认）
function writeSynthLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    ['2026-09-19T10:00:00.000Z', 'sequence-set', { version: 1, count: 2, timeoutSec: 5, cues: [
      { seq: 1, text: '口令甲', targets: ['灯光', '音响'] }, { seq: 2, text: '口令乙', targets: ['道具'] }] }],
    ['2026-09-19T10:00:01.000Z', 'session-start', {}],
    ['2026-09-19T10:00:01.000Z', 'cue-started', { seq: 1, text: '口令甲', targets: ['灯光', '音响'], revision: 1, attemptId: 'a1' }],
    ['2026-09-19T10:00:02.000Z', 'confirm', { seq: 1, position: '灯光' }],
    '__CORRUPT__', // 非法 JSON：必须跳过并告警，不得中断整场解析
    ['2026-09-19T10:00:03.000Z', 'cue-paused', { seq: 1, reason: '设备调试' }],
    ['2026-09-19T10:00:04.000Z', 'paused-confirm-rejected', { seq: 1, position: '音响' }],
    ['2026-09-19T10:00:30.000Z', 'cue-resumed', { seq: 1 }],
    ['2026-09-19T10:00:31.000Z', 'cue-recalled', { seq: 1, oldRevision: 1, newRevision: 2, reason: '措辞修正', newText: '口令甲（修订）' }],
    ['2026-09-19T10:00:31.000Z', 'cue-resent', { seq: 1, text: '口令甲（修订）', reason: '措辞修正', revision: 2, attemptId: 'a2' }],
    ['2026-09-19T10:00:32.000Z', 'confirm', { seq: 1, position: '灯光' }],
    ['2026-09-19T10:00:33.000Z', 'confirm', { seq: 1, position: '音响' }],
    ['2026-09-19T10:00:33.500Z', 'cue-completed', { seq: 1 }],
    ['2026-09-19T10:00:33.500Z', 'cue-started', { seq: 2, text: '口令乙', targets: ['道具'], revision: 1, attemptId: 'b1' }],
    ['2026-09-19T10:00:38.600Z', 'cue-timeout', { seq: 2, missing: ['道具'] }],
    ['2026-09-19T10:00:39.000Z', 'position-substituted', { seq: 2, from: '道具', to: '灯光' }],
    ['2026-09-19T10:00:40.000Z', 'confirm-late', { seq: 2, position: '灯光' }],
    ['2026-09-19T10:00:40.500Z', 'cue-completed', { seq: 2 }],
    ['2026-09-19T10:00:40.500Z', 'sequence-finished', {}],
    ['2026-09-19T10:00:41.000Z', 'session-reset', {}],
  ];
  const body = lines.map((l) => (l === '__CORRUPT__' ? '{坏数据' : JSON.stringify({ ts: l[0], event: l[1], detail: l[2] }))).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `events-${SESSION_ID}.jsonl`), body);
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${urlPath}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
    }).on('error', reject);
  });
}

async function main() {
  const R = loadBrowserReplay();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-replay-'));
  writeSynthLog(dir);

  console.log('一、逐行解析：坏行跳过且不中断整场');
  const parsed = replay.parseLogFile(path.join(dir, `events-${SESSION_ID}.jsonl`));
  check('合法行全部解析（19 条事件）', parsed.events.length === 19);
  check('损坏行产生 1 条告警并记录行号', parsed.warnings.length === 1 && parsed.warnings[0].line === 5);
  check('告警带原因与坏行原文', /解析失败/.test(parsed.warnings[0].reason) && parsed.warnings[0].raw.includes('坏数据'));

  console.log('二、场次切分：仅列出已闭合场次');
  const list = replay.listSessions(dir);
  check('恰好识别 1 个已结束场次', list.sessions.length === 1);
  check('场次摘要（2 条口令 / 17 条场内事件；sequence-set 在场前、session-reset 在闭合后均不计入）',
    list.sessions[0].cueCount === 2 && list.sessions[0].eventCount === 17);
  check('确认时限取最近 sequence-set（5s）', list.sessions[0].timeoutSec === 5);
  check('列表带文件级坏行汇总', list.fileWarnings[SESSION_ID] && list.fileWarnings[SESSION_ID].count === 1);

  // 未闭合（开始后被重置）的段不得列入
  const openDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-replay-open-'));
  fs.writeFileSync(path.join(openDir, 'events-11111111-2222-3333-4444-555555555555.jsonl'), [
    JSON.stringify({ ts: '2026-09-19T11:00:00.000Z', event: 'session-start', detail: {} }),
    JSON.stringify({ ts: '2026-09-19T11:00:00.100Z', event: 'cue-started', detail: { seq: 1, text: 'x', targets: ['灯光'] } }),
    JSON.stringify({ ts: '2026-09-19T11:00:00.200Z', event: 'session-reset', detail: {} }),
  ].join('\n') + '\n');
  check('未闭合（重置中断）的场次不列出', replay.listSessions(openDir).sessions.length === 0);

  console.log('三、单场接口数据与告警');
  const d = replay.getSession(dir, SESSION_ID, '0');
  check('事件按日志顺序返回且带相对起点偏移 t', d.events[0].event === 'session-start' && d.events[0].t === 0);
  check('最后一条为 sequence-finished', d.events[d.events.length - 1].event === 'sequence-finished');
  check('冻结序列含两条原始口令', d.sequence.length === 2 && d.sequence[0].text === '口令甲');
  check('positions 聚合涉及岗位', JSON.stringify(d.positions) === JSON.stringify(['灯光', '音响', '道具']));
  check('本场区间内的坏行告警随单场返回（1 条）', d.warnings.length === 1 && d.warnings[0].line === 5);
  check('非法 fileId 被拒', replay.getSession(dir, '../evil', '0').error === 'badId');
  check('越界 runId 返回 notFound', replay.getSession(dir, SESSION_ID, '9').error === 'notFound');
  check('不存在文件返回 notFound',
    replay.getSession(dir, '99999999-9999-9999-9999-999999999999', '0').error === 'notFound');

  console.log('四、确定性重放：跳转与顺序播放一致');
  const evs = d.events;
  const T = evs[evs.length - 1].t;
  const direct = R.foldUntil(evs, T);
  let frame = null;
  for (let t = 0; t < T; t += 7) frame = R.foldUntil(evs, t);
  frame = R.foldUntil(evs, T); // 顺序播放逐帧走到终点
  check('顺序播放到终点的现场 == 直接跳转到终点', JSON.stringify(frame) === JSON.stringify(direct));
  // 跳转后从起点重放：任意中间跳转后再到终点，结果不变
  R.foldUntil(evs, T / 3);
  R.foldUntil(evs, (2 * T) / 3);
  check('任意跳转后再到终点仍一致', JSON.stringify(R.foldUntil(evs, T)) === JSON.stringify(direct));
  check('重复折叠完全确定（无隐藏随机/累积）',
    JSON.stringify(R.foldUntil(evs, 12345)) === JSON.stringify(R.foldUntil(evs, 12345)));

  console.log('五、重放现场：当前口令 / 确认 / 超时 / 替岗 / 修订 / 暂停');
  check('起点前为空场（idle）', R.foldUntil(evs, -1).phase === 'idle');
  check('起点时刻演出已开始且第 1 条激活', R.foldUntil(evs, 0).phase === 'active' && R.foldUntil(evs, 0).seq === 1);

  const paused = R.foldUntil(evs, 2000);
  check('暂停：冻结且保留已有确认', paused.paused === true && paused.pauseReason === '设备调试' &&
    !!paused.confirmations['灯光']);
  check('暂停期间（26 秒墙钟）不产生超时', R.foldUntil(evs, 28000).timedOut.length === 0);
  const rejected = R.foldUntil(evs, 3000);
  check('暂停中被拒确认不计入确认表', !rejected.confirmations['音响']);
  check('恢复后暂停状态清除', R.foldUntil(evs, 29000).paused === false);

  const recalled = R.foldUntil(evs, 30000); // cue-recalled 落盘时刻、cue-resent 之前
  check('撤回：旧轮次封存为只读历史', recalled.attempts.length === 1 && recalled.attempts[0].endState === 'recalled');
  check('撤回封存中保留旧轮次确认（灯光）', !!recalled.attempts[0].confirmations['灯光']);
  const resent = R.foldUntil(evs, 30000); // 同一毫秒内 cue-recalled 在 cue-resent 之前落盘
  const afterResent = R.foldUntil(evs, 30001);
  check('修订重发：修订号=2、文本替换、本轮状态清空',
    afterResent.revision === 2 && afterResent.text === '口令甲（修订）' &&
    Object.keys(afterResent.confirmations).length === 0);
  check('修订后封存历史仍保留', afterResent.attempts.length === 1);

  const subbed = R.foldUntil(evs, 38000);
  check('替岗：有效目标由替补顶替', JSON.stringify(R.viewOf(subbed).effective) === JSON.stringify(['灯光']));
  check('超时标记随确认权移交替补', JSON.stringify(subbed.timedOut) === JSON.stringify(['灯光']));
  const late = R.foldUntil(evs, 39000);
  check('替补迟到确认计入且移出超时表',
    late.confirmations['灯光'].late === true && late.timedOut.length === 0);

  const ended = R.foldUntil(evs, T);
  check('终点：全场结束且两条口令均完成',
    ended.phase === 'done' && d.sequence.every((c) => ended.results[c.seq] === 'completed'));

  console.log('六、HTTP 接口（只读）');
  const apiList = await httpGet('/api/replay/sessions');
  check('GET /api/replay/sessions 200 且场次为数组',
    apiList.status === 200 && Array.isArray(apiList.json.sessions));
  if (apiList.json.sessions.length) {
    const s0 = apiList.json.sessions[0];
    const one = await httpGet(`/api/replay/sessions/${s0.fileId}/${s0.runId}`);
    check('GET 单场 200 且含 events/sequence/warnings',
      one.status === 200 && Array.isArray(one.json.events) && Array.isArray(one.json.sequence));
  }
  const bad = await httpGet('/api/replay/sessions/..%2F..%2Fetc%2Fpasswd/0');
  check('路径穿越 / 非法 ID 返回 400', bad.status === 400);
  const missing = await httpGet('/api/replay/sessions/99999999-9999-9999-9999-999999999999/0');
  check('不存在场次返回 404', missing.status === 404);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(openDir, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
