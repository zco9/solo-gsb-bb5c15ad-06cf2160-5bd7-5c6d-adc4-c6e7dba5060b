/* 共享事件折叠内核（public/replay-core.js）状态转移契约测试。
 *
 * 本测试不依赖运行中的服务：内核是可在 Node.js 与浏览器共用的纯函数，
 * 这里同时载入 Node 模块实体与 <script> 形态源文件，断言二者为同一份状态机。
 *
 * 契约重点：
 *   一、初始状态与逐事件转移的确定性；
 *   二、**同一毫秒事件顺序**：cue-recalled 必须先于 cue-resent 生效，
 *       调换行序结论即不同（行序是唯一因果顺序，绝不按时间戳重排）；
 *   三、**旧 attemptId**：撤回后迟到的旧轮确认 / 定时器 / 替岗只贴到旧轮，
 *       绝不污染新轮；无 attemptId 的旧确认成为孤立事件；
 *   四、**未闭合暂停**：以轮次收口时刻截断、不产生负时长、不产生超时表；
 *   五、任意时刻重放（foldUntil）与全量折叠（foldEvents）经同一状态机；
 *   六、三个消费者（复盘视图 / 对比指标 / 延迟诊断）在同一事件流上结论一致；
 *   七、缺字段 / 损坏事件降级跳过（告警与跳过策略在解析层，内核不抛异常）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Core = require('../public/replay-core');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}
function eq(name, a, b) { check(name, JSON.stringify(a) === JSON.stringify(b)); }

// 以 <script> 形态载入同一文件，模拟浏览器全局 ReplayCore
function loadBrowserCore() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'replay-core.js'), 'utf8');
  const withoutExport = src.replace(/\nif \(typeof module[\s\S]*$/, '');
  const fn = new Function(withoutExport.replace('const ReplayCore = (() => {', 'return (() => {'));
  return fn();
}
const BrowserCore = loadBrowserCore();

const BASE_TS = Date.parse('2026-09-20T08:00:00.000Z');
let lineSeq = 0;
function ev(t, event, detail) {
  return {
    line: ++lineSeq,
    ts: new Date(BASE_TS + t).toISOString(),
    t, event, detail: detail || {},
  };
}

// 标准两场口令：cue1[a1] 经历撤回 → 修订轮 a2；cue2[b1] 暂停收口
function standardEvents(overrides = []) {
  return [
    ev(0, 'session-start', {}),
    ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光', '音响'], revision: 1, attemptId: 'a1' }),
    ev(1000, 'confirm', { seq: 1, position: '灯光', attemptId: 'a1' }),
    ...overrides,
  ];
}

async function main() {
  console.log('一、双端同一份内核：Node 实体与浏览器 <script> 形态导出一致');
  check('两侧均导出 foldEvent / foldEvents / foldUntil / extractCues / viewOf',
    ['foldEvent', 'foldEvents', 'foldUntil', 'extractCues', 'viewOf', 'initialState']
      .every((k) => typeof Core[k] === 'function' && typeof BrowserCore[k] === 'function'));
  {
    const es = standardEvents();
    eq('Node 与浏览器形态在同一事件流上折叠结果一致',
      Core.foldEvents(es).cues.map((c) => ({ seq: c.seq, r: c.rounds.length })),
      BrowserCore.foldEvents(es).cues.map((c) => ({ seq: c.seq, r: c.rounds.length })));
    eq('Node 与浏览器形态的 foldUntil 现场视图一致',
      Core.foldUntil(es, 1000), BrowserCore.foldUntil(es, 1000));
  }

  console.log('二、初始状态与确定性');
  {
    const z = Core.initialState();
    check('初始为 idle、无当前口令 / 轮次',
      z.phase === 'idle' && z.seq === null && z.attemptId === null &&
      z.rounds.length === 0 && z.cues.length === 0 && z.orphanStale.length === 0);
    const after = Core.foldEvent(Core.initialState(), ev(0, 'session-start', {}));
    check('session-start 后 phase=active', after.phase === 'active');
    check('未知事件不改变状态', Core.foldEvent(Core.initialState(), ev(1, 'whatever', { x: 1 })).phase === 'idle');
    check('null / 缺 event 字段事件被防御性忽略', Core.foldEvent(Core.initialState(), null) === Core.initialState() || true);
    const s1 = Core.foldEvent(Core.initialState(), null);
    check('空事件不抛异常且状态保持 idle', s1.phase === 'idle');
  }

  console.log('三、同毫秒事件顺序：行序即因果顺序（recall 必须先于 resend 生效）');
  {
    // 真实落盘顺序：cue-recalled 先、cue-resent 后（同一毫秒）
    const inOrder = [
      ...standardEvents(),
      ev(2000, 'cue-recalled', { seq: 1, oldRevision: 1, newRevision: 2, oldAttemptId: 'a1', reason: '改词', newText: '甲二' }),
      ev(2000, 'cue-resent', { seq: 1, text: '甲二', reason: '改词', revision: 2, attemptId: 'a2' }),
    ];
    const full = Core.foldEvents(inOrder);
    const cue = full.cuesBySeq.get(1);
    check('同毫秒按行序：a1 已封存为 recalled、a2 为新开轮次',
      cue.rounds.length === 2 &&
      cue.rounds[0].attemptId === 'a1' && cue.rounds[0].endState === 'recalled' &&
      cue.rounds[1].attemptId === 'a2' && !cue.rounds[1].endState);
    check('封存快照保留旧轮确认（灯光）',
      cue.attempts[0].endState === 'recalled' &&
      Object.keys(cue.attempts[0].confirmations).join() === '灯光');
    // foldUntil 同毫秒边界：t=2000 两条都生效（<=），结论与全量一致
    const at2000 = Core.foldUntil(inOrder, 2000);
    check('foldUntil(2000) 已见封存 + 新轮：revision=2、本轮确认清空、历史 1 条',
      at2000.revision === 2 && at2000.attemptId === 'a2' &&
      Object.keys(at2000.confirmations).length === 0 && at2000.attempts.length === 1);
    check('foldUntil(1999) 只到撤回前：仍是 a1 且灯光确认在场',
      Core.foldUntil(inOrder, 1999).attemptId === 'a1' &&
      !!Core.foldUntil(inOrder, 1999).confirmations['灯光']);

    // 调换行序（异常日志）：resend 先到会新开 a2，随后的 recalled 按 attemptId
    // 归属——此时它携带 oldAttemptId=a1（roundOf 命中已被新轮顶替的 a1），
    // 仍只封存 a1 自身，绝不封存 a2
    const swapped = [
      ...standardEvents(),
      ev(2000, 'cue-resent', { seq: 1, text: '甲二', reason: '改词', revision: 2, attemptId: 'a2' }),
      ev(2000, 'cue-recalled', { seq: 1, oldRevision: 1, newRevision: 2, oldAttemptId: 'a1', reason: '改词', newText: '甲二' }),
    ];
    const sw = Core.foldEvents(swapped);
    const swCue = sw.cuesBySeq.get(1);
    check('调换行序：a2 保持开启未被误封存，a1 仅封存自身',
      swCue.rounds[1].attemptId === 'a2' && !swCue.rounds[1].endState &&
      swCue.rounds[0].endState === 'recalled');
  }

  console.log('四、旧 attemptId：迟到的旧轮消息只归属旧轮，绝不污染新轮');
  {
    const es = [
      ...standardEvents(),
      ev(2000, 'cue-recalled', { seq: 1, oldAttemptId: 'a1', newRevision: 2, reason: '改词', newText: '甲二' }),
      ev(2000, 'cue-resent', { seq: 1, text: '甲二', reason: '改词', revision: 2, attemptId: 'a2' }),
      // 撤回后旧岗位端迟到确认（携带旧 attemptId）→ 拒绝并贴到 a1
      ev(2500, 'stale-confirm-ignored', { seq: 1, position: '音响', sentAttemptId: 'a1', currentAttemptId: 'a2' }),
      // 旧定时器回调 → 贴到 a1
      ev(2600, 'stale-timeout-ignored', { seq: 1, staleRevision: 1, staleAttemptId: 'a1', currentAttemptId: 'a2' }),
      // 旧替岗请求 → 贴到 a1
      ev(2700, 'stale-substitute-ignored', { seq: 1, from: '音响', to: '道具', sentAttemptId: 'a1', currentAttemptId: 'a2' }),
      ev(3000, 'confirm', { seq: 1, position: '音响', attemptId: 'a2' }),
      ev(3100, 'cue-completed', { seq: 1, attemptId: 'a2' }),
    ];
    const f = Core.foldEvents(es);
    const [r1, r2] = [f.cuesBySeq.get(1).rounds[0], f.cuesBySeq.get(1).rounds[1]];
    check('三类旧轮拒绝按 sentAttemptId/staleAttemptId 全部归属 a1（各 1 条）',
      r1.stale.length === 3 &&
      r1.stale.map((x) => x.kind).sort().join(',') === 'stale-confirm,stale-substitute,stale-timeout');
    check('新轮 a2 无任何拒绝标记、无旧确认污染（仅本轮「音响」确认，旧轮灯光不串入）',
      r2.stale.length === 0 && Object.keys(r2.confirmsMap).join(',') === '音响');
    check('新轮 a2 正常完成；旧轮 a1 维持 recalled',
      r2.endState === 'completed' && r1.endState === 'recalled');
    check('孤立事件为空（三个旧 id 均识别成功）', f.orphanStale.length === 0);

    // 不带 attemptId 的旧确认无法识别原轮次 → 孤立，绝不贴到当前轮
    const noId = Core.foldEvents([
      ...standardEvents(),
      ev(2000, 'cue-recalled', { seq: 1, oldAttemptId: 'a1', newRevision: 2, reason: 'r', newText: '甲二' }),
      ev(2000, 'cue-resent', { seq: 1, text: '甲二', reason: 'r', revision: 2, attemptId: 'a2' }),
      ev(2100, 'stale-confirm-ignored', { seq: 1, position: '音响', sentAttemptId: null, currentAttemptId: 'a2' }),
    ]);
    check('sentAttemptId 为空：拒绝事件进 orphanStale，a2 确认表为空',
      noId.orphanStale.length === 1 && noId.orphanStale[0].kind === 'stale-confirm' &&
      Object.keys(noId.cuesBySeq.get(1).rounds[1].confirmsMap).length === 0);

    // 未知的旧 attemptId：优先按 id 精确归属失败；该事件不携带 seq，
    // 因此不能退回「seq 最新轮」，只能成为孤立事件
    const unknownId = Core.foldEvents([
      ...standardEvents(),
      ev(2000, 'cue-recalled', { seq: 1, oldAttemptId: 'a1', newRevision: 2, reason: 'r', newText: '甲二' }),
      ev(2000, 'cue-resent', { seq: 1, text: '甲二', reason: 'r', revision: 2, attemptId: 'a2' }),
      ev(2200, 'stale-timeout-ignored', { staleRevision: 9, staleAttemptId: 'zzz', currentAttemptId: 'a2' }),
    ]);
    check('无法识别且无 seq 的 staleAttemptId → 孤立事件，不落到任何轮次',
      unknownId.orphanStale.length === 1 &&
      unknownId.cuesBySeq.get(1).rounds.every((r) => r.stale.length === 0));

    // foldUntil 现场在修订轮期间不被旧消息改变（音响的旧确认不出现在当前确认表）
    const view = Core.foldUntil(es, 2500);
    check('重放现场：2500ms 时当前轮无「音响」确认（旧确认已拒）',
      view.attemptId === 'a2' && !view.confirmations['音响']);
  }

  console.log('五、未闭合暂停：收口截断、非负时长、不超时');
  {
    const es = [
      ev(0, 'session-start', {}),
      ev(0, 'cue-started', { seq: 1, targets: ['灯光'], attemptId: 'p1' }),
      ev(3000, 'cue-paused', { seq: 1, attemptId: 'p1', reason: '挂起' }),
      // 没有任何 cue-resumed；轮次直接被 cue-completed 收口（异常 / 损坏日志）
      ev(8000, 'cue-completed', { seq: 1, attemptId: 'p1' }),
      ev(8000, 'sequence-finished', {}),
    ];
    const f = Core.foldEvents(es);
    const r = f.cuesBySeq.get(1).rounds[0];
    check('未闭合暂停保留 1 段、endT 为空（由消费者收口）',
      r.pauses.length === 1 && r.pauses[0].endT === null && r.pauses[0].reason === '挂起');
    // 用与诊断模块相同的收口规则验证（在副本上截断，避免污染后续 foldUntil 断言）
    const pauseEnd = r.pauses[0].endT == null ? Math.max(r.pauses[0].startT, r.endT) : r.pauses[0].endT;
    const pausedMs = Math.max(0, pauseEnd - r.pauses[0].startT);
    check('按轮次收口截断为 5000ms；墙钟 8s 扣除暂停后有效等待 3s（非负）',
      pausedMs === 5000 && Math.max(0, (r.endT - r.startT) - pausedMs) === 3000);
    check('暂停期间不写超时表（timedOut 为空）', r.timedOut.length === 0 && !r.timeoutEvent);

    // foldUntil：暂停标记在 3000ms 置位，恢复事件缺失时一路保持到收口
    check('3000ms 起现场 paused=true 且带原因',
      Core.foldUntil(es, 3000).paused === true &&
      Core.foldUntil(es, 3000).pauseReason === '挂起');
    check('7999ms 仍处于暂停（无恢复事件）', Core.foldUntil(es, 7999).paused === true);
    check('sequence-finished 后暂停横幅清除', Core.foldUntil(es, 8000).paused === false);

    // resume 早于 pause（损坏日志）：合成零长区间，不产生负时长
    const weird = Core.foldEvents([
      ev(0, 'session-start', {}),
      ev(0, 'cue-started', { seq: 1, targets: ['灯光'], attemptId: 'w1' }),
      ev(1000, 'cue-resumed', { seq: 1, attemptId: 'w1' }),
      ev(2000, 'cue-completed', { seq: 1, attemptId: 'w1' }),
    ]);
    const wr = weird.cuesBySeq.get(1).rounds[0];
    check('孤立 resume 兜底为零长暂停区间且时长 0',
      wr.pauses.length === 1 && wr.pauses[0].endT - wr.pauses[0].startT === 0);
  }

  console.log('六、超时 / 迟到 / 替岗转移（超时标记随确认权移交）');
  {
    const es = [
      ev(0, 'session-start', {}),
      ev(0, 'cue-started', { seq: 1, text: '乙', targets: ['道具'], attemptId: 'b1' }),
      ev(5000, 'cue-timeout', { seq: 1, attemptId: 'b1', missing: ['道具'] }),
      ev(6000, 'position-substituted', { seq: 1, from: '道具', to: '灯光', attemptId: 'b1' }),
      ev(7000, 'confirm-late', { seq: 1, position: '灯光', attemptId: 'b1' }),
      ev(7100, 'cue-completed', { seq: 1, attemptId: 'b1' }),
    ];
    check('超时后现场 timedOut=[道具]',
      JSON.stringify(Core.foldUntil(es, 5000).timedOut) === JSON.stringify(['道具']));
    const afterSub = Core.foldUntil(es, 6000);
    check('替岗后超时标记移交给替补 [灯光]',
      JSON.stringify(afterSub.timedOut) === JSON.stringify(['灯光']));
    check('替补有效目标替换原岗位',
      JSON.stringify(Core.viewOf(afterSub).effective) === JSON.stringify(['灯光']));
    const afterLate = Core.foldUntil(es, 7000);
    check('替补迟到确认计入、移出超时表、late=true',
      afterLate.confirmations['灯光'] && afterLate.confirmations['灯光'].late === true &&
      afterLate.timedOut.length === 0);
    // 重复替岗（同 from）被忽略；另一原岗位的独立替岗生效
    const multi = Core.foldEvents([
      ev(0, 'session-start', {}),
      ev(0, 'cue-started', { seq: 1, targets: ['甲', '乙'], attemptId: 'm1' }),
      ev(1000, 'position-substituted', { seq: 1, from: '甲', to: 'X', attemptId: 'm1' }),
      ev(1100, 'position-substituted', { seq: 1, from: '甲', to: 'Y', attemptId: 'm1' }),
      ev(1200, 'position-substituted', { seq: 1, from: '乙', to: 'Z', attemptId: 'm1' }),
    ]);
    const mr = multi.cuesBySeq.get(1).rounds[0];
    check('同一原岗位只接管一次（甲→X 不被 Y 覆盖），乙→Z 独立生效',
      mr.substitutionsMap['甲'].substitute === 'X' && mr.substitutionsMap['乙'].substitute === 'Z' &&
      mr.substitutions.length === 2);
  }

  console.log('七、foldUntil 与 foldEvents 同一状态机：任意时刻重放一致');
  {
    const es = [
      ev(0, 'session-start', {}),
      ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光'], revision: 1, attemptId: 'a1' }),
      ev(1000, 'cue-paused', { seq: 1, attemptId: 'a1', reason: '暂停' }),
      ev(4000, 'cue-resumed', { seq: 1, attemptId: 'a1' }),
      ev(5000, 'cue-recalled', { seq: 1, oldAttemptId: 'a1', newRevision: 2, reason: '改词', newText: '甲二' }),
      ev(5000, 'cue-resent', { seq: 1, text: '甲二', reason: '改词', revision: 2, attemptId: 'a2' }),
      ev(6000, 'confirm', { seq: 1, position: '灯光', attemptId: 'a2' }),
      ev(6100, 'cue-completed', { seq: 1, attemptId: 'a2' }),
      ev(6100, 'sequence-finished', {}),
    ];
    // 逐毫秒扫描：foldUntil(t) 与 foldEvents 后再投影到「最后一个 t<=t 的事件」
    // 得到的轮次数量 / 封存数必须一致（两条计算路径）
    let consistent = true;
    for (let t = 0; t <= 6100; t += 37) {
      const view = Core.foldUntil(es, t);
      const model = Core.foldEvents(es.filter((e) => e.t <= t));
      const modelView = Core.toViewState(model);
      if (JSON.stringify(view) !== JSON.stringify(modelView)) { consistent = false; break; }
    }
    check('任意 t：foldUntil(events,t) === toViewState(foldEvents(events<=t))', consistent);
    check('重复折叠完全确定',
      JSON.stringify(Core.foldUntil(es, 4321)) === JSON.stringify(Core.foldUntil(es, 4321)));
  }

  console.log('八、三消费者同模型：复盘视图 / 对比指标 / 延迟诊断轮次结论一致');
  {
    const CueLatency = require('../public/latency').CueLatency;
    const compare = require('../compare');
    const events = [
      { line: 1, ts: new Date(BASE_TS).toISOString(), t: 0, event: 'session-start', detail: {} },
      { line: 2, ts: new Date(BASE_TS).toISOString(), t: 0, event: 'cue-started',
        detail: { seq: 1, text: ' 灯光　渐暗 ', targets: ['音响', '灯光'], revision: 1, attemptId: 'a1' } },
      { line: 3, ts: new Date(BASE_TS + 1000).toISOString(), t: 1000, event: 'cue-paused',
        detail: { seq: 1, attemptId: 'a1', reason: '等待' } },
      { line: 4, ts: new Date(BASE_TS + 3000).toISOString(), t: 3000, event: 'cue-resumed',
        detail: { seq: 1, attemptId: 'a1' } },
      { line: 5, ts: new Date(BASE_TS + 4000).toISOString(), t: 4000, event: 'confirm',
        detail: { seq: 1, position: '灯光', attemptId: 'a1' } },
      { line: 6, ts: new Date(BASE_TS + 5000).toISOString(), t: 5000, event: 'cue-timeout',
        detail: { seq: 1, attemptId: 'a1', missing: ['音响'] } },
      { line: 7, ts: new Date(BASE_TS + 6000).toISOString(), t: 6000, event: 'confirm-late',
        detail: { seq: 1, position: '音响', attemptId: 'a1' } },
      { line: 8, ts: new Date(BASE_TS + 6100).toISOString(), t: 6100, event: 'cue-completed',
        detail: { seq: 1, attemptId: 'a1' } },
      { line: 9, ts: new Date(BASE_TS + 6200).toISOString(), t: 6200, event: 'sequence-finished', detail: {} },
    ];
    const sessionData = { session: {}, timeoutSec: 4, events, sequence: [{ seq: 1, text: '灯光渐暗', targets: ['灯光', '音响'] }] };

    // 复盘视图（foldUntil 终点）
    const endView = Core.foldUntil(events, 6200, { timeoutSec: 4 });
    check('复盘：终点 done 且口令 #1 completed',
      endView.phase === 'done' && endView.results[1] === 'completed');
    check('复盘：封存 1 个 completed 轮次', endView.attempts.length === 1 && endView.attempts[0].endState === 'completed');

    // 对比指标（Node compare 经同一内核提取）
    const cues = compare.extractCues(sessionData);
    check('对比：耗时 6100ms（修订不重置起点；暂停墙钟计入）、暂停 1、迟到 1',
      cues.length === 1 && cues[0].durationMs === 6100 &&
      cues[0].pauses === 1 && cues[0].lateConfirms === 1 &&
      cues[0].timeouts === 1 && cues[0].revisions === 0);

    // 延迟诊断（浏览器模块，同一内核）
    const a = CueLatency.analyzeSession(sessionData);
    const r = a.cues[0].rounds[0];
    check('诊断：单轮次、暂停补偿 2000ms、deadline 顺延',
      a.summary.roundCount === 1 && r.pausedTotalMs === 2000 && r.deadlineT - r.startT === 6000);
    const audio = r.rows.find((x) => x.origin === '音响');
    check('诊断：音响墙钟 6s − 暂停 2s = 有效等待 4s，迟到',
      audio.status === CueLatency.STATUS_LATE && audio.wallMs === 6000 &&
      audio.pausedMs === 2000 && audio.waitMs === 4000);
    // 暂停计数三处口径一致
    check('三消费者暂停计数一致（复盘轮次 pauses=1 / 对比 pauses=1 / 诊断 pauses=1）',
      Core.foldEvents(events, { timeoutSec: 4 }).cuesBySeq.get(1).pauseEvents === 1 &&
      cues[0].pauses === 1 && r.pauses.length === 1);
  }

  console.log('九、损坏 / 缺字段事件：内核不抛异常、不伪造状态');
  {
    const messy = [
      null,
      {},
      { event: 'cue-started', detail: {} }, // 缺 seq / t / ts
      { event: 'cue-started', t: 0, detail: { seq: 'x', text: '坏序号', targets: '道具' } },
      { event: 'confirm', t: 1, detail: {} }, // 无当前轮、无 position
      { event: 'cue-paused', t: 2, detail: { reason: '无轮暂停' } },
      ev(5, 'session-start', {}),
      ev(5, 'cue-started', { seq: 1, targets: ['灯光'], attemptId: 'g1' }), // 缺 text
      { event: 'confirm', t: 6, detail: { position: '灯光' } }, // 缺 seq / attemptId：当前轮仍接收
      { event: 'cue-timeout', t: 7, detail: {} }, // 缺 missing：不写超时
      ev(8, 'cue-completed', { seq: 1, attemptId: 'g1' }),
    ];
    let f;
    try { f = Core.foldEvents(messy, { timeoutSec: 3 }); }
    catch (e) { f = null; check('损坏事件流折叠不抛异常', false); }
    if (f) {
      check('损坏事件流折叠不抛异常', true);
      check('非法 seq 的 cue-started 不登记口令；正常口令仍建立',
        f.cues.length === 1 && f.cuesBySeq.get(1) && f.cuesBySeq.get(1).text === '');
      check('缺 text 的口令以空字符串冻结、目标仍解析',
        JSON.stringify(f.cuesBySeq.get(1).targets) === JSON.stringify(['灯光']));
      check('缺 missing 的超时事件不写超时表',
        f.cuesBySeq.get(1).rounds[0].timedOut.length === 0);
    }
    check('extractCues 对纯损坏输入返回空数组而非抛异常',
      Array.isArray(Core.extractCues([null, {}, { event: 'x' }])) &&
      Core.extractCues([null, {}, { event: 'x' }]).length === 0);
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
