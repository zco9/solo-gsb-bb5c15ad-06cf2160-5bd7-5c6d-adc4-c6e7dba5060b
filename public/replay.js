/* 演出复盘前端：只读回放已结束场次。
 *
 * 确定性重放模型：任何时刻的状态都不是播放过程中增量累积的，而是每次渲染都
 * 用 foldUntil(events, targetT) 从本场起点（session-start）按事件先后逐事件
 * 折叠到目标时刻得到。因此「拖动 / 点击跳转 / 正常顺序播放」到达同一时刻时，
 * 当前口令、确认 / 超时、替岗、修订及暂停状态必然完全一致。
 *
 * 只读：本文件只发起 GET 请求拉取历史日志，没有 WebSocket、没有任何写操作，
 * 不可能影响当前演出状态或事件日志。
 */
'use strict';

const Replay = (() => {
  const DEFAULT_TIMEOUT_SEC = 30;

  const EVENT_LABELS = {
    'sequence-set': '序列已保存',
    'session-start': '演出开始',
    'cue-started': '发出口令',
    'cue-completed': '口令完成',
    'cue-timeout': '确认超时',
    'cue-recalled': '撤回并纠正重发',
    'cue-resent': '修订版重新发出',
    'cue-paused': '口令暂停',
    'cue-resumed': '口令恢复',
    'paused-confirm-rejected': '暂停中确认被拒',
    'stale-confirm-ignored': '旧轮次确认被拒',
    'stale-timeout-ignored': '旧轮次定时器被拒',
    'stale-substitute-ignored': '旧轮次替岗被拒',
    'confirm': '岗位确认',
    'confirm-late': '迟到确认',
    'confirm-duplicate': '重复确认',
    'position-substituted': '临时替岗',
    'lease-acquired': '指挥权租约授予',
    'lease-acquire-denied': '租约申请被拒',
    'lease-released': '指挥权释放',
    'lease-expired': '租约超期自动释放',
    'lease-op-denied': '越权操作被拒',
    'stale-lease-heartbeat-ignored': '旧租约心跳被拒',
    'sequence-finished': '全部口令完成',
    'session-reset': '场次重置',
    'draft-created': '下一场草稿已创建',
    'draft-saved': '下一场草稿已保存',
    'draft-save-conflict': '草稿保存冲突被拒',
    'draft-published': '草稿已发布为下一场序列',
    'draft-discarded': '草稿已放弃',
    'position-online': '岗位上线',
    'position-offline': '岗位离线',
  };

  // 事件分类：用于类型筛选下拉与时间轴标记配色
  const CATEGORIES = [
    { name: '口令 / 场次', events: ['session-start', 'cue-started', 'cue-completed', 'sequence-finished'] },
    { name: '修订重发', events: ['cue-recalled', 'cue-resent'] },
    { name: '岗位确认', events: ['confirm', 'confirm-late', 'confirm-duplicate'] },
    { name: '超时', events: ['cue-timeout', 'stale-timeout-ignored'] },
    { name: '暂停 / 恢复', events: ['cue-paused', 'cue-resumed', 'paused-confirm-rejected'] },
    { name: '替岗', events: ['position-substituted', 'stale-substitute-ignored'] },
    { name: '旧轮次拒绝', events: ['stale-confirm-ignored'] },
    { name: '重置 / 序列', events: ['sequence-set', 'session-reset'] },
    { name: '草稿', events: ['draft-created', 'draft-saved', 'draft-save-conflict', 'draft-published', 'draft-discarded'] },
    { name: '指挥权租约', events: ['lease-acquired', 'lease-acquire-denied', 'lease-released', 'lease-expired', 'lease-op-denied', 'stale-lease-heartbeat-ignored'] },
    { name: '岗位上下线', events: ['position-online', 'position-offline'] },
  ];
  const CATEGORY_OF = {};
  CATEGORIES.forEach((c) => c.events.forEach((e) => { CATEGORY_OF[e] = c.name; }));

  function eventLabel(name) { return EVENT_LABELS[name] || name; }
  function categoryOf(name) { return CATEGORY_OF[name] || '其他'; }

  // -------------------------------------------------------------------------
  // 确定性折叠（reducer）：从本场起点开始逐事件应用，纯函数、无副作用。
  // 播放到某时刻 = fold 全部 t <= targetT 的事件；跳转后重放也是同一条路径，
  // 只是 targetT 不同，因此同一目标时刻的状态与顺序播放严格一致。
  // -------------------------------------------------------------------------
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
      confirmations: {}, // 岗位 -> { late }
      timedOut: [],
      substitutions: {}, // 原岗位 -> { substitute }
      paused: false,
      pauseReason: null,
      attempts: [], // 当前口令已封存的只读历史轮次（撤回/完成）
      roundStartIso: null, // 当前轮次开始时刻（封存历史轮次时展示）
    };
  }

  function snapshotRound(s, endState, reason, ev) {
    return {
      endState,
      revision: s.revision,
      reason: reason || null,
      text: s.text,
      // renderAttempts 展示封存轮次起止时间：起点为当前轮次开始时刻，终点为本事件时刻
      startedAt: s.roundStartIso || null,
      endedAt: ev ? ev.ts : null,
      confirmations: structuredClone(s.confirmations),
      timedOut: [...s.timedOut],
      substitutions: structuredClone(s.substitutions),
    };
  }

  function resetRound(s) {
    s.confirmations = {};
    s.timedOut = [];
    s.substitutions = {};
    s.paused = false;
    s.pauseReason = null;
  }

  function foldEvent(s, ev) {
    const d = ev.detail || {};
    switch (ev.event) {
      case 'session-start':
        s.phase = 'active';
        break;

      case 'cue-started': {
        s.phase = 'active';
        s.seq = Number(d.seq) || s.seq;
        s.targets = Array.isArray(d.targets) ? d.targets.map(String) : [];
        s.text = String(d.text || '');
        s.originalText = s.text;
        s.revision = 1;
        s.reason = null;
        s.attemptId = d.attemptId || null;
        s.attempts = [];
        resetRound(s);
        s.roundStartIso = ev.ts;
        s.results[s.seq] = 'active';
        break;
      }

      // 撤回：先按旧轮次现场封存只读历史（在 cue-resent 清空本轮状态之前）
      case 'cue-recalled': {
        s.attempts.push(snapshotRound(s, 'recalled', d.reason, ev));
        break;
      }

      // 修订版重发：同序号递增修订号、替换文本、清空本轮状态重新确认
      case 'cue-resent': {
        s.revision = Number(d.revision) || s.revision + 1;
        s.text = String(d.text || s.text);
        s.reason = d.reason || s.reason;
        s.attemptId = d.attemptId || null;
        resetRound(s);
        s.roundStartIso = ev.ts;
        break;
      }

      case 'cue-completed': {
        s.attempts.push(snapshotRound(s, 'completed', null, ev));
        if (s.seq != null) s.results[s.seq] = 'completed';
        s.phase = 'between';
        break;
      }

      case 'confirm':
        if (d.position && !s.confirmations[d.position]) s.confirmations[d.position] = { late: false };
        break;

      case 'confirm-late':
        if (d.position) {
          s.confirmations[d.position] = { late: true };
          s.timedOut = s.timedOut.filter((t) => t !== d.position);
        }
        break;

      case 'cue-timeout':
        // 与服务端一致：超时表只在首次定时器到期写入，不覆盖后续确认结果
        if (s.timedOut.length === 0 && Array.isArray(d.missing)) s.timedOut = [...d.missing];
        break;

      case 'position-substituted': {
        const from = String(d.from || '');
        const to = String(d.to || '');
        if (from && to && !s.substitutions[from]) {
          s.substitutions[from] = { substitute: to };
          s.timedOut = s.timedOut.map((t) => (t === from ? to : t));
        }
        break;
      }

      case 'cue-paused':
        s.paused = true;
        s.pauseReason = d.reason || '';
        break;

      case 'cue-resumed':
        s.paused = false;
        s.pauseReason = null;
        break;

      // 重复确认、暂停中确认被拒、旧轮次迟到消息、租约、草稿、上下线等事件
      // 只存在于事件流/时间轴上，不改变当前口令现场
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

  // 从起点确定性重放到 targetT：逐事件应用所有偏移 <= targetT 的事件。
  // events 已按日志行序排列（服务端保证追加顺序），同一毫秒内 cue-recalled
  // 也必然先于 cue-resent 落盘，因此折叠结果与顺序播放逐帧到达时完全相同。
  function foldUntil(events, targetT) {
    const s = initialState();
    for (const ev of events) {
      if (ev.t > targetT) break;
      foldEvent(s, ev);
    }
    return s;
  }

  // 当前口令有效目标（被替岗的原岗位由替补顶替）
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

  function positionsOf(ev) {
    const d = (ev && ev.detail) || {};
    const set = new Set();
    [d.position, d.from, d.to].forEach((v) => { if (v) set.add(String(v)); });
    ['targets', 'missing'].forEach((k) => (Array.isArray(d[k]) ? d[k] : []).forEach((v) => set.add(String(v))));
    return [...set];
  }

  return {
    DEFAULT_TIMEOUT_SEC,
    EVENT_LABELS,
    CATEGORIES,
    eventLabel,
    categoryOf,
    initialState,
    foldEvent,
    foldUntil,
    effectiveTargets,
    viewOf,
    positionsOf,
  };
})();
