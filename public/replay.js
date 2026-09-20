/* 演出复盘前端（只读）：只读回放已结束场次。
 *
 * 本文件只保留复盘页的展示口径（事件标签 / 分类）与向后兼容的 Replay 门面；
 * 场次、口令与确认轮次的折叠状态机全部在共享内核 public/replay-core.js 中：
 *
 *   - 复盘任意时刻重放：Replay.foldUntil(events, targetT) 从本场起点
 *     （session-start）按事件日志行序逐事件折叠（同内核，同 compare / latency）；
 *   - 场次对比（compare.js，Node 侧 require 同一文件）与确认延迟诊断
 *     （public/latency.js）复用同一份轮次 / 暂停 / 替岗 / 修订模型；
 *   - 消费者只负责筛选和展示，任何时刻的现场都由同一状态机重新折叠得到，
 *     绝不增量累积，因此拖动 / 点击跳转 / 正常顺序播放到达同一时刻严格一致。
 *
 * 只读：本文件只发起 GET 请求拉取历史日志，没有 WebSocket、没有任何写操作，
 * 不可能影响当前演出状态或事件日志。
 */
'use strict';

const Replay = (() => {
  const {
    DEFAULT_TIMEOUT_SEC,
    foldEvent,
    foldEvents,
    foldUntil,
    initialState,
    effectiveTargets,
    viewOf,
  } = ReplayCore;

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

  // 事件涉及的岗位（筛选下拉口径，与服务端 replay.eventPositions 一致）
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
    foldEvents,
    foldUntil,
    effectiveTargets,
    viewOf,
    positionsOf,
  };
})();
