/* 确认延迟诊断前端（只读）：基于复盘 GET 接口返回的单场事件流，
 * 按 attemptId 重建每个口令的每一次确认轮次（含撤回修订轮次），
 * 并从等待时长中扣除暂停区间，生成各目标岗位的确认瀑布数据。
 *
 * 只读保证（与复盘 / 对比 / 归档一致）：
 *   - 本文件是纯函数分析器，不创建 WebSocket、不调用任何写接口；
 *     场次数据由页面经 /api/replay/sessions 与 /api/replay/sessions/:fileId/:runId
 *     两个既有只读 GET 接口拉取（复用演出复盘接口，不新增服务端接口）；
 *   - 所有结论只由日志行序上的事件重建，绝不引用当前演出状态。
 *
 * 重建口径（与 server.js 实时状态机、public/replay.js 的 foldUntil 完全一致）：
 *   - cue-started 开启第 1 轮（attemptId 取事件详情中的值）；cue-resent 开启
 *     修订轮次（同 seq、revision 递增、新 attemptId）；cue-recalled 封存上一轮为
 *     recalled，cue-completed 封存为 completed；
 *   - position-substituted 之后，确认计入接管岗位（替补），超时标记随之移交；
 *   - confirm-late 同时保留「超时」与「迟到」两个标记；
 *   - cue-paused/cue-resumed 为闭合暂停区间（同一 attemptId），计算等待时长时
 *     按与 [轮次开始, 观察时刻] 的交集整体扣除，重复暂停 / 恢复不累计误差。
 */
'use strict';

const CueLatency = (() => {
  const STATUS_CONFIRMED = 'confirmed';
  const STATUS_LATE = 'late';
  const STATUS_TIMEOUT = 'timeout'; // 轮次结束时仍超时未确认
  const STATUS_PENDING = 'pending'; // 撤回时未确认（轮次尚未走到超时）

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // 两个闭区间的重叠时长（输入均为毫秒偏移）；无重叠返回 0
  function overlapMs(aStart, aEnd, bStart, bEnd) {
    const lo = Math.max(aStart, bStart);
    const hi = Math.min(aEnd, bEnd);
    return Math.max(0, hi - lo);
  }

  // 从 [fromT, toT] 中扣除与各暂停区间的重叠，得到有效（非暂停）等待时长
  function activeWaitMs(pauses, fromT, toT) {
    if (!(toT > fromT)) return 0;
    let paused = 0;
    for (const p of pauses) {
      paused += overlapMs(fromT, toT, p.startT, p.endT);
    }
    return Math.max(0, toT - fromT - paused);
  }

  // 有效等待区间切分为用于绘制瀑布条的段落：普通段（active）+ 暂停段（pause）。
  // 暂停段仍按墙钟时间占位，仅视觉上以斜纹区分；条上标注的有效等待时长已扣除暂停。
  function segmentsBetween(pauses, fromT, toT) {
    if (!(toT >= fromT)) return [];
    const cuts = [fromT];
    for (const p of pauses) {
      if (p.startT > fromT && p.startT < toT) cuts.push(p.startT);
      if (p.endT > fromT && p.endT < toT) cuts.push(p.endT);
    }
    cuts.push(toT);
    cuts.sort((a, b) => a - b);
    const segs = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const s = cuts[i];
      const e = cuts[i + 1];
      if (e <= s) continue;
      const mid = (s + e) / 2;
      const inPause = pauses.some((p) => mid >= p.startT && mid <= p.endT);
      segs.push({ startT: s, endT: e, durationMs: e - s, kind: inPause ? 'pause' : 'active' });
    }
    return segs;
  }

  // -------------------------------------------------------------------------
  // 单场分析（纯函数）
  //
  // 输入 sessionData：GET /api/replay/sessions/:fileId/:runId 的返回
  //   { session, timeoutSec, sequence, events: [{line,ts,t,event,detail}], ... }
  // 输出：
  //   { session, timeoutSec, positions, summary, cues: [
  //       { seq, text, targets, revisions, recallReasons,
  //         rounds: [Round], totals: {...Cue 级汇总} } ],
  //     orphanStale: [...] } 不属于任何可识别轮次的旧轮次拒绝事件
  //
  // Round：
  //   { attemptId, revision, seq, text, reason, startEvent, startT,
  //     endState, endEvent, endT, budgetMs, deadlineT,
  //     pauses: [{startT,endT,reason,startEvent,resumeEvent,startIso}],
  //     pausedTotalMs, substitutions: [{from,to,t,event}],
  //     timeoutEvent, confirms: [{position,late,t,event,duplicateEvents}],
  //     rejectedPauses: [...], stale: [{kind,t,event,position,detail}],
  //     rows: [{slot, position, origin, substitutedAt, status,
  //             eventT, eventLine, endT, waitMs, wallMs, pausedMs,
  //             wasTimeout, segments, jumpT, jumpLine, duplicateEvents}],
  //     axisMax, stats }
  // -------------------------------------------------------------------------
  function analyzeSession(sessionData) {
    const timeoutSec = Number(sessionData && sessionData.timeoutSec) > 0
      ? Number(sessionData.timeoutSec) : 30;
    const events = Array.isArray(sessionData && sessionData.events) ? sessionData.events : [];

    const cuesBySeq = new Map(); // seq -> 冻结口令（取首次 cue-started 的文本/目标）
    const roundOrder = []; // 全部轮次（按事件行序）
    const roundsByAttempt = new Map(); // attemptId -> round
    const roundsBySeq = new Map(); // seq -> [round...]（含未携带 attemptId 的合成日志兜底）
    const orphanStale = [];

    const ensureCue = (seq) => {
      let cue = cuesBySeq.get(seq);
      if (!cue) {
        cue = {
          seq,
          text: '',
          targets: [],
          revisions: 0,
          recallReasons: [],
          rounds: [],
        };
        cuesBySeq.set(seq, cue);
      }
      return cue;
    };

    const openRound = (ev, attemptId, revision, text, reason) => {
      const d = (ev && ev.detail) || {};
      const seq = num(d.seq, 0);
      const cue = ensureCue(seq);
      if (!cue.text) {
        cue.text = String(d.text || '');
        cue.targets = Array.isArray(d.targets)
          ? [...new Set(d.targets.map((x) => String(x).trim()).filter(Boolean))]
          : [];
      }
      const round = {
        attemptId: attemptId || null,
        revision: num(revision, 1),
        seq,
        text: String(text != null && text !== '' ? text : cue.text),
        reason: reason || null,
        startEvent: ev ? ev.event : null,
        startLine: ev ? ev.line : null,
        startT: ev ? num(ev.t) : null,
        startIso: ev ? ev.ts : null,
        endState: null, // completed | recalled
        endEvent: null,
        endLine: null,
        endT: null,
        endIso: null,
        budgetMs: timeoutSec * 1000,
        deadlineT: null,
        cue,
        pauses: [], // {startT,endT,reason,startLine,endLine,startIso}
        substitutions: [], // {from,to,t,line}
        timeoutEvent: null, // {t,line,missing}
        confirms: [], // {position,late,t,line,duplicateEvents:[{t,line}]}
        rejectedPauses: [], // 暂停中确认被拒 {position,t,line}
        stale: [], // 归属到本轮的旧轮次拒绝（attemptId 与本轮不符）
      };
      cue.rounds.push(round);
      cue.revisions = Math.max(cue.revisions, round.revision);
      if (round.revision > 1 && reason && !cue.recallReasons.includes(reason)) {
        cue.recallReasons.push(reason);
      }
      if (attemptId) roundsByAttempt.set(attemptId, round);
      if (!roundsBySeq.has(seq)) roundsBySeq.set(seq, []);
      roundsBySeq.get(seq).push(round);
      roundOrder.push(round);
      return round;
    };

    // 按 attemptId 精确归属；缺失 / 找不到 attemptId 时退回该 seq 的最新轮次
    // （真实日志中轮次事件均携带 attemptId，退回仅为合成 / 损坏日志的健壮兜底）
    function roundOf(d) {
      if (d.attemptId && roundsByAttempt.has(String(d.attemptId))) {
        return roundsByAttempt.get(String(d.attemptId));
      }
      const seq = num(d.seq, 0);
      const list = roundsBySeq.get(seq);
      return list && list.length ? list[list.length - 1] : null;
    }

    for (const ev of events) {
      const d = (ev && ev.detail) || {};
      const t = num(ev.t);

      switch (ev.event) {
        case 'cue-started': {
          openRound(ev, d.attemptId ? String(d.attemptId) : null, num(d.revision, 1), d.text, null);
          break;
        }

        case 'cue-resent': {
          // 同一毫秒内 cue-recalled 必然先落盘（上一轮已封存）；修订轮次另起 attemptId
          openRound(ev, d.attemptId ? String(d.attemptId) : null,
            num(d.revision, 1), d.text, d.reason || null);
          break;
        }

        case 'cue-recalled': {
          const r = roundOf(d);
          if (r && !r.endState) {
            r.endState = 'recalled';
            r.endEvent = 'cue-recalled';
            r.endLine = ev.line;
            r.endT = t;
            r.endIso = ev.ts;
            if (d.reason) r.reason = String(d.reason);
          }
          break;
        }

        case 'cue-completed': {
          const r = roundOf(d);
          if (r && !r.endState) {
            r.endState = 'completed';
            r.endEvent = 'cue-completed';
            r.endLine = ev.line;
            r.endT = t;
            r.endIso = ev.ts;
          }
          break;
        }

        case 'cue-paused': {
          const r = roundOf(d);
          if (r) {
            r.pauses.push({
              startT: t, endT: null, reason: String(d.reason || ''),
              startLine: ev.line, endLine: null, startIso: ev.ts,
            });
          }
          break;
        }

        case 'cue-resumed': {
          const r = roundOf(d);
          if (r) {
            const open = [...r.pauses].reverse().find((p) => p.endT == null);
            if (open) { open.endT = t; open.endLine = ev.line; }
            else r.pauses.push({ startT: t, endT: t, reason: '', startLine: ev.line, endLine: ev.line, startIso: ev.ts });
          }
          break;
        }

        case 'position-substituted': {
          const r = roundOf(d);
          if (r && d.from && d.to) {
            r.substitutions.push({ from: String(d.from), to: String(d.to), t, line: ev.line });
          }
          break;
        }

        case 'cue-timeout': {
          const r = roundOf(d);
          if (r && !r.timeoutEvent) {
            r.timeoutEvent = {
              t, line: ev.line,
              missing: Array.isArray(d.missing) ? d.missing.map(String) : [],
            };
          }
          break;
        }

        case 'confirm':
        case 'confirm-late': {
          const r = roundOf(d);
          if (r && d.position) {
            const position = String(d.position);
            let c = r.confirms.find((x) => x.position === position);
            if (!c) {
              c = { position, late: ev.event === 'confirm-late', t, line: ev.line, duplicateEvents: [] };
              r.confirms.push(c);
            }
            if (ev.event === 'confirm-late') c.late = true;
          }
          break;
        }

        case 'confirm-duplicate': {
          const r = roundOf(d);
          if (r && d.position) {
            const position = String(d.position);
            let c = r.confirms.find((x) => x.position === position);
            if (!c) {
              // 极端情况下首条确认日志缺失：重复确认仍证明该岗位已确认
              c = { position, late: false, t, line: ev.line, duplicateEvents: [] };
              r.confirms.push(c);
            }
            c.duplicateEvents.push({ t, line: ev.line });
          }
          break;
        }

        case 'paused-confirm-rejected': {
          const r = roundOf(d);
          if (r && d.position) r.rejectedPauses.push({ position: String(d.position), t, line: ev.line });
          break;
        }

        case 'stale-confirm-ignored': {
          // 迟到到达的旧轮次确认：仅按其携带的旧 attemptId 归属原轮次；
          // 不带 attemptId（sentAttemptId 为空）时无法识别原轮次，归为孤立事件，
          // 绝不计入当前轮次（否则会把拒绝标记错误地贴到修订轮上）
          const oldId = d.sentAttemptId ? String(d.sentAttemptId) : null;
          const r = oldId ? roundsByAttempt.get(oldId) : null;
          const item = {
            kind: 'stale-confirm', t, line: ev.line,
            position: d.position ? String(d.position) : null,
            sentAttemptId: oldId,
          };
          if (r) r.stale.push(item); else orphanStale.push(item);
          break;
        }

        case 'stale-substitute-ignored': {
          const oldId = d.sentAttemptId ? String(d.sentAttemptId) : null;
          const r = oldId ? roundsByAttempt.get(oldId) : null;
          const item = {
            kind: 'stale-substitute', t, line: ev.line,
            position: d.to ? String(d.to) : null,
            sentAttemptId: oldId,
          };
          if (r) r.stale.push(item); else orphanStale.push(item);
          break;
        }

        case 'stale-timeout-ignored': {
          // 旧定时器回调被拒：携带 staleAttemptId（如召回旧轮的定时器），
          // 或仅有 currentAttemptId=null（整场结束后的迟到回调）
          const oldId = d.staleAttemptId ? String(d.staleAttemptId) : null;
          const r = (oldId && roundsByAttempt.get(oldId)) || (d.seq ? roundOf(d) : null);
          const item = {
            kind: 'stale-timeout', t, line: ev.line, position: null, sentAttemptId: oldId,
          };
          if (r) r.stale.push(item); else orphanStale.push(item);
          break;
        }

        default:
          break;
      }
    }

    // 防御：session-start → sequence-finished 闭合场次的最后一轮必有
    // cue-completed；若日志损坏缺失封存事件，以轮次后下一个边界事件时刻收口
    for (const round of roundOrder) {
      if (!round.endState) {
        round.endState = 'completed';
        round.endEvent = round.startEvent;
        round.endLine = round.startLine;
        round.endT = round.startT;
        round.endIso = round.startIso;
      }
    }

    // ---------------------------------------------------------------------
    // 逐轮生成目标岗位行（瀑布数据）
    // ---------------------------------------------------------------------
    const positions = [];
    const seenPos = new Set();
    const addPos = (p) => {
      const s = String(p || '').trim();
      if (s && !seenPos.has(s)) { seenPos.add(s); positions.push(s); }
    };

    for (const round of roundOrder) finalizeRound(round, positions, addPos);

    const cues = [...cuesBySeq.values()].sort((a, b) => a.seq - b.seq);
    cues.forEach((cue) => buildCueTotals(cue));

    const summary = buildSummary(cues, roundOrder, orphanStale);

    return {
      session: sessionData.session || null,
      timeoutSec,
      positions,
      cues,
      rounds: roundOrder,
      orphanStale,
      summary,
    };
  }

  // 某轮在 t 时刻的有效目标：被替岗的原岗位由替补顶替（与服务端口径一致）
  function effectiveAt(round, t) {
    return round.cue.targets.map((origin) => {
      const sub = round.substitutions
        .filter((s) => s.from === origin && s.t <= t)
        .pop();
      return sub ? sub.to : origin;
    });
  }

  function finalizeRound(round, positions, addPos) {
    // 未闭合暂停（日志损坏 / 轮次被重置中断）：以轮次收口时刻截断，不产生负时长
    round.pauses.forEach((p) => {
      if (p.endT == null) {
        p.endT = round.endT != null ? Math.max(p.startT, round.endT) : p.startT;
        p.unclosed = true;
      }
    });
    round.pausedTotalMs = round.pauses.reduce((sum, p) => sum + Math.max(0, p.endT - p.startT), 0);

    // 有效截止时刻 = 初始时限 + 累计暂停时长（恢复时按冻结余量重排 deadline 的等价结果）
    round.deadlineT = round.startT + round.budgetMs + round.pausedTotalMs;

    const timeoutMissing = round.timeoutEvent ? round.timeoutEvent.missing : [];
    const timeoutT = round.timeoutEvent ? round.timeoutEvent.t : null;

    round.rows = round.cue.targets.map((origin) => {
      // 该槽位最终的接管关系（轮次结束前最后一次生效的替岗）
      const subs = round.substitutions.filter((s) => s.from === origin);
      const sub = subs.length ? subs[subs.length - 1] : null;
      const position = sub ? sub.to : origin;

      addPos(origin);
      addPos(position);
      subs.forEach((s) => addPos(s.to));

      const confirm = round.confirms.find((c) => c.position === position);
      // 该槽位是否进入过超时表：cue-timeout 时按当时的有效目标归属槽位
      let wasTimeout = false;
      if (round.timeoutEvent) {
        if (timeoutMissing.includes(position)) wasTimeout = true;
        // 替补恰好在超时事件之后才接管：超时标记仍随确认权移交（与服务端一致）
        else if (sub && timeoutMissing.includes(origin) &&
                 (!sub || sub.t >= round.timeoutEvent.t) &&
                 !round.confirms.some((c) => c.position === origin)) {
          wasTimeout = true;
        }
      }

      let status;
      let eventT = null; // 决定结果的事件时刻（确认 / 超时）
      let eventLine = null;
      let endT; // 瀑布条观察终点
      let jumpT; // 点击跳转复盘的时刻（相对本场起点）
      let jumpLine;

      if (confirm) {
        status = confirm.late ? STATUS_LATE : STATUS_CONFIRMED;
        eventT = confirm.t;
        eventLine = confirm.line;
        endT = confirm.t;
        jumpT = confirm.t;
        jumpLine = confirm.line;
      } else if (wasTimeout && round.endState === 'recalled') {
        // 撤回时已超时未确认：保留超时标记，但轮次结果是被撤回
        status = STATUS_TIMEOUT;
        eventT = timeoutT;
        eventLine = round.timeoutEvent.line;
        endT = round.endT != null ? round.endT : timeoutT;
        jumpT = timeoutT;
        jumpLine = round.timeoutEvent.line;
      } else if (wasTimeout) {
        status = STATUS_TIMEOUT;
        eventT = timeoutT;
        eventLine = round.timeoutEvent.line;
        endT = round.endT != null ? round.endT : timeoutT;
        jumpT = timeoutT;
        jumpLine = round.timeoutEvent.line;
      } else {
        status = STATUS_PENDING;
        endT = round.endT != null ? round.endT : round.startT;
        jumpT = round.endT != null ? round.endT : round.startT;
        jumpLine = round.endLine != null ? round.endLine : round.startLine;
      }

      const wallMs = Math.max(0, endT - round.startT);
      const pausedMs = activePausedMs(round.pauses, round.startT, endT);
      const waitMs = Math.max(0, wallMs - pausedMs);

      return {
        slot: origin,
        position,
        origin,
        substituted: !!sub,
        substitutedAt: sub ? sub.t : null,
        substituteLine: sub ? sub.line : null,
        status,
        eventT,
        eventLine,
        endT,
        waitMs,
        wallMs,
        pausedMs,
        wasTimeout,
        segments: segmentsBetween(round.pauses, round.startT, Math.max(round.startT, endT)),
        jumpT,
        jumpLine,
        duplicateEvents: confirm ? confirm.duplicateEvents : [],
      };
    });

    // 轴上限：至少覆盖截止时刻，保证「时限（扣除暂停）」参考线始终可见
    round.axisMax = Math.max(
      round.deadlineT,
      round.endT != null ? round.endT : round.startT,
      round.startT + round.budgetMs
    ) - round.startT;

    round.stats = buildRoundStats(round);
  }

  // [fromT,toT] 内的暂停总时长（仅统计已闭合区间）
  function activePausedMs(pauses, fromT, toT) {
    let sum = 0;
    for (const p of pauses) {
      if (p.endT == null) continue;
      sum += overlapMs(fromT, toT, p.startT, p.endT);
    }
    return sum;
  }

  function buildRoundStats(round) {
    const rows = round.rows;
    const stat = {
      total: rows.length,
      confirmed: rows.filter((r) => r.status === STATUS_CONFIRMED).length,
      late: rows.filter((r) => r.status === STATUS_LATE).length,
      timeout: rows.filter((r) => r.status === STATUS_TIMEOUT).length,
      pending: rows.filter((r) => r.status === STATUS_PENDING).length,
      // 有效等待（扣除暂停）的最大 / 合计，用于跨轮横向比较
      maxWaitMs: rows.reduce((m, r) => Math.max(m, r.waitMs), 0),
      totalWaitMs: rows.reduce((s, r) => s + r.waitMs, 0),
      pausedTotalMs: round.pausedTotalMs,
      substitutions: round.substitutions.length,
      pauses: round.pauses.length,
      rejectedPauses: round.rejectedPauses.length,
      stale: round.stale.length,
    };
    stat.result = round.endState === 'recalled'
      ? 'recalled'
      : (stat.timeout > 0 ? 'timeout' : (stat.late > 0 ? 'late' : 'ok'));
    return stat;
  }

  function buildCueTotals(cue) {
    const rows = cue.rounds.flatMap((r) => r.rows);
    // 最终轮次（最后一个 completed 轮）的岗位结果，用于结果筛选
    const completedRounds = cue.rounds.filter((r) => r.endState === 'completed');
    const finalRound = completedRounds[completedRounds.length - 1] || null;
    const finalStats = finalRound ? finalRound.stats : null;
    cue.totals = {
      rounds: cue.rounds.length,
      revisions: cue.rounds.length - 1,
      recalls: cue.rounds.filter((r) => r.endState === 'recalled').length,
      pauses: cue.rounds.reduce((n, r) => n + r.pauses.length, 0),
      pausedTotalMs: cue.rounds.reduce((n, r) => n + r.pausedTotalMs, 0),
      substitutions: cue.rounds.reduce((n, r) => n + r.substitutions.length, 0),
      timeouts: cue.rounds.reduce((n, r) => n + r.stats.timeout, 0),
      lateConfirms: cue.rounds.reduce((n, r) => n + r.stats.late, 0),
      maxWaitMs: rows.reduce((m, r) => Math.max(m, r.waitMs), 0),
      // 最终结果（决定口令卡片的结果标记）
      finalResult: finalStats ? finalStats.result : 'recalled',
      finalTimeout: finalStats ? finalStats.timeout : 0,
      finalLate: finalStats ? finalStats.late : 0,
      hasTimeoutEver: rows.some((r) => r.wasTimeout),
      hasLateEver: rows.some((r) => r.status === STATUS_LATE),
      hasSubstitution: cue.rounds.some((r) => r.substitutions.length > 0),
      hasPause: cue.rounds.some((r) => r.pauses.length > 0),
      stale: cue.rounds.reduce((n, r) => n + r.stale.length, 0),
    };
    return cue.totals;
  }

  function buildSummary(cues, rounds, orphanStale) {
    const allRows = rounds.flatMap((r) => r.rows);
    return {
      cueCount: cues.length,
      roundCount: rounds.length,
      revisionCount: rounds.filter((r) => r.revision > 1).length,
      targetCount: allRows.length,
      confirmed: allRows.filter((r) => r.status === STATUS_CONFIRMED).length,
      late: allRows.filter((r) => r.status === STATUS_LATE).length,
      timeout: allRows.filter((r) => r.status === STATUS_TIMEOUT).length,
      pending: allRows.filter((r) => r.status === STATUS_PENDING).length,
      pauses: rounds.reduce((n, r) => n + r.pauses.length, 0),
      pausedTotalMs: rounds.reduce((n, r) => n + r.pausedTotalMs, 0),
      substitutions: rounds.reduce((n, r) => n + r.substitutions.length, 0),
      rejectedPauses: rounds.reduce((n, r) => n + r.rejectedPauses.length, 0),
      stale: rounds.reduce((n, r) => n + r.stale.length, 0) + orphanStale.length,
      maxWaitMs: allRows.reduce((m, r) => Math.max(m, r.waitMs), 0),
      cuesRecalled: cues.filter((c) => c.totals.recalls > 0).length,
      cuesWithTimeout: cues.filter((c) => c.totals.hasTimeoutEver).length,
      cuesWithLate: cues.filter((c) => c.totals.hasLateEver).length,
    };
  }

  // 岗位筛选：原岗位与接管岗位均命中（替岗后两个名字都能筛到该轮行）
  function rowMatchesPosition(row, position) {
    if (!position || position === 'all') return true;
    return row.origin === position || row.position === position;
  }

  // 结果筛选（口径在页面与测试中共用）：
  //   ok      —— 最终轮次全员按时确认
  //   late    —— 最终轮次存在迟到确认（也涵盖先超时后迟到）
  //   timeout —— 最终轮次结束时仍有岗位超时未确认
  //   revised —— 该口令发生过撤回修订
  //   paused  —— 任一轮次发生过暂停
  //   substituted —— 任一轮次发生过替岗
  function cueMatchesResult(cue, result) {
    if (!result || result === 'all') return true;
    const t = cue.totals;
    switch (result) {
      case 'ok': return t.finalResult === 'ok';
      case 'late': return t.finalLate > 0; // 最终轮次存在迟到确认（含先超时后迟到）
      case 'timeout': return t.finalResult === 'timeout'; // 最终轮次结束时仍超时未确认
      case 'revised': return t.revisions > 0;
      case 'paused': return t.hasPause;
      case 'substituted': return t.hasSubstitution;
      default: return true;
    }
  }

  return {
    STATUS_CONFIRMED,
    STATUS_LATE,
    STATUS_TIMEOUT,
    STATUS_PENDING,
    overlapMs,
    activeWaitMs,
    segmentsBetween,
    analyzeSession,
    effectiveAt,
    rowMatchesPosition,
    cueMatchesResult,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CueLatency };
}
