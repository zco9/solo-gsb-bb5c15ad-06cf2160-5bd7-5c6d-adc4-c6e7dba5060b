/* 共享只读复盘内核（public/core.js）状态转移契约测试。
 *
 * 契约是复盘（foldUntil 实时现场）、场次对比（轮次指标）与确认延迟诊断
 * （轮次模型）三者共同依赖的根基，故本测试直接对内核断言，重点钉死三类
 * 最容易因「按时间戳重排 / 按当前轮次想当然归属」而出错的转移：
 *
 *   一、同毫秒事件顺序：内核只按日志行序折叠，绝不按时间戳排序；
 *      cue-recalled → cue-resent（同毫秒）、cue-completed → cue-started
 *      （同毫秒连推）的现场必须与行序一致。
 *   二、旧 attemptId：旧轮次的迟到确认 / 定时器 / 替岗被拒事件只能归属
 *      旧轮次（或成为孤立事件），绝不污染当前修订轮；缺 attemptId 的
 *      合成 / 损坏日志才允许按 seq 回退最新轮。
 *   三、未闭合暂停：cue-paused 后没有 cue-resumed（日志损坏 / 中断），
 *      收口时以轮次收口时刻截断、标记 unclosed、不产生负时长、
 *      deadline 只顺延实际暂停时长。
 *
 * 另覆盖：纯函数确定性、任意时刻重放等价、坏行解析告警跳过、
 * 修订 / 替岗 / 超时 / 迟到确认的实时现场镜像。
 *
 * 运行：node test/core.js（无需启动服务；内核不依赖 fs / 网络）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { CueCore: NodeCore } = require('../public/core');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

// 浏览器装载方式（new Function 模拟 <script> 全局）：同一文件不经修改
// 同时跑 Node 与「浏览器」两份实例，契约对两种环境必须完全一致。
function loadBrowserFactory(file, factoryName) {
  let src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  src = src.replace(/^'use strict';\s*/, '').replace(/\nif \(typeof module[\s\S]*$/, '');
  const head = `const ${factoryName} = (() => {`;
  const start = src.indexOf(head);
  const end = src.lastIndexOf('})();');
  return src.slice(start + head.length, end);
}
const BrowserCore = new Function(`return (() => {${loadBrowserFactory('core.js', 'CueCore')}})();`)();

const BASE_TS = Date.parse('2026-09-20T08:00:00.000Z');
function ev(t, event, detail) {
  return {
    line: t + 1,
    ts: new Date(BASE_TS + t).toISOString(),
    t, event, detail: detail || {},
  };
}

function main() {
  for (const [label, C] of [['Node require', NodeCore], ['浏览器脚本装载', BrowserCore]]) {
    console.log(`\n=== 内核契约（${label}）===`);

    console.log('一、纯函数 / 确定性 / 任意时刻重放');
    {
      const events = [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光'], attemptId: 'r1' }),
        ev(1000, 'confirm', { seq: 1, position: '灯光', attemptId: 'r1' }),
        ev(2000, 'cue-completed', { seq: 1, attemptId: 'r1' }),
        ev(2000, 'sequence-finished'),
      ];
      const a = C.foldEvents(events, { timeoutSec: 10 });
      const b = C.foldEvents(events, { timeoutSec: 10 });
      check('重复折叠结果逐字节一致（JSON）', JSON.stringify(a) === JSON.stringify(b));
      check('折叠不修改输入事件', events[1].detail.attemptId === 'r1' && events.length === 5);

      // 任意时刻重放：逐帧推进到终点 == 直接从起点折叠到终点
      const endT = events[events.length - 1].t;
      let frame = C.initialState();
      for (let t = 0; t <= endT; t += 37) frame = C.foldUntil(events, t, { timeoutSec: 10 });
      frame = C.foldUntil(events, endT, { timeoutSec: 10 }); // 末帧精确落到终点
      const direct = C.foldUntil(events, endT, { timeoutSec: 10 });
      check('逐帧播放到终点 == 直接跳转到终点', JSON.stringify(frame) === JSON.stringify(direct));
      check('从任意中间时刻跳转后再到终点仍一致',
        JSON.stringify(C.foldUntil(events, endT / 3, { timeoutSec: 10 })) !== JSON.stringify(direct) &&
        JSON.stringify(C.foldUntil(events, endT, { timeoutSec: 10 })) === JSON.stringify(direct));
      check('起点之前 phase=idle 且无轮次',
        C.foldUntil(events, -1).phase === 'idle' && C.foldUntil(events, -1).rounds.length === 0);
    }

    console.log('二、同毫秒事件顺序：只认日志行序，绝不按时间戳重排');
    {
      // cue-recalled 与 cue-resent 同一毫秒：行序即因果序，
      // 折叠到该毫秒时必须先封存旧轮、再开启修订轮（无论从哪个目标时刻重放）
      const events = [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, text: '旧词', targets: ['灯光'], revision: 1, attemptId: 'r1' }),
        ev(1000, 'confirm', { seq: 1, position: '灯光', attemptId: 'r1' }),
        ev(5000, 'cue-recalled', { seq: 1, oldAttemptId: 'r1', newRevision: 2, reason: '改词', newText: '新词' }),
        ev(5000, 'cue-resent', { seq: 1, text: '新词', reason: '改词', revision: 2, attemptId: 'r2' }),
        ev(6000, 'cue-completed', { seq: 1, attemptId: 'r2' }),
        ev(6000, 'sequence-finished'),
      ];
      const atMs = C.foldUntil(events, 5000, { timeoutSec: 10 });
      check('同毫秒折叠后：当前为第 2 版、attemptId=r2',
        atMs.revision === 2 && atMs.attemptId === 'r2' && atMs.text === '新词');
      check('同毫秒折叠后：旧轮已封存 recalled（历史轮次 1 条）',
        atMs.attempts.length === 1 && atMs.attempts[0].endState === 'recalled');
      check('旧轮封存保留修订前现场（旧词 / 灯光已确认）',
        atMs.attempts[0].text === '旧词' && !!atMs.attempts[0].confirmations['灯光']);
      check('修订轮确认现场已清空（确认不串轮）',
        Object.keys(atMs.confirmations).length === 0);
      const model = C.foldEvents(events, { timeoutSec: 10 });
      check('轮次模型严格按行序：r1 recalled → r2 completed',
        model.rounds.length === 2 &&
        model.rounds[0].attemptId === 'r1' && model.rounds[0].endState === 'recalled' &&
        model.rounds[1].attemptId === 'r2' && model.rounds[1].endState === 'completed');

      // 乱序时间戳压力：若实现错误地按 ts 排序，封存/开启顺序就会被打乱。
      // 构造行序与时间戳顺序相反的数组，折叠必须仍以行序为准。
      const shuffled = [
        { line: 1, ts: new Date(BASE_TS + 9000).toISOString(), t: 9000, event: 'cue-recalled',
          detail: { seq: 1, newRevision: 2, reason: 'r', newText: 'B' } },
        { line: 2, ts: new Date(BASE_TS).toISOString(), t: 0, event: 'session-start', detail: {} },
        { line: 3, ts: new Date(BASE_TS + 1000).toISOString(), t: 1000, event: 'cue-started',
          detail: { seq: 1, text: 'A', targets: ['灯光'], revision: 1, attemptId: 'r1' } },
        { line: 4, ts: new Date(BASE_TS + 9000).toISOString(), t: 9000, event: 'cue-resent',
          detail: { seq: 1, text: 'B', reason: 'r', revision: 2, attemptId: 'r2' } },
      ];
      const sf = C.foldEvents(shuffled, { timeoutSec: 10 });
      // 第 1 行 cue-recalled 到达时尚无轮次（行序在前），必须被忽略，
      // 绝不能因为它的 ts=9000 更晚就把它排到 cue-started 之后执行：
      // cue-started 开启的第 1 轮保持原样（无封存快照、endState 由随后
      // 正常到达的 cue-resent 收口），且 attempts 实时历史为空
      check('时间戳乱序时仍严格按行序：提前到达的 cue-recalled 不产生封存',
        sf.rounds.length === 2 &&
        sf.rounds[0].attemptId === 'r1' && sf.rounds[0].revision === 1 &&
        sf.rounds[1].attemptId === 'r2' && sf.rounds[1].revision === 2 &&
        sf.attempts.length === 0);
    }

    console.log('三、同毫秒连推：cue-completed 与下一条 cue-started 同毫秒');
    {
      const events = [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光'], attemptId: 'a1' }),
        ev(1000, 'confirm', { seq: 1, position: '灯光', attemptId: 'a1' }),
        ev(2000, 'cue-completed', { seq: 1, attemptId: 'a1' }),
        ev(2000, 'cue-started', { seq: 2, text: '乙', targets: ['音响'], attemptId: 'b1' }),
        ev(3000, 'confirm', { seq: 2, position: '音响', attemptId: 'b1' }),
        ev(4000, 'cue-completed', { seq: 2, attemptId: 'b1' }),
        ev(4000, 'sequence-finished'),
      ];
      const at2 = C.foldUntil(events, 2000, { timeoutSec: 10 });
      check('同毫秒连推后现场是第 2 条进行中（seq=2、phase=active）',
        at2.seq === 2 && at2.phase === 'active' && at2.attemptId === 'b1');
      check('第 1 条结果已封存为 completed（实时 results + 轮次模型）',
        at2.results[1] === 'completed' &&
        at2.rounds.some((r) => r.attemptId === 'a1' && r.endState === 'completed') &&
        !at2.rounds.find((r) => r.attemptId === 'a1').live);
      const m = C.foldEvents(events, { timeoutSec: 10 });
      check('两条口令、两个 completed 轮次',
        m.rounds.length === 2 && m.rounds.every((r) => r.endState === 'completed') && m.cues.length === 2);
    }

    console.log('四、旧 attemptId：迟到消息只归属旧轮，绝不污染修订轮');
    {
      const events = [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光'], revision: 1, attemptId: 'r1' }),
        ev(4000, 'cue-recalled', { seq: 1, oldAttemptId: 'r1', newRevision: 2, reason: '改词', newText: '乙' }),
        ev(4000, 'cue-resent', { seq: 1, text: '乙', reason: '改词', revision: 2, attemptId: 'r2' }),
        // 修订轮进行中，旧轮 r1 的迟到确认被拒：只能贴回 r1
        ev(5000, 'stale-confirm-ignored',
          { seq: 1, position: '灯光', sentAttemptId: 'r1', currentAttemptId: 'r2' }),
        ev(5200, 'stale-substitute-ignored',
          { seq: 1, to: '道具', sentAttemptId: 'r1', currentAttemptId: 'r2' }),
        // 整场结束后 r2 的旧定时器迟到回调：按 staleAttemptId 贴回 r2
        ev(8000, 'cue-completed', { seq: 1, attemptId: 'r2' }),
        ev(8000, 'sequence-finished'),
        ev(9000, 'stale-timeout-ignored',
          { seq: 1, staleRevision: 2, staleAttemptId: 'r2', currentAttemptId: null }),
      ];
      const m = C.foldEvents(events, { timeoutSec: 10 });
      const [r1, r2] = m.rounds;
      check('stale-confirm 按 sentAttemptId 归属 r1',
        r1.stale.some((s) => s.kind === 'stale-confirm' && s.position === '灯光'));
      check('stale-substitute 按 sentAttemptId 归属 r1',
        r1.stale.some((s) => s.kind === 'stale-substitute'));
      check('旧轮拒绝标记绝不出现在修订轮 r2 的 stale 之外的数据里（confirms 为空）',
        r2.confirms.length === 0 && !r2.stale.some((s) => s.kind === 'stale-confirm'));
      check('整场结束后的 stale-timeout 按 staleAttemptId 归属 r2',
        r2.stale.some((s) => s.kind === 'stale-timeout'));
      check('没有产生孤立事件（全部可归属）', m.orphanStale.length === 0);

      // 不带旧 attemptId 的旧确认：无法识别原轮 → 孤立事件，绝不计入当前轮
      const orphanEvents = [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光'], attemptId: 'r1' }),
        ev(3000, 'cue-recalled', { seq: 1, newRevision: 2, reason: 'x', newText: '乙' }),
        ev(3000, 'cue-resent', { seq: 1, text: '乙', reason: 'x', revision: 2, attemptId: 'r2' }),
        ev(4000, 'stale-confirm-ignored', { seq: 1, position: '灯光', sentAttemptId: null, currentAttemptId: 'r2' }),
      ];
      const live = C.foldUntil(orphanEvents, 4000, { timeoutSec: 10 });
      const om = C.foldEvents(orphanEvents, { timeoutSec: 10 });
      check('无 sentAttemptId 的旧确认成为孤立事件', om.orphanStale.length === 1);
      check('孤立旧确认绝不写入修订轮实时现场',
        !live.confirmations['灯光'] && om.rounds[1].confirms.length === 0);
    }

    console.log('五、缺 attemptId 的合成/损坏日志：按 seq 回退最新轮（健壮兜底）');
    {
      const events = [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光'] }), // 无 attemptId
        ev(1000, 'confirm', { seq: 1, position: '灯光' }),
        ev(2000, 'cue-completed', { seq: 1 }),
        ev(2000, 'sequence-finished'),
      ];
      const m = C.foldEvents(events, { timeoutSec: 10 });
      check('无 attemptId 时确认按 seq 回退归属唯一轮次',
        m.rounds.length === 1 && m.rounds[0].confirms.some((c) => c.position === '灯光') &&
        m.rounds[0].endState === 'completed');
    }

    console.log('六、未闭合暂停：收口截断、不产生负时长、deadline 按实际暂停顺延');
    {
      // cue-paused 后轮次直接 cue-completed（损坏日志缺 cue-resumed）
      const events = [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光', '音响'], attemptId: 'r1' }),
        ev(2000, 'cue-paused', { seq: 1, attemptId: 'r1', reason: '设备故障' }),
        ev(9000, 'cue-completed', { seq: 1, attemptId: 'r1' }),
        ev(9000, 'sequence-finished'),
      ];
      const raw = C.foldEvents(events, { timeoutSec: 10 });
      check('收口前：暂停保持开放（endT=null）', raw.rounds[0].pauses[0].endT == null);
      C.finalizeModel(raw);
      const r = raw.rounds[0];
      check('未闭合暂停以轮次收口时刻截断（2..9 = 7000ms）',
        r.pauses[0].unclosed === true && r.pauses[0].endT === 9000 && r.pausedTotalMs === 7000);
      check('deadline 只顺延实际暂停时长（10s + 7s = 17s）',
        r.deadlineT - r.startT === 17000);

      // 暂停发生在轮次收口之后（异常）：截断到暂停起点本身，时长 0、不为负
      const weird = [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光'], attemptId: 'r1' }),
        ev(2000, 'cue-paused', { seq: 1, attemptId: 'r1', reason: 'x' }),
        ev(1000, 'cue-completed', { seq: 1, attemptId: 'r1' }), // 行序上收口更早
        ev(1000, 'sequence-finished'),
      ];
      const wm = C.finalizeModel(C.foldEvents(weird, { timeoutSec: 10 }));
      const wp = wm.rounds[0].pauses[0];
      check('暂停区间晚于收口：截断为非负（0ms）且标记 unclosed',
        wp.unclosed === true && wp.endT - wp.startT === 0 && wm.rounds[0].pausedTotalMs === 0);
    }

    console.log('七、暂停 / 恢复镜像现场（同一 attemptId，恢复不另开轮）');
    {
      const events = [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光'], attemptId: 'r1' }),
        ev(1000, 'cue-paused', { seq: 1, attemptId: 'r1', reason: '等待' }),
        ev(1500, 'paused-confirm-rejected', { seq: 1, position: '灯光', attemptId: 'r1' }),
        ev(5000, 'cue-resumed', { seq: 1, attemptId: 'r1' }),
      ];
      const paused = C.foldUntil(events, 1500, { timeoutSec: 10 });
      check('暂停：paused=true 且原因保留，被拒确认不入确认表',
        paused.paused === true && paused.pauseReason === '等待' && !paused.confirmations['灯光']);
      const resumed = C.foldUntil(events, 5000, { timeoutSec: 10 });
      check('恢复：paused=false，仍为同一轮（attemptId=r1，不新增轮次）',
        resumed.paused === false && resumed.attemptId === 'r1' && resumed.rounds.length === 1);
      check('暂停区间闭合（1..5=4000ms），被拒确认留在 rejectedPauses',
        resumed.rounds[0].pauses[0].endT === 5000 && resumed.rounds[0].rejectedPauses.length === 1);
    }

    console.log('八、超时 / 迟到确认 / 替岗的实时现场与轮次模型');
    {
      const events = [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['道具'], attemptId: 'r1' }),
        ev(10000, 'cue-timeout', { seq: 1, attemptId: 'r1', missing: ['道具'] }),
        ev(11000, 'position-substituted', { seq: 1, attemptId: 'r1', from: '道具', to: '灯光' }),
        ev(12000, 'confirm-late', { seq: 1, position: '灯光', attemptId: 'r1' }),
        ev(13000, 'cue-completed', { seq: 1, attemptId: 'r1' }),
        ev(13000, 'sequence-finished'),
      ];
      const t10 = C.foldUntil(events, 10000, { timeoutSec: 10 });
      check('超时首次写入超时表', JSON.stringify(t10.timedOut) === JSON.stringify(['道具']));
      const t11 = C.foldUntil(events, 11000, { timeoutSec: 10 });
      check('替岗后超时标记随确认权移交替补', JSON.stringify(t11.timedOut) === JSON.stringify(['灯光']));
      const t12 = C.foldUntil(events, 12000, { timeoutSec: 10 });
      check('替补迟到确认：计入 late 并移出超时表',
        t12.confirmations['灯光'] && t12.confirmations['灯光'].late === true && t12.timedOut.length === 0);
      const m = C.foldEvents(events, { timeoutSec: 10 });
      const r = m.rounds[0];
      check('轮次模型记录 1 次超时事件 / 1 次替岗 / 1 个迟到确认',
        r.timeoutEvent && r.timeoutEvent.missing[0] === '道具' &&
        r.substitutions.length === 1 && r.confirms[0].late === true);
      check('重复 cue-timeout 不覆盖首次超时事件（模型只存首次）',
        (() => {
          const dup = C.foldEvents(events.concat([
            ev(12500, 'cue-timeout', { seq: 1, attemptId: 'r1', missing: ['其他人'] }),
          ]), { timeoutSec: 10 });
          return dup.rounds[0].timeoutEvent.missing[0] === '道具';
        })());
    }

    console.log('九、场次切分与坏行策略（损坏或缺字段：告警 + 跳过）');
    {
      const body = [
        JSON.stringify({ ts: new Date(BASE_TS).toISOString(), event: 'session-start', detail: {} }),
        '{坏行',
        JSON.stringify({ ts: new Date(BASE_TS + 1000).toISOString(), event: 'cue-started', detail: { seq: 1, text: '甲', targets: ['灯光'] } }),
        JSON.stringify({ ts: 'not-a-date', event: 'cue-completed', detail: {} }),
        JSON.stringify({ ts: new Date(BASE_TS + 2000).toISOString(), event: '', detail: {} }),
        JSON.stringify({ ts: new Date(BASE_TS + 3000).toISOString(), event: 'sequence-finished', detail: {} }),
        '',
      ].join('\n');
      const parsed = C.parseLogText(body);
      check('3 条合法行解析成功（保持行序）', parsed.events.length === 3);
      check('3 条坏行各自告警并记录行号 / 原因',
        parsed.warnings.length === 3 &&
        parsed.warnings[0].line === 2 && /解析失败/.test(parsed.warnings[0].reason) &&
        parsed.warnings[1].line === 4 && /ts/.test(parsed.warnings[1].reason) &&
        parsed.warnings[2].line === 5 && /event/.test(parsed.warnings[2].reason));
      check('空白行静默跳过（不告警）', parsed.warnings.every((w) => w.line !== 7));
      const runs = C.segmentEvents(parsed.events);
      check('损坏行被 跳过后仍切分出 1 个闭合场次', runs.length === 1 && runs[0].cues.size === 1);

      // 未闭合（session-reset 中断 / 文件结束）的段不得切分出来
      const open = C.segmentEvents([
        { line: 1, ts: BASE_TS, iso: '', event: 'session-start', detail: {} },
        { line: 2, ts: BASE_TS + 1, iso: '', event: 'cue-started', detail: { seq: 1 } },
        { line: 3, ts: BASE_TS + 2, iso: '', event: 'session-reset', detail: {} },
      ]);
      check('重置中断 / 未闭合的场次不切分', open.length === 0);

      // timeoutSec 取本场起点前最近一次 sequence-set / draft-published
      const timed = C.segmentEvents([
        { line: 1, ts: BASE_TS, iso: '', event: 'sequence-set', detail: { timeoutSec: 7 } },
        { line: 2, ts: BASE_TS + 1, iso: '', event: 'session-start', detail: {} },
        { line: 3, ts: BASE_TS + 2, iso: '', event: 'sequence-finished', detail: {} },
      ]);
      check('场次确认时限取最近 sequence-set（7s）', timed[0].timeoutSec === 7);
    }

    console.log('十、跨环境一致性：Node 实例与浏览器装载实例输出相同');
    {
      const events = [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光', '音响'], revision: 1, attemptId: 'r1' }),
        ev(3000, 'cue-paused', { seq: 1, attemptId: 'r1', reason: 'p' }),
        ev(4000, 'cue-recalled', { seq: 1, newRevision: 2, reason: '改', newText: '乙' }),
        ev(4000, 'cue-resent', { seq: 1, text: '乙', reason: '改', revision: 2, attemptId: 'r2' }),
        ev(5000, 'stale-confirm-ignored', { seq: 1, position: '灯光', sentAttemptId: 'r1', currentAttemptId: 'r2' }),
        ev(6000, 'cue-completed', { seq: 1, attemptId: 'r2' }),
        ev(6000, 'sequence-finished'),
      ];
      const n = JSON.stringify(NodeCore.foldEvents(events, { timeoutSec: 10 }));
      const b = JSON.stringify(BrowserCore.foldEvents(events, { timeoutSec: 10 }));
      check('两种装载方式折叠结果逐字节一致', n === b);
    }
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main();
