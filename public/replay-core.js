/* ReplayCore —— 只读复盘链路共享的纯函数事件折叠内核。
 *
 * 同一份「按日志行序推进的场次 / 口令 / 确认轮次」状态机，供以下消费者共用：
 *   - public/replay.js   演出复盘：foldUntil(events, t) 任意时刻确定性重放；
 *   - compare.js         场次对比：从折叠模型提取逐口令指标（耗时 / 超时 / 迟到 /
 *                        修订 / 暂停计数与最终文本）；
 *   - public/latency.js  确认延迟诊断：按 attemptId 取每个口令的全部轮次，
 *                        暂停区间、替岗、迟到 / 超时与旧轮次拒绝均已归属到轮次。
 *
 * 纯函数保证：不发起任何 I/O、不引用当前演出内存状态、不依赖 WebSocket / DOM /
 * Node 内置模块；输入事件数组与可选时限，输出全新的折叠状态，重复折叠结果严格一致。
 *
 * 时间语义：消费者只负责筛选与展示。任意时刻的现场都由 foldUntil 从场次起点
 * （session-start）按**日志行序**（而非时间戳重排）逐事件折叠得到；同一毫秒内
 * cue-recalled 必然先于 cue-resent 落盘，行序即因果顺序。
 *
 * 兼容加载：浏览器经 <script> 得到全局 ReplayCore；Node 经 require 得到同一文件，
 * 两侧执行的是同一份状态机代码。
 */
'use strict';

const ReplayCore = (() => {
  const DEFAULT_TIMEOUT_SEC = 30;

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // 折叠内核状态。rounds / cues / orphanStale 等富模型字段与复盘页需要的
  // 现场镜像字段并存：镜像始终由当前轮次（s.currentRound）同步而来，保证
  // 复盘、对比、诊断看到的是同一份模型。
  function initialState() {
    return {
      // ---- 场次级现场（复盘页直接渲染）----
      phase: 'idle', // idle（未开始） | active（口令进行中） | between（口令已完成待推进） | done（全场结束）
      results: {}, // seq -> 'active' | 'completed'
      // ---- 当前口令现场镜像（= currentRound 的投影，保持与历史复盘状态同形）----
      seq: null,
      text: '',
      originalText: '',
      targets: [],
      revision: 1,
      reason: null,
      attemptId: null,
      confirmations: {}, // 岗位 -> { late }
      timedOut: [],
      substitutions: {}, // 原岗位 -> { substitute }
      paused: false,
      pauseReason: null,
      attempts: [], // 当前口令已封存的只读历史轮次（撤回 / 完成快照）
      roundStartIso: null, // 当前轮次开始时刻（封存历史轮次时展示）

      // ---- 富折叠模型（对比 / 诊断使用）----
      timeoutSec: DEFAULT_TIMEOUT_SEC,
      currentCue: null, // 当前口令记录（cues 中的同一对象）
      currentRound: null, // 当前确认轮次（rounds 中的同一对象）
      cues: [], // 冻结口令记录（按首次 cue-started 行序）
      cuesBySeq: new Map(), // seq -> cue
      rounds: [], // 全部确认轮次（含撤回封存轮次，行序）
      roundsByAttempt: new Map(), // attemptId -> round
      roundsBySeq: new Map(), // seq -> [round...]（合成 / 损坏日志无 attemptId 时兜底）
      orphanStale: [], // 无法归属任何轮次的旧轮次拒绝事件
    };
  }

  function cloneConfirmations(map) {
    const out = {};
    for (const [k, v] of Object.entries(map || {})) out[k] = { late: !!(v && v.late) };
    return out;
  }

  function cloneSubstitutions(map) {
    const out = {};
    for (const [k, v] of Object.entries(map || {})) out[k] = { substitute: v.substitute };
    return out;
  }

  // 把当前轮次的现场镜像同步到顶层状态（复盘页历史状态形状由此保持不变）
  function syncLive(s) {
    const r = s.currentRound;
    if (!r) return;
    s.seq = r.seq;
    s.text = r.text;
    s.originalText = r.cue.originalText;
    s.targets = r.cue.targets;
    s.revision = r.revision;
    s.reason = r.reason;
    s.attemptId = r.attemptId;
    s.confirmations = r.confirmsMap;
    s.timedOut = r.timedOut;
    s.substitutions = r.substitutionsMap;
    s.paused = r.paused;
    s.pauseReason = r.pauseReason;
    s.roundStartIso = r.startIso;
    s.attempts = r.cue.attempts;
  }

  // 封存当前轮次为只读快照（形状与复盘页 renderAttempts 消费的 attempt 一致）。
  // 调用前须令 s.currentRound 指向要封存的轮次；封存后恢复调用方原指针，
  // 顶层现场镜像保持为「当前轮」视图（异常行序下封存旧轮不刷新镜像）。
  function snapshotRound(s, endState, reason, ev) {
    const r = s.currentRound;
    const snap = {
      endState,
      revision: r.revision,
      reason: reason || r.reason || null,
      text: r.text,
      startedAt: r.startIso,
      endedAt: ev ? ev.ts : null,
      confirmations: cloneConfirmations(r.confirmsMap),
      timedOut: [...r.timedOut],
      substitutions: cloneSubstitutions(r.substitutionsMap),
    };
    r.endState = endState;
    r.endEvent = ev ? ev.event : null;
    r.endLine = ev ? ev.line : null;
    r.endT = ev ? num(ev.t) : null;
    r.endIso = ev ? ev.ts : null;
    r.cue.attempts.push(snap);
    return snap;
  }

  function openRound(s, ev, opts) {
    const d = (ev && ev.detail) || {};
    const seq = opts.seq != null ? opts.seq : num(d.seq, 0);
    const cue = opts.cue || s.cuesBySeq.get(seq) || null;

    const round = {
      attemptId: opts.attemptId != null ? opts.attemptId : (d.attemptId ? String(d.attemptId) : null),
      revision: opts.revision != null ? opts.revision : num(d.revision, 1),
      seq,
      text: opts.text != null ? opts.text : String(d.text || ''),
      reason: opts.reason != null ? opts.reason : (d.reason || null),
      startEvent: ev ? ev.event : null,
      startLine: ev ? ev.line : null,
      startT: ev ? num(ev.t) : null,
      startIso: ev ? ev.ts : null,
      endState: null, // completed | recalled
      endEvent: null,
      endLine: null,
      endT: null,
      endIso: null,
      budgetMs: s.timeoutSec * 1000,
      deadlineT: null, // 由诊断消费者在收口时按暂停补偿计算
      cue,
      // ---- 轮次现场（复盘镜像读这两张表）----
      confirmsMap: {}, // 岗位 -> { late }
      timedOut: [],
      substitutionsMap: {}, // 原岗位 -> { substitute }
      paused: false,
      pauseReason: null,
      // ---- 诊断富模型 ----
      pauses: [], // { startT, endT, reason, startLine, endLine, startIso }
      substitutions: [], // { from, to, t, line }
      timeoutEvent: null, // { t, line, missing }
      confirms: [], // { position, late, t, line, duplicateEvents:[{t,line}] }
      rejectedPauses: [], // { position, t, line }
      stale: [], // 归属到本轮的旧轮次拒绝（attemptId 与当前轮不符）
    };

    cue.rounds.push(round);
    cue.revisions = Math.max(cue.revisions || 1, round.revision);
    if (round.revision > 1 && round.reason && !cue.recallReasons.includes(round.reason)) {
      cue.recallReasons.push(round.reason);
    }
    if (round.attemptId) s.roundsByAttempt.set(round.attemptId, round);
    if (!s.roundsBySeq.has(seq)) s.roundsBySeq.set(seq, []);
    s.roundsBySeq.get(seq).push(round);
    s.rounds.push(round);

    s.currentCue = cue;
    s.currentRound = round;
    syncLive(s);
    return round;
  }

  // 新口令：登记冻结快照（同 seq 的修订重发不新建口令），并开启第 1 轮
  function startCue(s, ev) {
    const d = ev.detail || {};
    const seq = num(d.seq, 0);
    let cue = s.cuesBySeq.get(seq);
    if (!cue) {
      const text = String(d.text || '');
      const targets = Array.isArray(d.targets)
        ? [...new Set(d.targets.map((x) => String(x).trim()).filter(Boolean))]
        : [];
      cue = {
        seq,
        text, // 冻结原始口令；修订后的文本只反映在轮次 / 事件流中
        originalText: text,
        finalText: text,
        targets,
        startT: num(ev.t),
        startLine: ev.line,
        completeT: null,
        rounds: [],
        attempts: [], // 复盘页形态的封存快照
        revisions: 1,
        recallReasons: [],
        timeoutEvents: 0,
        lateConfirms: 0,
        pauseEvents: 0,
      };
      s.cuesBySeq.set(seq, cue);
      s.cues.push(cue);
    }
    s.results[seq] = 'active';
    openRound(s, ev, {
      cue,
      attemptId: d.attemptId ? String(d.attemptId) : null,
      revision: num(d.revision, 1),
      text: cue.text,
      reason: null,
    });
  }

  // 修订轮次重发：同序号、修订号递增、替换文本、新 attemptId、轮次状态整体清空
  function resendRound(s, ev) {
    const d = ev.detail || {};
    const seq = num(d.seq, s.currentRound ? s.currentRound.seq : 0);
    const cue = s.cuesBySeq.get(seq) || s.currentCue;
    if (cue) cue.finalText = String(d.text || cue.finalText);
    openRound(s, ev, {
      cue,
      seq,
      attemptId: d.attemptId ? String(d.attemptId) : null,
      revision: num(d.revision, (s.currentRound ? s.currentRound.revision : 1) + 1),
      text: d.text != null && d.text !== '' ? String(d.text) : (cue ? cue.finalText : ''),
      reason: d.reason || (s.currentRound ? s.currentRound.reason : null),
    });
  }

  // 轮次归属：优先按 attemptId 精确命中；缺失 / 未登记时回退该 seq 最新轮次
  // （真实日志轮次事件均携带 attemptId，回退仅为合成 / 损坏日志的健壮兜底）
  function roundOf(s, d) {
    d = d || {};
    if (d.attemptId && s.roundsByAttempt.has(String(d.attemptId))) {
      return s.roundsByAttempt.get(String(d.attemptId));
    }
    const seq = num(d.seq, 0);
    const list = s.roundsBySeq.get(seq);
    return list && list.length ? list[list.length - 1] : null;
  }

  function recordConfirm(round, ev, late) {
    const d = ev.detail || {};
    const position = d.position ? String(d.position) : null;
    if (!position) return;
    let c = round.confirms.find((x) => x.position === position);
    if (!c) {
      c = { position, late: !!late, t: num(ev.t), line: ev.line, duplicateEvents: [] };
      round.confirms.push(c);
      round.confirmsMap[position] = { late: !!late };
    }
    if (late) {
      c.late = true;
      round.confirmsMap[position] = { late: true };
      round.timedOut = round.timedOut.filter((x) => x !== position);
      if (round.cue) round.cue.lateConfirms += 1;
    }
  }

  // ---------------------------------------------------------------------------
  // 单事件转移（reducer）：纯函数，就地更新传入状态后返回同一引用。
  // 未知事件一律不改变状态；损坏 / 缺字段事件在解析层已告警并跳过，
  // 内核内对任何字段缺失仍保持防御性降级。
  // ---------------------------------------------------------------------------
  function foldEvent(s, ev) {
    if (!ev || typeof ev.event !== 'string') return s;
    const d = (ev && ev.detail) || {};

    switch (ev.event) {
      case 'session-start':
        s.phase = 'active';
        break;

      case 'cue-started':
        s.phase = 'active';
        if (Number.isInteger(num(d.seq, NaN)) && num(d.seq) > 0) startCue(s, ev);
        break;

      // 撤回：先按旧轮次现场封存只读历史（cue-resent 清空本轮状态之前）。
      // 同一毫秒内 cue-recalled 必然先于 cue-resent 落盘（行序即顺序）。
      // 归属优先取事件携带的 oldAttemptId（撤回事件不携带当前 attemptId），
      // 其次按当前 attemptId / seq 解析，避免异常行序下误封存新轮。
      case 'cue-recalled': {
        const oldId = d.oldAttemptId ? String(d.oldAttemptId) : null;
        let r = oldId ? s.roundsByAttempt.get(oldId) : null;
        if (!r) {
          const resolved = roundOf(s, d);
          if (resolved && (!resolved.attemptId || resolved.attemptId === oldId ||
              (resolved.attemptId && d.attemptId && String(d.attemptId) === resolved.attemptId))) {
            r = resolved;
          } else if (!oldId && resolved) {
            r = resolved; // 合成日志完全不带凭证时的健壮兜底
          }
        }
        if (r && !r.endState) {
          if (d.reason) r.reason = String(d.reason);
          const saved = s.currentRound;
          if (saved !== r) s.currentRound = r;
          snapshotRound(s, 'recalled', d.reason, ev);
          if (saved !== r) s.currentRound = saved;
        }
        break;
      }

      // 修订版重发：同序号递增修订号、替换文本、清空本轮状态重新确认
      case 'cue-resent':
        resendRound(s, ev);
        break;

      case 'cue-completed': {
        const r = roundOf(s, d);
        if (r && !r.endState && s.currentRound === r) {
          snapshotRound(s, 'completed', null, ev);
          s.currentCue.completeT = num(ev.t);
        } else if (r && !r.endState) {
          const saved = s.currentRound;
          s.currentRound = r;
          snapshotRound(s, 'completed', null, ev);
          s.currentRound = saved;
        }
        if (s.seq != null) s.results[s.seq] = 'completed';
        s.phase = 'between';
        break;
      }

      case 'confirm':
        if (s.currentRound && !s.currentRound.endState) {
          recordConfirm(s.currentRound, ev, false);
          syncLive(s);
        }
        break;

      case 'confirm-late':
        if (s.currentRound && !s.currentRound.endState) {
          recordConfirm(s.currentRound, ev, true);
          syncLive(s);
        }
        break;

      case 'confirm-duplicate': {
        // 重复确认只作刻度，不改变确认状态；极端情况下首条确认缺失时仍补记已确认
        const r = roundOf(s, d) || s.currentRound;
        if (r && d.position) {
          const position = String(d.position);
          let c = r.confirms.find((x) => x.position === position);
          if (!c) {
            c = { position, late: false, t: num(ev.t), line: ev.line, duplicateEvents: [] };
            r.confirms.push(c);
            if (!r.confirmsMap[position]) r.confirmsMap[position] = { late: false };
          }
          c.duplicateEvents.push({ t: num(ev.t), line: ev.line });
        }
        break;
      }

      case 'cue-timeout': {
        // 与服务端一致：超时表只在首次定时器到期写入，不覆盖后续确认结果
        const r = roundOf(s, d) || s.currentRound;
        if (r && !r.timeoutEvent && Array.isArray(d.missing)) {
          r.timeoutEvent = { t: num(ev.t), line: ev.line, missing: d.missing.map(String) };
          r.timeoutCount = (r.timeoutCount || 0) + 1;
          if (r.timedOut.length === 0) r.timedOut = [...d.missing.map(String)];
          if (r.cue) r.cue.timeoutEvents += 1;
          if (s.currentRound === r) syncLive(s);
        }
        break;
      }

      case 'position-substituted': {
        // 仅当前口令 / 当前轮生效；同一原岗位只接管一次（与服务端拒绝重复替岗一致）
        const r = roundOf(s, d) || s.currentRound;
        const from = String(d.from || '');
        const to = String(d.to || '');
        if (r && from && to && !r.substitutionsMap[from]) {
          r.substitutionsMap[from] = { substitute: to };
          r.substitutions.push({ from, to, t: num(ev.t), line: ev.line });
          // 超时未确认标记随确认权一并移交给替补
          r.timedOut = r.timedOut.map((x) => (x === from ? to : x));
          if (s.currentRound === r) syncLive(s);
        }
        break;
      }

      case 'cue-paused': {
        const r = roundOf(s, d) || s.currentRound;
        if (r) {
          r.paused = true;
          r.pauseReason = d.reason != null ? String(d.reason) : '';
          r.pauses.push({
            startT: num(ev.t), endT: null,
            reason: String(d.reason || ''),
            startLine: ev.line, endLine: null, startIso: ev.ts,
          });
          if (r.cue) r.cue.pauseEvents += 1;
          if (s.currentRound === r) {
            s.paused = true;
            s.pauseReason = r.pauseReason;
          }
        }
        break;
      }

      case 'cue-resumed': {
        const r = roundOf(s, d) || s.currentRound;
        if (r) {
          r.paused = false;
          r.pauseReason = null;
          const open = [...r.pauses].reverse().find((p) => p.endT == null);
          if (open) {
            open.endT = num(ev.t);
            open.endLine = ev.line;
          } else {
            // 恢复事件早于 / 缺失配对暂停（合成日志兜底）：记为零长区间
            r.pauses.push({
              startT: num(ev.t), endT: num(ev.t), reason: '',
              startLine: ev.line, endLine: ev.line, startIso: ev.ts,
            });
          }
          if (s.currentRound === r) {
            s.paused = false;
            s.pauseReason = null;
          }
        }
        break;
      }

      case 'paused-confirm-rejected': {
        // 暂停中的确认尝试只作拒绝标记，绝不计入确认
        const r = roundOf(s, d) || s.currentRound;
        if (r && d.position) {
          r.rejectedPauses.push({ position: String(d.position), t: num(ev.t), line: ev.line });
        }
        break;
      }

      case 'stale-confirm-ignored': {
        // 迟到到达的旧轮次确认：仅按其携带的旧 attemptId 归属原轮次；
        // 不带 attemptId（sentAttemptId 为空）时无法识别原轮次，归为孤立事件，
        // 绝不计入当前轮次（否则会把拒绝标记错误贴到修订轮上）
        const oldId = d.sentAttemptId ? String(d.sentAttemptId) : null;
        const r = oldId ? s.roundsByAttempt.get(oldId) : null;
        const item = {
          kind: 'stale-confirm', t: num(ev.t), line: ev.line,
          position: d.position ? String(d.position) : null,
          sentAttemptId: oldId,
        };
        if (r) r.stale.push(item); else s.orphanStale.push(item);
        break;
      }

      case 'stale-substitute-ignored': {
        const oldId = d.sentAttemptId ? String(d.sentAttemptId) : null;
        const r = oldId ? s.roundsByAttempt.get(oldId) : null;
        const item = {
          kind: 'stale-substitute', t: num(ev.t), line: ev.line,
          position: d.to ? String(d.to) : null,
          sentAttemptId: oldId,
        };
        if (r) r.stale.push(item); else s.orphanStale.push(item);
        break;
      }

      case 'stale-timeout-ignored': {
        // 旧定时器回调被拒：只按 staleAttemptId 精确归属其旧轮（撤回旧轮的
        // 定时器、整场结束后的迟到回调 currentAttemptId=null）。未知 id 或
        // 不带 id 时归为孤立事件——不按 seq 退回最新轮，避免把别场 / 别轮的
        // 迟到回调错误贴到当前轮。
        const oldId = d.staleAttemptId ? String(d.staleAttemptId) : null;
        const r = oldId ? s.roundsByAttempt.get(oldId) : null;
        const item = {
          kind: 'stale-timeout', t: num(ev.t), line: ev.line,
          position: null, sentAttemptId: oldId,
        };
        if (r) r.stale.push(item); else s.orphanStale.push(item);
        break;
      }

      // 租约、草稿、上下线、sequence-set、session-reset 等事件只存在于
      // 事件流 / 时间轴上，不改变口令现场模型。
      case 'sequence-finished':
        s.phase = 'done';
        s.paused = false;
        s.pauseReason = null;
        s.confirmations = {};
        s.timedOut = [];
        s.substitutions = {};
        if (s.currentRound) {
          s.currentRound.paused = false;
          s.currentRound.pauseReason = null;
        }
        break;

      default:
        break;
    }
    return s;
  }

  // 顺序折叠全部事件（对比 / 诊断消费者使用；不传 until）。
  // 返回完整富模型（轮次通过 cue 反向引用成环，不可直接 JSON 序列化）。
  function foldEvents(events, opts = {}) {
    const s = initialState();
    const timeoutSec = Number(opts.timeoutSec);
    if (Number.isFinite(timeoutSec) && timeoutSec > 0) s.timeoutSec = timeoutSec;
    const list = Array.isArray(events) ? events : [];
    for (const ev of list) foldEvent(s, ev);
    return s;
  }

  // 从场次起点确定性重放到 targetT：逐事件应用所有偏移 <= targetT 的事件。
  // events 已按日志行序排列（服务端保证追加顺序），同一毫秒内 cue-recalled
  // 也必然先于 cue-resent 落盘，因此折叠结果与顺序播放逐帧到达时完全相同。
  //
  // 复盘页只消费现场镜像（与历史状态同形、可直接 JSON 序列化比较）；富模型
  // （cues/rounds 等）仅供 foldEvents 全量折叠的对比 / 诊断消费者。
  function foldUntil(events, targetT, opts = {}) {
    const s = initialState();
    const timeoutSec = Number(opts.timeoutSec);
    if (Number.isFinite(timeoutSec) && timeoutSec > 0) s.timeoutSec = timeoutSec;
    const list = Array.isArray(events) ? events : [];
    for (const ev of list) {
      if (num(ev && ev.t, 0) > targetT) break;
      foldEvent(s, ev);
    }
    return toViewState(s);
  }

  // 富折叠状态 → 复盘现场视图（无环、字段与历史 foldUntil 输出逐一同形）
  function toViewState(s) {
    return {
      phase: s.phase,
      results: s.results,
      seq: s.seq,
      text: s.text,
      originalText: s.originalText,
      targets: s.targets,
      revision: s.revision,
      reason: s.reason,
      attemptId: s.attemptId,
      confirmations: s.confirmations,
      timedOut: s.timedOut,
      substitutions: s.substitutions,
      paused: s.paused,
      pauseReason: s.pauseReason,
      attempts: s.attempts,
      roundStartIso: s.roundStartIso,
    };
  }

  // 当前口令有效目标（被替岗的原岗位由替补顶替）
  function effectiveTargets(s) {
    const targets = s.currentRound ? s.currentRound.cue.targets : s.targets;
    const subs = s.currentRound ? s.currentRound.substitutionsMap : s.substitutions;
    return targets.map((t) => (subs[t] ? subs[t].substitute : t));
  }

  // 折叠状态 → 可渲染视图（岗位状态分组）；筛选与展示属于消费者职责
  function viewOf(s) {
    const effective = effectiveTargets(s);
    const confirmed = [];
    const timedOut = [];
    const pending = [];
    for (const t of effective) {
      const c = s.confirmations[t];
      if (c) confirmed.push({ position: t, late: !!c.late });
      else if (s.timedOut.includes(t)) timedOut.push(t);
      else pending.push(t);
    }
    return { effective, confirmed, timedOut, pending };
  }

  // 单场口令指标提取（场次对比消费者）：完全基于折叠模型，按 seq 升序输出。
  // 与 foldEvents 同一份状态机：修订不重置起点、暂停 / 超时 / 迟到 / 修订计数
  // 均按归属轮次 / 口令聚合。keyBuilder(cue) 由对比模块注入规范化匹配键，
  // 内核不依赖任何具体规范化策略。
  function extractCues(events, opts = {}) {
    const s = foldEvents(events, opts);
    const cues = [...s.cues].sort((a, b) => a.seq - b.seq).map((cue) => {
      const revisionCount = cue.rounds.filter((r) => r.revision > 1).length
        || Math.max(0, (cue.revisions || 1) - 1);
      const out = {
        seq: cue.seq,
        text: cue.originalText,
        targets: [...cue.targets],
        key: typeof opts.keyBuilder === 'function' ? opts.keyBuilder(cue) : null,
        startT: cue.startT != null ? cue.startT : null,
        completeT: cue.completeT,
        durationMs: cue.completeT != null && cue.startT != null ? cue.completeT - cue.startT : null,
        timeouts: cue.timeoutEvents,
        lateConfirms: cue.lateConfirms,
        revisions: revisionCount,
        pauses: cue.pauseEvents,
        finalText: cue.finalText || cue.originalText,
      };
      return out;
    });
    return cues;
  }

  return {
    DEFAULT_TIMEOUT_SEC,
    initialState,
    foldEvent,
    foldEvents,
    foldUntil,
    toViewState,
    effectiveTargets,
    viewOf,
    extractCues,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ReplayCore;
}
