/* 演出复盘前端：只读回放已结束场次。
 *
 * 本文件是共享纯函数内核 public/core.js（CueCore）的展示层适配：
 * 确定性折叠（场次 / 口令 / 轮次状态机）、同毫秒事件顺序、修订、暂停恢复、
 * 替岗、超时与迟到确认、旧 attemptId 归属全部由内核处理。本文件只保留
 * 复盘页面专用的事件文案、分类与视图导出。
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

// Node（require）环境下共享内核经 module 装配；浏览器中由 <script src="core.js">
// 提供同名全局。两种环境共用同一份文件，无任何环境相关分支逻辑。
const CueCore = typeof globalThis !== 'undefined' && globalThis.CueCore
  ? globalThis.CueCore
  : require('./core').CueCore;

const Replay = (() => {
  const C = CueCore; // 复盘 / 对比 / 延迟诊断共用的折叠内核

  const DEFAULT_TIMEOUT_SEC = C.DEFAULT_TIMEOUT_SEC;

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
  // 以下全部直接委托共享内核：状态机初值 / 单事件折叠 / 任意时刻从起点的
  // 确定性重放 / 有效目标 / 岗位状态分组。消费者只筛选与展示，不写转移规则。
  // -------------------------------------------------------------------------
  const initialState = C.initialState;
  const foldEvent = C.foldEvent;
  const foldUntil = C.foldUntil;
  const foldEvents = C.foldEvents;
  const effectiveTargets = C.effectiveTargets;
  const viewOf = C.viewOf;
  const positionsOf = C.eventPositions;

  return {
    DEFAULT_TIMEOUT_SEC,
    EVENT_LABELS,
    CATEGORIES,
    eventLabel,
    categoryOf,
    initialState,
    foldEvent,
    foldUntil,
    foldEvents,
    effectiveTargets,
    viewOf,
    positionsOf,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Replay };
}
