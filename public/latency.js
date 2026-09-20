/* 确认延迟诊断前端（只读）：基于复盘 GET 接口返回的单场事件流，
 * 用与复盘 / 场次对比共用的纯函数内核（public/core.js 的 CueCore）折叠出
 * 每个口令的每一次确认轮次（含撤回修订轮次），再从轮次模型生成各目标岗位
 * 的确认瀑布数据——从等待时长中扣除暂停区间。
 *
 * 只读保证（与复盘 / 对比 / 归档一致）：
 *   - 本文件是纯函数分析器，不创建 WebSocket、不调用任何写接口；
 *     场次数据由页面经 /api/replay/sessions 与 /api/replay/sessions/:fileId/:runId
 *     两个既有只读 GET 接口拉取（复用演出复盘接口，不新增服务端接口）；
 *   - 所有结论只由日志行序上的事件重建，绝不引用当前演出状态。
 *
 * 重建口径（内核统一实现，与 server.js 实时状态机、复盘 foldUntil 完全一致）：
 *   - cue-started 开启第 1 轮（attemptId 取事件详情中的值）；cue-resent 开启
 *     修订轮次（同 seq、revision 递增、新 attemptId）；cue-recalled 封存上一轮为
 *     recalled，cue-completed 封存为 completed；
 *   - position-substituted 之后，确认计入接管岗位（替补），超时标记随之移交；
 *   - confirm-late 同时保留「超时」与「迟到」两个标记；
 *   - cue-paused/cue-resumed 为闭合暂停区间（同一 attemptId），计算等待时长时
 *     按与 [轮次开始, 观察时刻] 的交集整体扣除，重复暂停 / 恢复不累计误差。
 *
 * 本文件只保留「轮次模型 → 瀑布行 / 汇总 / 筛选」的投影逻辑，
 * 不再自行实现任何状态转移。
 */
'use strict';

// Node（require）环境下共享内核经 module 装配；浏览器中由 <script src="core.js">
// 提供同名全局。两种环境共用同一份文件，无任何环境相关分支逻辑。
const CueCore = typeof globalThis !== 'undefined' && globalThis.CueCore
  ? globalThis.CueCore
  : require('./core').CueCore;

const CueLatency = (() => {
  const C = CueCore; // 复盘 / 对比 / 延迟诊断共用的折叠内核

  const STATUS_CONFIRMED = 'confirmed';
  const STATUS_LATE = 'late';
  const STATUS_TIMEOUT = 'timeout'; // 轮次结束时仍超时未确认
  const STATUS_PENDING = 'pending'; // 撤回时未确认（轮次尚未走到超时）

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
  // 状态折叠与收口（轮次开合、修订、暂停闭合、旧 attemptId 归属、损坏兜底）
  // 全部由共享内核完成；输出结构保持页面既有契约：
  //   { session, timeoutSec, positions, summary, cues: [
  //       { seq, text, targets, revisions, recallReasons,
  //         rounds: [Round], totals: {...Cue 级汇总} } ],
  //     orphanStale: [...] } 不属于任何可识别轮次的旧轮次拒绝事件
  //
  // Round（内核模型字段 + 本模块投影出的 rows/axisMax/stats）：
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
      ? Number(sessionData.timeoutSec) : C.DEFAULT_TIMEOUT_SEC;
    const events = Array.isArray(sessionData && sessionData.events) ? sessionData.events : [];

    // 同一状态机：复盘逐帧渲染与场次对比也是从这份折叠结果取数
    const model = C.foldEvents(events, { timeoutSec });
    // 收口：未封存轮次按完成兜底、未闭合暂停以轮次收口截断、顺延截止时刻
    C.finalizeModel(model);

    const roundOrder = model.rounds;

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

    const cues = [...model.cues].sort((a, b) => a.seq - b.seq);
    cues.forEach((cue) => buildCueTotals(cue));

    const summary = buildSummary(cues, roundOrder, model.orphanStale);

    return {
      session: sessionData.session || null,
      timeoutSec,
      positions,
      cues,
      rounds: roundOrder,
      orphanStale: model.orphanStale,
      summary,
    };
  }

  // 某轮在 t 时刻的有效目标：被替岗的原岗位由替补顶替（与服务端口径一致）
  function effectiveAt(round, t) {
    return round.targets.map((origin) => {
      const sub = round.substitutions
        .filter((s) => s.from === origin && s.t <= t)
        .pop();
      return sub ? sub.to : origin;
    });
  }

  function finalizeRound(round, positions, addPos) {
    // 未闭合暂停的截断、pausedTotalMs 与 deadlineT 的顺延均已由内核收口完成
    const timeoutMissing = round.timeoutEvent ? round.timeoutEvent.missing : [];
    const timeoutT = round.timeoutEvent ? round.timeoutEvent.t : null;

    round.rows = round.targets.map((origin) => {
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

  // [fromT,toT] 内的暂停总时长（仅统计已闭合区间；内核已保证全部闭合）
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
