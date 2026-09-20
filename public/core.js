/* ===========================================================================
 * 只读复盘共享内核（纯函数）：Node.js（replay.js / compare.js / archive.js）
 * 与浏览器（replay.js / latency.js）共用同一份「场次 / 口令 / 轮次」模型。
 *
 * 唯一事实来源是日志行序：内核只按输入数组的先后顺序逐行折叠，绝不按时间戳
 * 重排。同一毫秒内的因果事件（如 cue-recalled 必然先于 cue-resent 落盘）
 * 因此天然得到确定结果；任意时刻的重放都通过同一状态机从场次起点重新折叠。
 *
 * 内核统一处理：修订（撤回 + 重发）、暂停 / 恢复、临时替岗、确认超时与
 * 迟到确认、旧轮次（旧 attemptId）消息归属。消费者（复盘页面、场次对比、
 * 延迟诊断）只负责从折叠结果中筛选与展示，不再各自实现状态转移。
 *
 * 纯函数保证：无 fs / DOM / WebSocket / 时钟 / 随机数等任何环境依赖，
 * 不修改输入事件，重复折叠同一输入必得同一结果。
 *
 * 健壮性口径（与既有复盘一致）：逐行解析时任何一行损坏（非法 JSON /
 * 缺字段等）只产生一条告警并跳过该行，其余行照常解析。折叠阶段遇到
 * 结构异常的 detail 一律按缺省值容忍，绝不抛错中断。
 * ===========================================================================
 */
'use strict';

const CueCore = (() => {
  const DEFAULT_TIMEOUT_SEC = 30;
  const MAX_RAW_WARNING = 200; // 告警中保留的坏行原文长度
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function isValidFileId(fileId) {
    return typeof fileId === 'string' && UUID_RE.test(fileId);
  }

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function intPos(v) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  function cleanTargets(raw) {
    return Array.isArray(raw)
      ? [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))]
      : [];
  }

  // 事件涉及的岗位：与各消费端保持同一套提取口径
  // （position / from / to / targets / missing 等字段都可能携带岗位名）
  function eventPositions(event) {
    const d = (event && event.detail) || {};
    const positions = new Set();
    const addOne = (v) => { const p = String(v == null ? '' : v).trim(); if (p) positions.add(p); };
    if (d.position) addOne(d.position);
    if (d.from) addOne(d.from);
    if (d.to) addOne(d.to);
    if (Array.isArray(d.targets)) d.targets.forEach(addOne);
    if (Array.isArray(d.missing)) d.missing.forEach(addOne);
    return [...positions];
  }

  // -------------------------------------------------------------------------
  // 逐行解析 JSONL 文本（纯字符串输入；Node 侧负责读文件，浏览器侧可直接
  // 粘贴文本，故不依赖 fs）。
  // 返回 { events, warnings }：
  //   events   —— 成功解析的记录，保持文件中的先后顺序（因果顺序，绝不按时间戳重排）
  //               { line, ts(毫秒), iso(原文), event, detail }
  //   warnings —— 损坏记录告警 [{ line, reason, raw }]
  // 空白行（文件末尾换行等）静默跳过，不属于损坏记录。
  // -------------------------------------------------------------------------
  function parseLogText(text) {
    const events = [];
    const warnings = [];
    const lines = String(text == null ? '' : text).split('\n');

    lines.forEach((rawLine, idx) => {
      const line = idx + 1;
      const trimmed = rawLine.trim();
      if (trimmed === '') return;

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (err) {
        warnings.push({ line, reason: `JSON 解析失败：${err.message}`, raw: trimmed.slice(0, MAX_RAW_WARNING) });
        return;
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        warnings.push({ line, reason: '记录不是 JSON 对象', raw: trimmed.slice(0, MAX_RAW_WARNING) });
        return;
      }
      const ts = Date.parse(obj.ts);
      if (!Number.isFinite(ts)) {
        warnings.push({ line, reason: '缺少合法的 ts 时间戳', raw: trimmed.slice(0, MAX_RAW_WARNING) });
        return;
      }
      if (typeof obj.event !== 'string' || obj.event === '') {
        warnings.push({ line, reason: '缺少合法的 event 字段', raw: trimmed.slice(0, MAX_RAW_WARNING) });
        return;
      }
      let detail = {};
      if (obj.detail !== undefined && obj.detail !== null) {
        if (typeof obj.detail !== 'object' || Array.isArray(obj.detail)) {
          warnings.push({ line, reason: 'detail 字段不是对象', raw: trimmed.slice(0, MAX_RAW_WARNING) });
          return;
        }
        detail = obj.detail;
      }
      events.push({ line, ts, iso: obj.ts, event: obj.event, detail });
    });

    return { events, warnings };
  }

  // -------------------------------------------------------------------------
  // 把逐行事件切分为「已结束场次」（运行段）：
  //   - session-start 开启一段运行，sequence-finished 闭合；只有闭合的段才算已结束场次
  //   - session-start 后未等到 sequence-finished 就遇到 session-reset / 下一次
  //     session-start（异常中断 / 重置）的段是未完成运行，不列入复盘
  //   - 段内遇到 cue-started 时按 seq 登记口令（同一 seq 的修订重发不新增口令），
  //     口令以首次 cue-started 的文本/目标为该场冻结快照（修订后的文本只反映在事件流中）
  //   - timeoutSec 取本场开始前最近一次 sequence-set / draft-published 携带的确认时限
  // 纯函数：仅遍历给定事件数组，不读文件。
  // -------------------------------------------------------------------------
  function segmentEvents(events) {
    const runs = [];
    let current = null;
    let lastTimeoutSec = DEFAULT_TIMEOUT_SEC;

    for (const e of events) {
      if (e.event === 'sequence-set' || e.event === 'draft-published') {
        const t = Number(e.detail && e.detail.timeoutSec);
        if (Number.isFinite(t) && t > 0) lastTimeoutSec = t;
      }

      if (e.event === 'session-start') {
        current = { start: e, finish: null, events: [e], timeoutSec: lastTimeoutSec, cues: new Map() };
        continue;
      }
      if (!current) continue;

      current.events.push(e);

      if (e.event === 'cue-started') {
        const seq = intPos(e.detail && e.detail.seq);
        if (seq && !current.cues.has(seq)) {
          const text = String((e.detail && e.detail.text) || '').trim();
          current.cues.set(seq, { seq, text, targets: cleanTargets(e.detail && e.detail.targets) });
        }
      } else if (e.event === 'sequence-finished') {
        current.finish = e;
        runs.push(current);
        current = null;
      } else if (e.event === 'session-reset') {
        // 闭合后的清理重置不属于本场；若发生在闭合前则表示运行被重置中断（未完成场次）
        current = null;
      }
    }
    return runs;
  }

  // -------------------------------------------------------------------------
  // 场次 / 口令 / 轮次状态机（fold）
  //
  // fold 结果同时暴露两层视图，二者由同一条事件折叠路径产生：
  //   1) 实时现场（live fields：seq / text / targets / revision / reason /
  //      attemptId / confirmations / timedOut / substitutions / paused / ...）
  //      —— 复盘页面逐帧渲染所需，语义与 server.js 实时状态机一致；
  //   2) 轮次模型（cues / rounds / roundsByAttempt / orphanStale）
  //      —— 每个 cue-started / cue-resent 开启一轮，按 attemptId 归档
  //      确认、超时、暂停、替岗与旧轮次拒绝；场次对比与延迟诊断只读取它。
  // -------------------------------------------------------------------------

  // 实时现场初值（复盘折叠起点；字段口径沿用既有 public/replay.js）
  function initialState() {
    return {
      phase: 'idle', // idle（未开始） | active（口令进行中） | between（口令已完成待推进） | done（全场结束）
      results: {}, // seq -> 'active' | 'completed'
      seq: null,
      text: '',
      originalText: '',
      targets: [],
      revision: 1,
      reason: null,
      attemptId: null,
      confirmations: {}, // 岗位 -> { late }（当前轮次实时现场）
      timedOut: [],
      substitutions: {}, // 原岗位 -> { substitute }（当前轮次实时现场）
      paused: false,
      pauseReason: null,
      attempts: [], // 当前口令已封存的只读历史轮次（撤回/完成）
      roundStartIso: null, // 当前轮次开始时刻（封存历史轮次时展示）

      // —— 轮次模型（消费者只读；不参与实时现场的 JSON 比较也不影响页面）——
      cues: [], // 按首次出现行序的冻结口令
      _cueBySeq: {}, // seq -> cue
      rounds: [], // 全部轮次（按事件行序开启）
      _roundsByAttempt: new Map(), // attemptId -> round
      _roundsBySeq: {}, // seq -> [round...]（缺 attemptId 的合成日志兜底归属）
      orphanStale: [], // 无法归属任何已知轮次的旧轮次拒绝事件
      timeoutSec: DEFAULT_TIMEOUT_SEC,
    };
  }

  function ensureCue(s, seq, detail) {
    let cue = s._cueBySeq[seq];
    if (!cue) {
      cue = {
        seq,
        text: String((detail && detail.text) || '').trim(),
        targets: cleanTargets(detail && detail.targets),
        revisions: 0,
        recallReasons: [],
        rounds: [],
      };
      s._cueBySeq[seq] = cue;
      s.cues.push(cue);
    } else if (!cue.text) {
      // 合成/损坏日志的兜底：首次见到 cue 时 detail 可能缺文本/目标
      cue.text = String((detail && detail.text) || '').trim();
      cue.targets = cleanTargets(detail && detail.targets);
    }
    return cue;
  }

  // 封存当前轮次为只读历史时的实时现场快照（结构沿用复盘页面 renderAttempts 契约）
  function snapshotRound(s, round, endState, reason, ev) {
    return {
      endState,
      revision: s.revision,
      reason: reason || null,
      text: s.text,
      startedAt: s.roundStartIso || null,
      endedAt: ev ? ev.ts : null,
      confirmations: JSON.parse(JSON.stringify(s.confirmations)),
      timedOut: [...s.timedOut],
      substitutions: JSON.parse(JSON.stringify(s.substitutions)),
      // 单向指向轮次模型中的同一轮（延迟诊断等消费者从这里取完整轮次；
      // 轮对象不反向引用快照，故整个状态仍可 JSON 序列化）
      round,
    };
  }

  // 开启一轮（cue-started 第 1 轮 / cue-resent 修订轮）。
  // 轮次对象字段即延迟诊断 analyzeSession 重建的 Round 模型，两者现在同源。
  function openRound(s, ev, seq, detail) {
    const cue = ensureCue(s, seq, detail);
    // 开启新轮前，收口同口令仍标记为 live 的上一轮。正常日志中它已由
    // cue-recalled / cue-completed 封存；此处兜底处理缺封存事件的损坏日志，
    // 保证任何时刻至多一个 live 轮，且旧轮不会再被镜像到实时现场。
    for (const prev of cue.rounds) {
      if (!prev.live) continue;
      prev.live = false;
      if (!prev.endState) {
        // 缺封存事件却已开新轮（损坏日志）：按「被修订取代」同口径收口
        prev.endState = 'recalled';
        prev.endEvent = 'cue-resent';
        prev.endLine = ev.line;
        prev.endT = ev.t;
        prev.endIso = ev.ts;
      }
    }
    const revision = (() => {
      const r = Number(detail && detail.revision);
      if (Number.isInteger(r) && r > 0) return r;
      return cue.rounds.length ? cue.rounds[cue.rounds.length - 1].revision + 1 : 1;
    })();
    const attemptId = detail && detail.attemptId != null && detail.attemptId !== ''
      ? String(detail.attemptId) : null;
    const dText = String((detail && detail.text) || '');
    const round = {
      attemptId: attemptId || null,
      revision,
      seq,
      text: dText !== '' ? dText : cue.text,
      reason: (detail && detail.reason) || null,
      startEvent: ev.event,
      startLine: ev.line,
      startT: ev.t,
      startIso: ev.ts,
      endState: null, // completed | recalled
      endEvent: null,
      endLine: null,
      endT: null,
      endIso: null,
      budgetMs: s.timeoutSec * 1000,
      deadlineT: null,
      cueSeq: cue.seq,
      targets: [...cue.targets], // 冻结目标（修订不改目标；下一条口令仍用编排原目标）
      pauses: [], // {startT,endT,reason,startLine,endLine,startIso}
      substitutions: [], // {from,to,t,line}
      timeoutEvent: null, // {t,line,missing}
      confirms: [], // {position,late,t,line,duplicateEvents:[{t,line}]}
      rejectedPauses: [], // {position,t,line}
      stale: [], // 归属到本轮的旧轮次拒绝 {kind,t,line,position,sentAttemptId}
      live: true, // 是否为当前实时现场（被封存 / 新轮开启后置 false）
    };
    cue.rounds.push(round);
    cue.revisions = Math.max(cue.revisions, revision);
    if (revision > 1 && round.reason && !cue.recallReasons.includes(round.reason)) {
      cue.recallReasons.push(round.reason);
    }
    if (attemptId) s._roundsByAttempt.set(attemptId, round);
    if (!s._roundsBySeq[seq]) s._roundsBySeq[seq] = [];
    s._roundsBySeq[seq].push(round);
    s.rounds.push(round);
    return round;
  }

  // 旧轮次封存（撤回/完成）：实时现场压入只读历史、轮次退出 live，模型同步收口
  function pushAttempt(s, round, endState, reason, ev) {
    round.live = false;
    s.attempts.push(snapshotRound(s, round, endState, reason, ev));
  }

  // 清空本轮实时现场（修订重发时；确认/超时/替岗/暂停绝不带入新轮次）
  function resetLiveRound(s) {
    s.confirmations = {};
    s.timedOut = [];
    s.substitutions = {};
    s.paused = false;
    s.pauseReason = null;
  }

  // 按 attemptId 精确归属；缺失 / 找不到 attemptId 时退回该 seq 的最新轮次
  // （真实日志中轮次事件均携带 attemptId，退回仅为合成 / 损坏日志的健壮兜底）
  function roundOf(s, d) {
    if (d && d.attemptId != null && d.attemptId !== '') {
      const r = s._roundsByAttempt.get(String(d.attemptId));
      if (r) return r;
    }
    const seq = intPos(d && d.seq);
    const list = seq ? s._roundsBySeq[seq] : null;
    return list && list.length ? list[list.length - 1] : null;
  }

  function findConfirm(round, position) {
    return round.confirms.find((c) => c.position === position);
  }

  // 实时现场是否就是该轮：只有当前进行中口令的当前轮次才同步镜像字段
  function isLiveRound(s, round) {
    return !!round && round.live && round.seq === s.seq && round.attemptId === s.attemptId;
  }

  function foldEvent(s, ev) {
    const d = ev.detail || {};
    switch (ev.event) {
      case 'session-start':
        s.phase = 'active';
        break;

      case 'cue-started': {
        const seq = intPos(d.seq);
        if (!seq) break; // 损坏/缺字段事件：跳过且不改变现场
        const round = openRound(s, ev, seq, d);
        // 实时现场：新口令（下一条）封存历史轮次不再展示；修订轮由 cue-resent 衔接
        const firstForCue = round.revision === 1;
        s.phase = 'active';
        s.seq = seq;
        s.targets = Array.isArray(d.targets) ? d.targets.map(String) : [];
        s.text = String(d.text || '');
        if (firstForCue) {
          s.originalText = s.text;
          s.attempts = [];
        }
        s.revision = round.revision;
        s.reason = round.reason;
        s.attemptId = round.attemptId;
        resetLiveRound(s);
        s.roundStartIso = ev.ts;
        s.results[seq] = 'active';
        break;
      }

      // 撤回：先按旧轮次现场封存只读历史（在 cue-resent 清空本轮状态之前）
      case 'cue-recalled': {
        const r = roundOf(s, d);
        if (r && !r.endState) {
          r.endState = 'recalled';
          r.endEvent = 'cue-recalled';
          r.endLine = ev.line;
          r.endT = ev.t;
          r.endIso = ev.ts;
          if (d.reason) r.reason = String(d.reason);
          if (isLiveRound(s, r)) {
            // 已封存：紧随其后的 cue-resent 将开启新的 live 轮
            pushAttempt(s, r, 'recalled', r.reason, ev);
          }
        }
        break;
      }

      // 修订版重发：同序号递增修订号、替换文本、清空本轮状态重新确认。
      // 同一毫秒内 cue-recalled 必然先于 cue-resent 落盘（日志行序即因果序）。
      case 'cue-resent': {
        const seq = intPos(d.seq);
        if (!seq) break;
        const existing = s._cueBySeq[seq];
        if (!existing || existing.rounds.length === 0) {
          // 修订事件缺少对应的 cue-started（损坏日志）：不开轮、不改现场，
          // 绝不凭空补出一个第 1 轮
          break;
        }
        const round = openRound(s, ev, seq, d);
        s.revision = round.revision;
        s.text = d.text != null && d.text !== '' ? String(d.text) : s.text;
        if (d.reason) s.reason = String(d.reason);
        s.attemptId = round.attemptId;
        resetLiveRound(s);
        s.roundStartIso = ev.ts;
        break;
      }

      case 'cue-completed': {
        const r = roundOf(s, d);
        if (r && !r.endState) {
          r.endState = 'completed';
          r.endEvent = 'cue-completed';
          r.endLine = ev.line;
          r.endT = ev.t;
          r.endIso = ev.ts;
          if (isLiveRound(s, r)) {
            // 已封存：后续迟到事件不再镜像到实时现场
            pushAttempt(s, r, 'completed', null, ev);
            if (s.seq != null) s.results[s.seq] = 'completed';
            s.phase = 'between';
          }
        }
        break;
      }

      case 'confirm': {
        const r = roundOf(s, d);
        if (r && d.position) {
          const position = String(d.position);
          if (!findConfirm(r, position)) {
            r.confirms.push({ position, late: false, t: ev.t, line: ev.line, duplicateEvents: [] });
          }
          if (isLiveRound(s, r) && !s.confirmations[position]) {
            s.confirmations[position] = { late: false };
          }
        }
        break;
      }

      case 'confirm-late': {
        const r = roundOf(s, d);
        if (r && d.position) {
          const position = String(d.position);
          let c = findConfirm(r, position);
          if (!c) {
            c = { position, late: true, t: ev.t, line: ev.line, duplicateEvents: [] };
            r.confirms.push(c);
          }
          c.late = true;
          if (isLiveRound(s, r)) {
            s.confirmations[position] = { late: true };
            s.timedOut = s.timedOut.filter((x) => x !== position);
          }
        }
        break;
      }

      case 'confirm-duplicate': {
        const r = roundOf(s, d);
        if (r && d.position) {
          const position = String(d.position);
          let c = findConfirm(r, position);
          if (!c) {
            // 极端情况下首条确认日志缺失：重复确认仍证明该岗位已确认
            c = { position, late: false, t: ev.t, line: ev.line, duplicateEvents: [] };
            r.confirms.push(c);
          }
          c.duplicateEvents.push({ t: ev.t, line: ev.line });
          if (isLiveRound(s, r) && !s.confirmations[position]) {
            s.confirmations[position] = { late: !!c.late };
          }
        }
        break;
      }

      case 'cue-timeout': {
        // 与服务端一致：超时表只在首次定时器到期写入，不覆盖后续确认结果
        const r = roundOf(s, d);
        if (r) {
          if (!r.timeoutEvent) {
            r.timeoutEvent = {
              t: ev.t, line: ev.line,
              missing: Array.isArray(d.missing) ? d.missing.map(String) : [],
            };
          }
          if (isLiveRound(s, r) && s.timedOut.length === 0 && Array.isArray(d.missing)) {
            s.timedOut = [...d.missing.map(String)];
          }
        }
        break;
      }

      case 'position-substituted': {
        const r = roundOf(s, d);
        const from = String(d.from || '');
        const to = String(d.to || '');
        if (r && from && to) {
          r.substitutions.push({ from, to, t: ev.t, line: ev.line });
          if (isLiveRound(s, r) && !s.substitutions[from]) {
            s.substitutions[from] = { substitute: to };
            // 超时未确认标记随确认权一起移交给替补
            s.timedOut = s.timedOut.map((x) => (x === from ? to : x));
          }
        }
        break;
      }

      case 'cue-paused': {
        const r = roundOf(s, d);
        if (r) {
          r.pauses.push({
            startT: ev.t, endT: null, reason: String(d.reason || ''),
            startLine: ev.line, endLine: null, startIso: ev.ts,
          });
          if (isLiveRound(s, r)) {
            s.paused = true;
            s.pauseReason = d.reason || '';
          }
        }
        break;
      }

      case 'cue-resumed': {
        const r = roundOf(s, d);
        if (r) {
          const open = [...r.pauses].reverse().find((p) => p.endT == null);
          if (open) {
            open.endT = ev.t;
            open.endLine = ev.line;
          } else {
            // 没有对应暂停事件（日志损坏 / 合成兜底）：记零长区间，不产生负时长。
            // synthetic 标记供场次对比区分「真实 cue-paused 次数」；
            // 延迟诊断仍把它作为零长暂停参与展示与汇总（与既有口径一致）。
            r.pauses.push({
              startT: ev.t, endT: ev.t, reason: '', synthetic: true,
              startLine: ev.line, endLine: ev.line, startIso: ev.ts,
            });
          }
          if (isLiveRound(s, r)) {
            s.paused = false;
            s.pauseReason = null;
          }
        }
        break;
      }

      case 'paused-confirm-rejected': {
        const r = roundOf(s, d);
        if (r && d.position) {
          r.rejectedPauses.push({ position: String(d.position), t: ev.t, line: ev.line });
        }
        // 暂停中确认被拒不改变实时现场
        break;
      }

      case 'stale-confirm-ignored': {
        // 迟到到达的旧轮次确认：仅按其携带的旧 attemptId 归属原轮次；
        // 不带 attemptId（sentAttemptId 为空）时无法识别原轮次，归为孤立事件，
        // 绝不计入当前轮次（否则会把拒绝标记错误地贴到修订轮上）
        const oldId = d.sentAttemptId != null && d.sentAttemptId !== '' ? String(d.sentAttemptId) : null;
        const r = oldId ? s._roundsByAttempt.get(oldId) : null;
        const item = {
          kind: 'stale-confirm', t: ev.t, line: ev.line,
          position: d.position ? String(d.position) : null,
          sentAttemptId: oldId,
        };
        if (r) r.stale.push(item); else s.orphanStale.push(item);
        break;
      }

      case 'stale-substitute-ignored': {
        const oldId = d.sentAttemptId != null && d.sentAttemptId !== '' ? String(d.sentAttemptId) : null;
        const r = oldId ? s._roundsByAttempt.get(oldId) : null;
        const item = {
          kind: 'stale-substitute', t: ev.t, line: ev.line,
          position: d.to ? String(d.to) : null,
          sentAttemptId: oldId,
        };
        if (r) r.stale.push(item); else s.orphanStale.push(item);
        break;
      }

      case 'stale-timeout-ignored': {
        // 旧定时器回调被拒：携带 staleAttemptId（如召回旧轮的定时器），
        // 或仅有 currentAttemptId=null（整场结束后的迟到回调）
        const oldId = d.staleAttemptId != null && d.staleAttemptId !== '' ? String(d.staleAttemptId) : null;
        const r = (oldId && s._roundsByAttempt.get(oldId)) || (intPos(d.seq) ? roundOf(s, d) : null);
        const item = {
          kind: 'stale-timeout', t: ev.t, line: ev.line, position: null, sentAttemptId: oldId,
        };
        if (r) r.stale.push(item); else s.orphanStale.push(item);
        break;
      }

      // 重复确认之外的租约、草稿、上下线等事件只存在于事件流/时间轴上，
      // 不改变场次 / 口令 / 轮次模型。
      case 'sequence-finished':
        s.phase = 'done';
        s.paused = false;
        s.pauseReason = null;
        s.confirmations = {};
        s.timedOut = [];
        s.substitutions = {};
        break;

      default:
        break;
    }
    return s;
  }

  // 统一的事件时刻 / ISO 取值：兼容内核解析事件（ts=毫秒, iso）与
  // GET 单场接口事件（ts=ISO 字符串, t=相对毫秒）两种形态。
  // 已携带相对偏移 t 的事件直接采用（API 返回的 t 即唯一时间基准），
  // 避免把首事件（t=0）误算成 NaN。
  function eventT(ev, baseTs) {
    if (typeof ev.t === 'number' && Number.isFinite(ev.t)) return ev.t;
    const ts = typeof ev.ts === 'number' ? ev.ts : Date.parse(ev.ts);
    return Number.isFinite(ts) ? ts - baseTs : 0;
  }

  function eventIso(ev) {
    return typeof ev.iso === 'string' ? ev.iso : ev.ts;
  }

  // 把事件规范为折叠器输入：{ line, t=相对毫秒, ts=ISO 原文, iso, event, detail }
  // （折叠器内统一按 ev.t 读取相对时刻、ev.ts 读取 ISO 原文）
  function normalizeEvent(ev0, baseTs) {
    const iso = eventIso(ev0);
    return {
      line: ev0.line,
      t: eventT(ev0, baseTs),
      ts: iso,
      iso,
      event: ev0.event,
      detail: ev0.detail || {},
    };
  }

  // 从场次起点折叠全部事件（或指定区间事件），返回最终状态。
  // events 必须已按日志行序排列；startTs 为场次起点毫秒（默认取首事件时刻）。
  function foldEvents(events, opts = {}) {
    const list = Array.isArray(events) ? events : [];
    const startTs = Number.isFinite(opts.startTs)
      ? opts.startTs
      : (list.length ? (typeof list[0].ts === 'number' ? list[0].ts : Date.parse(list[0].ts)) : 0);
    const s = initialState();
    s.timeoutSec = Number(opts.timeoutSec) > 0 ? Number(opts.timeoutSec) : DEFAULT_TIMEOUT_SEC;
    for (const ev0 of list) {
      foldEvent(s, normalizeEvent(ev0, Number.isFinite(startTs) ? startTs : 0));
    }
    return s;
  }

  // 确定性重放：从场次起点逐事件应用所有偏移 <= targetT 的事件。
  // events 已按日志行序排列（服务端保证追加顺序），同一毫秒内 cue-recalled
  // 也必然先于 cue-resent 落盘，因此折叠结果与顺序播放逐帧到达时完全相同。
  function foldUntil(events, targetT, opts = {}) {
    const list = Array.isArray(events) ? events : [];
    const startTs = Number.isFinite(opts.startTs)
      ? opts.startTs
      : (list.length ? (typeof list[0].ts === 'number' ? list[0].ts : Date.parse(list[0].ts)) : 0);
    const s = initialState();
    s.timeoutSec = Number(opts.timeoutSec) > 0 ? Number(opts.timeoutSec) : DEFAULT_TIMEOUT_SEC;
    for (const ev0 of list) {
      const ev = normalizeEvent(ev0, Number.isFinite(startTs) ? startTs : 0);
      if (ev.t > targetT) break;
      foldEvent(s, ev);
    }
    return s;
  }

  // -------------------------------------------------------------------------
  // 收口：闭合场次结束后仍未封存的轮次与未闭合暂停（损坏 / 中断日志兜底）。
  // 延迟诊断在生成瀑布数据前调用；纯函数（原地补全模型并返回同一状态）。
  // -------------------------------------------------------------------------
  function finalizeModel(s) {
    for (const round of s.rounds) {
      if (!round.endState) {
        // 防御：闭合场次的最后一轮必有 cue-completed；若日志损坏缺失封存事件，
        // 以轮次起点收口（与既有延迟诊断的兜底一致）
        round.endState = 'completed';
        round.endEvent = round.startEvent;
        round.endLine = round.startLine;
        round.endT = round.startT;
        round.endIso = round.startIso;
      }
      round.pauses.forEach((p) => {
        if (p.endT == null) {
          // 未闭合暂停（日志损坏 / 轮次被重置中断）：以轮次收口时刻截断，不产生负时长
          p.endT = round.endT != null ? Math.max(p.startT, round.endT) : p.startT;
          p.unclosed = true;
        }
      });
      round.pausedTotalMs = round.pauses.reduce((sum, p) => sum + Math.max(0, p.endT - p.startT), 0);
      // 有效截止时刻 = 初始时限 + 累计暂停时长（恢复时按冻结余量重排 deadline 的等价结果）
      round.deadlineT = round.startT + round.budgetMs + round.pausedTotalMs;
    }
    return s;
  }

  // 当前口令有效目标（被替岗的原岗位由替补顶替）——复盘实时现场视图
  function effectiveTargets(s) {
    return s.targets.map((t) => (s.substitutions[t] ? s.substitutions[t].substitute : t));
  }

  // 折叠状态 → 可渲染视图（岗位状态分组）
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

  return {
    DEFAULT_TIMEOUT_SEC,
    MAX_RAW_WARNING,
    isValidFileId,
    num,
    intPos,
    cleanTargets,
    eventPositions,
    parseLogText,
    segmentEvents,
    initialState,
    foldEvent,
    foldEvents,
    foldUntil,
    finalizeModel,
    effectiveTargets,
    viewOf,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CueCore };
}
