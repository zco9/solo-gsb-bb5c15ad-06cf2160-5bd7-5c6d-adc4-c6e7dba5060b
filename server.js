'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const replay = require('./replay'); // 演出复盘（只读）模块：只读 data 目录事件日志，不触碰当前演出状态
const compare = require('./compare'); // 场次对比（只读）模块：复用复盘解析器做两场口令序列对齐，不写日志、不接 WebSocket
const archive = require('./archive'); // 可验证复盘归档（只读）模块：导出带哈希链摘要的 JSON 归档，不写日志、不接 WebSocket

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_TIMEOUT_SEC = 30;
const MAX_LOG_ENTRIES = 500;
// 指挥权租约：有效期默认 15 秒（LEASE_TTL_SEC 可调，5–300），持有者按心跳续期
const LEASE_TTL_MS = Math.min(300000, Math.max(5000, Number(process.env.LEASE_TTL_SEC || 15) * 1000));
const LEASE_SWEEP_MS = Math.min(10000, Math.max(200, Number(process.env.LEASE_SWEEP_MS || 1000))); // 过期租约清扫周期：心跳停止后至多延迟 1 秒自动释放

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 会话状态（单场次，内存态；事件日志同时落盘到 data/events-<sessionId>.jsonl）
// ---------------------------------------------------------------------------
const state = {
  sessionId: crypto.randomUUID(),
  phase: 'idle', // idle | active | done
  sequence: [], // [{ id, seq, text, targets: [string] }]
  // 已发布序列的单调版本号：导演端保存序列（setSequence）与重置时发布草稿各 +1，
  // 各端实时展示；草稿基于的版本（basedOnVersion）记录其出处
  publishedVersion: 0,
  // 下一场草稿：仅 active/done 阶段可由导演端基于已发布序列编辑保存。
  // 与本场 state.sequence 完全隔离——保存草稿绝不替换当前口令/目标，也不触碰 cueHistory；
  // 重置时控制端必须明确选择「沿用当前序列（放弃草稿）」或「发布草稿并重置（原子替换）」。
  // revision 为草稿自身的乐观并发版本号：保存必须携带所持有的版本，多导演端并发时过期写入被拒。
  draft: null, // { revision, basedOnVersion, cues: [{ text, targets }], timeoutSec, updatedAt, updatedBy }
  timeoutSec: DEFAULT_TIMEOUT_SEC,
  currentIndex: -1,
  attemptId: null, // 当前轮次（某次激活/某次修订重发）的唯一凭证，岗位确认必须原样带回
  // 每个口令的修订档案：cueId -> { revision, currentReason, attempts: [只读历史轮次] }
  cueHistory: {},
  confirmations: {}, // 当前轮次：position -> { clientId, at, late, attemptId }
  timedOut: [], // 当前轮次：超时未确认的岗位
  substitutions: {}, // 当前轮次的临时替岗：原岗位 -> { substitute, at }，仅对本轮次生效
  cueStartedAt: null,
  deadline: null,
  // 暂停状态（仅当前轮次）：暂停时冻结剩余确认时长并撤销本轮计时器，恢复时按冻结余量重新计时
  paused: false,
  pauseReason: null, // 暂停原因（必填）
  pausedAt: null, // 暂停时刻（ms 时间戳）
  pausedBy: null, // 操作者 clientId
  remainingMs: null, // 冻结的剩余确认时长（ms），恢复时以此重排 deadline，重复暂停/恢复不累计误差
  timerToken: 0, // 定时器凭证：每次撤销/重排计时器时递增，旧回调凭 token 不匹配被拒绝
  // 指挥权租约：多个控制端可同时在线，但同一时刻仅持有者可执行
  // 开始 / 推进 / 替岗 / 撤回 / 暂停 / 恢复 / 重置。token 为本次授予的唯一凭证，
  // 心跳与释放必须携带；旧连接的迟到心跳凭 token 不符被拒绝，绝不续活新租约
  lease: { holderId: null, holderName: null, token: null, acquiredAt: null, expiresAt: null },
  log: [], // [{ ts, event, detail }]
};

let timeoutTimer = null;
const logStream = fs.createWriteStream(
  path.join(DATA_DIR, `events-${state.sessionId}.jsonl`),
  { flags: 'a' }
);

function addLog(event, detail = {}) {
  const entry = { ts: new Date().toISOString(), event, detail };
  state.log.push(entry);
  if (state.log.length > MAX_LOG_ENTRIES) state.log.shift();
  logStream.write(JSON.stringify(entry) + '\n');
  return entry;
}

function currentCue() {
  if (state.phase !== 'active') return null;
  return state.sequence[state.currentIndex] || null;
}

// 某条口令的修订档案（修订号、修订原因、只读历史轮次）
function cueHistoryOf(cue) {
  if (!cue) return null;
  return state.cueHistory[cue.id] || null;
}

// 冻结当前轮次快照为只读历史（撤回/推进封存时使用，深拷贝确保之后无法被修改）
function snapshotCurrentAttempt(cue, endState, reason) {
  return {
    attemptId: state.attemptId,
    revision: cueHistoryOf(cue) ? cueHistoryOf(cue).revision : 1,
    text: cue.text,
    startedAt: state.cueStartedAt,
    deadline: state.deadline,
    endedAt: Date.now(),
    endState, // completed（全员确认后推进封存） | recalled（撤回纠正重发）
    reason: reason || null, // endState === recalled 时为撤回原因
    confirmations: structuredClone(state.confirmations),
    timedOut: structuredClone(state.timedOut),
    substitutions: structuredClone(state.substitutions),
  };
}

// 当前口令的有效目标：被替岗的原岗位由其替补顶替，仅对当前口令生效
function effectiveTargets(cue) {
  if (!cue) return [];
  return cue.targets.map((t) => {
    const sub = state.substitutions[t];
    return sub ? sub.substitute : t;
  });
}

function allConfirmed() {
  const cue = currentCue();
  if (!cue) return false;
  return effectiveTargets(cue).every((t) => state.confirmations[t]);
}

// 断线重连恢复依赖全量状态快照：任何变化都广播完整公开状态
function publicState() {
  const cue = currentCue();
  const hist = cueHistoryOf(cue);
  return {
    sessionId: state.sessionId,
    phase: state.phase,
    sequence: state.sequence,
    // 已发布版本号随全量快照下发：各端实时显示「已发布版本」
    publishedVersion: state.publishedVersion,
    // 下一场草稿（含草稿 revision 乐观锁版本号与所基于的已发布版本）随快照下发：
    // 多导演端据此展示草稿版本、携带 revision 保存，冲突时以服务端返回的最新草稿为准重做
    draft: state.draft ? structuredClone(state.draft) : null,
    timeoutSec: state.timeoutSec,
    currentIndex: state.currentIndex,
    currentCue: cue,
    attemptId: state.attemptId,
    revision: hist ? hist.revision : 1,
    revisionReason: hist && hist.revision > 1 ? hist.currentReason : null,
    cueHistory: state.cueHistory,
    confirmations: state.confirmations,
    timedOut: state.timedOut,
    substitutions: state.substitutions,
    effectiveTargets: effectiveTargets(cue),
    cueStartedAt: state.cueStartedAt,
    deadline: state.deadline,
    // 暂停状态随全量快照下发：断线重连后各端恢复一致的暂停现场
    paused: state.paused,
    pauseReason: state.pauseReason,
    pausedAt: state.pausedAt,
    pausedBy: state.pausedBy,
    remainingMs: state.remainingMs,
    // 指挥权租约：持有者与剩余有效期随全量快照下发，各端据此禁用/启用操作（token 不下发）
    lease: {
      ttlMs: LEASE_TTL_MS,
      holderId: state.lease.holderId,
      holderName: state.lease.holderName,
      acquiredAt: state.lease.acquiredAt,
      expiresAt: state.lease.expiresAt,
      remainingMs: state.lease.holderId ? Math.max(0, state.lease.expiresAt - Date.now()) : 0,
    },
    serverNow: Date.now(),
    onlinePositions: [...onlinePositions],
    log: state.log.slice(-200),
  };
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------------------------------------------------------------------------
// 演出复盘（只读）HTTP 接口：仅供 /replay.html 调用。
// 只读 data 目录中已闭合（session-start → sequence-finished）的历史场次，
// 绝不写入当前演出状态或事件日志；fileId 强制 UUID 形状，杜绝路径穿越。
// ---------------------------------------------------------------------------
app.get('/api/replay/sessions', (req, res) => {
  res.json(replay.listSessions(DATA_DIR));
});

app.get('/api/replay/sessions/:fileId/:runId', (req, res) => {
  const result = replay.getSession(DATA_DIR, req.params.fileId, req.params.runId);
  if (result.error === 'badId') return res.status(400).json({ error: '场次 ID 不合法' });
  if (result.error === 'notFound') return res.status(404).json({ error: '场次不存在或尚未结束' });
  if (result.error) return res.status(500).json({ error: '读取事件日志失败' });
  res.json(result);
});

// ---------------------------------------------------------------------------
// 场次对比（只读）HTTP 接口：仅供 /compare.html 调用。
// 在两个已结束场次之间生成逐口令对照表（匹配 / 新增 / 删除）。
// 复用复盘模块的只读日志解析器：不写事件日志、不引用当前演出状态、不接 WebSocket。
//   GET /api/compare/sessions?a=<fileId>/<runId>&b=<fileId>/<runId>
// ---------------------------------------------------------------------------
app.get('/api/compare/sessions', (req, res) => {
  const parseRef = (raw) => {
    const parts = String(raw || '').split('/');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
    return { fileId: parts[0], runId: parts[1] };
  };
  const a = parseRef(req.query.a);
  const b = parseRef(req.query.b);
  if (!a || !b) return res.status(400).json({ error: '请通过 a、b 参数指定两个场次（fileId/runId）' });
  const result = compare.compareSessions(DATA_DIR, a.fileId, a.runId, b.fileId, b.runId);
  if (result.error === 'badId') return res.status(400).json({ error: '场次 ID 不合法' });
  if (result.error === 'notFound') return res.status(404).json({ error: '场次不存在或尚未结束' });
  if (result.error) return res.status(500).json({ error: '读取事件日志失败' });
  res.json(result);
});

// ---------------------------------------------------------------------------
// 可验证复盘归档（只读）HTTP 接口：仅供 /archive.html 调用。
// 导出单个 JSON 归档包（格式版本 / 场次摘要 / 冻结序列 / 有效事件 / 逐行告警 /
// manifest 哈希链摘要）。复用复盘模块的只读日志解析器：不写事件日志、
// 不引用当前演出状态、不接 WebSocket；仅 GET 导出。
//   GET /api/archive/sessions/:fileId/:runId
// ---------------------------------------------------------------------------
app.get('/api/archive/sessions/:fileId/:runId', (req, res) => {
  const result = archive.buildArchive(DATA_DIR, req.params.fileId, req.params.runId);
  if (result.error === 'badId') return res.status(400).json({ error: '场次 ID 不合法' });
  if (result.error === 'notFound') return res.status(404).json({ error: '场次不存在或尚未结束' });
  if (result.error) return res.status(500).json({ error: '读取事件日志失败' });
  const a = result.archive;
  res.setHeader('Content-Disposition',
    `attachment; filename="cue-archive-${a.session.fileId}-run${a.session.runId + 1}.json"`);
  res.json(a);
});

const onlinePositions = new Set(); // 当前在线的岗位名

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

function broadcastState() {
  broadcast({ type: 'state', state: publicState() });
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

// ---------------------------------------------------------------------------
// 指挥权租约
// ---------------------------------------------------------------------------
// 多个控制端可同时在线，但同一时刻只有租约持有者可执行指挥操作。
// 租约由持有者按心跳续期；断线立即释放（见 close 处理），心跳停止由清扫器超时释放。
// 每次授予生成新 token：旧连接的迟到心跳/释放凭旧 token 一律拒绝，绝不续活新租约。
// Node 单线程消息处理保证竞争申请的检查与授予在同一同步块内完成，原子裁决、先到者得。
function resetLease() {
  state.lease = { holderId: null, holderName: null, token: null, acquiredAt: null, expiresAt: null };
}

// 过期即释放（清扫器周期调用 + 申请/越权校验时惰性调用），释放后广播全量快照
function sweepLeaseIfExpired() {
  const lease = state.lease;
  if (!lease.holderId || lease.expiresAt > Date.now()) return false;
  addLog('lease-expired', { holderId: lease.holderId, holderName: lease.holderName });
  resetLease();
  broadcastState();
  return true;
}

// 七类指挥操作（开始/推进/替岗/撤回/暂停/恢复/重置）的统一越权校验：
// 仅持有有效租约的控制端可执行；拒绝一律写入日志并随快照同步
function requireLease(ws, op) {
  const meta = ws.meta || {};
  sweepLeaseIfExpired();
  const lease = state.lease;
  let reason = null;
  if (meta.role !== 'control') {
    reason = '仅控制端可以执行此操作';
  } else if (!lease.holderId) {
    reason = '当前无人持有指挥权租约，请先在控制端申请指挥权';
  } else if (lease.holderId !== meta.clientId) {
    const remainSec = Math.ceil((lease.expiresAt - Date.now()) / 1000);
    reason = `指挥权租约由「${lease.holderName || lease.holderId}」持有（剩余约 ${remainSec} 秒），您无权操作；待其释放或过期后可接管`;
  }
  if (reason) {
    addLog('lease-op-denied', { op, clientId: meta.clientId || null, reason });
    broadcastState();
    sendError(ws, reason);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 口令推进逻辑
// ---------------------------------------------------------------------------
function clearCueTimer() {
  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
  }
  // 使任何已排队/迟到的旧回调失效：旧定时器回调只能被拒绝，绝不写入超时状态
  state.timerToken += 1;
}

// 为当前轮次布置确认超时定时器（首次激活、撤回重发、暂停后恢复均经此入口）。
// 回调携带本轮 attemptId 与 timerToken 双重凭证：任一不匹配即为旧回调，只记录、拒绝。
function armCueTimer(cue, revision, delayMs) {
  const attemptId = state.attemptId;
  const token = ++state.timerToken;
  timeoutTimer = setTimeout(() => {
    timeoutTimer = null;
    const cueNow = currentCue();
    // 旧定时器回调：轮次已撤回/推进/暂停/恢复重排，只记录、拒绝，绝不写入超时状态
    if (token !== state.timerToken || !cueNow || cueNow.id !== cue.id ||
        state.attemptId !== attemptId || state.paused) {
      addLog('stale-timeout-ignored', {
        seq: cue.seq,
        staleRevision: revision,
        staleAttemptId: attemptId,
        currentAttemptId: state.attemptId,
      });
      broadcastState();
      return;
    }
    const missing = effectiveTargets(cueNow).filter((t) => !state.confirmations[t]);
    if (missing.length === 0) return;
    // 本轮已标记过超时（如暂停前已超时，恢复后定时器再次到期）：不重复标记、不重复记录
    if (state.timedOut.length > 0) return;
    state.timedOut = missing;
    addLog('cue-timeout', { seq: cueNow.seq, revision, attemptId, missing });
    broadcastState();
  }, delayMs);
}

// 开启一轮全新确认时限（首次激活或撤回后修订重发均经此入口）。
// attemptId 为本轮唯一凭证；确认/超时/替岗/暂停/截止时间只属于本轮，绝不带入新轮次。
// cancelOldTimer=false（撤回场景）时不清除旧轮次定时器：让其到期后凭 attemptId/token 被拒绝并记录，
// 即“迟到的旧定时器回调只能被拒绝、绝不污染新轮次”；正常推进/重置仍直接取消旧定时器。
function startRound(cue, revision, startLog, { cancelOldTimer = true } = {}) {
  if (cancelOldTimer) clearCueTimer();
  // 确保该口令存在修订档案（第 1 版开始时建立；attempts 仅在封存时追加）
  if (!state.cueHistory[cue.id]) {
    state.cueHistory[cue.id] = { revision: 1, currentReason: null, attempts: [] };
  }
  state.attemptId = crypto.randomUUID();
  state.phase = 'active';
  // 关键：每轮的确认/超时/替岗/暂停状态独立，绝不串入下一轮/下一条（下一条仍用导演编排的原目标）
  state.confirmations = {};
  state.timedOut = [];
  state.substitutions = {};
  state.paused = false;
  state.pauseReason = null;
  state.pausedAt = null;
  state.pausedBy = null;
  state.remainingMs = null;
  state.cueStartedAt = Date.now();
  state.deadline = state.cueStartedAt + state.timeoutSec * 1000;

  if (startLog) {
    addLog(startLog.event, { ...startLog.detail, revision, attemptId: state.attemptId });
  }

  armCueTimer(cue, revision, state.timeoutSec * 1000);
}

function activateCue(index) {
  state.currentIndex = index;
  state.phase = 'active';
  const cue = state.sequence[index];
  startRound(cue, 1, { event: 'cue-started', detail: { seq: cue.seq, text: cue.text, targets: cue.targets } });
  broadcastState();
}

// 撤回并纠正重发：封存旧轮次为只读历史 → 替换口令文本、递增修订号 → 清空本轮状态并重新开始完整确认时限
function recallCue(ws, reason, newText) {
  const cue = currentCue();
  if (!cue) return sendError(ws, '当前没有进行中的口令，无法撤回');

  const hist = state.cueHistory[cue.id] || { revision: 1, currentReason: null, attempts: [] };
  const oldRevision = hist.revision;
  const oldAttemptId = state.attemptId;

  // 先封存旧轮次（在修改口令文本之前快照），旧轮次此后只读
  hist.attempts.push(snapshotCurrentAttempt(cue, 'recalled', reason));

  cue.text = newText;
  hist.revision = oldRevision + 1;
  hist.currentReason = reason;
  state.cueHistory[cue.id] = hist;

  addLog('cue-recalled', {
    seq: cue.seq,
    oldRevision,
    newRevision: hist.revision,
    oldAttemptId,
    reason,
    newText,
  });

  // 清空本轮状态并重新开始完整确认时限。
  // 不取消旧轮次定时器：它到期后凭 attemptId 被拒绝并记录（旧回调先于新截止时间触发）。
  startRound(cue, hist.revision, {
    event: 'cue-resent',
    detail: { seq: cue.seq, text: newText, reason },
  }, { cancelOldTimer: false });
  broadcastState();
}

// 暂停当前口令：冻结剩余确认时长、撤销本轮计时器；此后确认/替岗/撤回/推进均被拒绝，直至恢复
function pauseCue(ws, reason) {
  const meta = ws.meta || {};
  const cue = currentCue();
  const hist = cueHistoryOf(cue);
  const revision = hist ? hist.revision : 1;
  // 冻结剩余确认时长（已超时则余量为 0），撤销本轮计时器并使旧回调失效
  const remainingMs = Math.max(0, state.deadline - Date.now());
  clearCueTimer();
  state.paused = true;
  state.pauseReason = reason;
  state.pausedAt = Date.now();
  state.pausedBy = meta.clientId || null;
  state.remainingMs = remainingMs;
  addLog('cue-paused', {
    seq: cue.seq,
    revision,
    attemptId: state.attemptId,
    operator: state.pausedBy,
    reason,
    remainingSec: Math.ceil(remainingMs / 1000),
  });
  broadcastState();
}

// 恢复当前口令：沿用同一 attemptId，按冻结余量重新计时（不生成新轮次、不累计误差）
function resumeCue(ws) {
  const meta = ws.meta || {};
  const cue = currentCue();
  const hist = cueHistoryOf(cue);
  const revision = hist ? hist.revision : 1;
  const remainingMs = state.remainingMs;
  state.paused = false;
  state.pauseReason = null;
  state.pausedAt = null;
  state.pausedBy = null;
  state.remainingMs = null;
  // 按冻结余量重排截止时间：deadline = 恢复时刻 + 冻结余量，重复暂停/恢复不累计误差
  state.deadline = Date.now() + remainingMs;
  addLog('cue-resumed', {
    seq: cue.seq,
    revision,
    attemptId: state.attemptId,
    operator: meta.clientId || null,
    remainingSec: Math.ceil(remainingMs / 1000),
  });
  armCueTimer(cue, revision, remainingMs);
  broadcastState();
}

function finishSequence() {
  clearCueTimer();
  state.phase = 'done';
  state.currentIndex = state.sequence.length;
  state.attemptId = null;
  state.confirmations = {};
  state.timedOut = [];
  state.substitutions = {};
  state.paused = false;
  state.pauseReason = null;
  state.pausedAt = null;
  state.pausedBy = null;
  state.remainingMs = null;
  state.cueStartedAt = null;
  state.deadline = null;
  addLog('sequence-finished', {});
  broadcastState();
}

// ---------------------------------------------------------------------------
// 下一场草稿
// ---------------------------------------------------------------------------
// 清洗草稿/序列中的口令条目：去除空白、岗位去重、丢弃内容或目标为空的行
function sanitizeCues(rawCues) {
  const cues = Array.isArray(rawCues) ? rawCues : [];
  return cues
    .map((c) => ({
      text: String((c && c.text) || '').trim(),
      targets: [...new Set((c && Array.isArray(c.targets) ? c.targets : [])
        .map((t) => String(t).trim())
        .filter(Boolean))],
    }))
    .filter((c) => c.text && c.targets.length > 0);
}

function normalizeTimeoutSec(raw) {
  const timeoutSec = Number(raw);
  return Number.isFinite(timeoutSec) && timeoutSec >= 3 && timeoutSec <= 600
    ? Math.round(timeoutSec)
    : DEFAULT_TIMEOUT_SEC;
}

// 重置场次公共清理：清空本场进度/轮次/暂停状态；草稿与已发布序列由调用方决定（keep/publish/setSequence）
function resetSessionState() {
  clearCueTimer();
  state.phase = 'idle';
  state.currentIndex = -1;
  state.attemptId = null;
  state.cueHistory = {};
  state.confirmations = {};
  state.timedOut = [];
  state.substitutions = {};
  state.paused = false;
  state.pauseReason = null;
  state.pausedAt = null;
  state.pausedBy = null;
  state.remainingMs = null;
  state.cueStartedAt = null;
  state.deadline = null;
}

// 原子发布草稿为下一场序列：同一步骤内替换 sequence、递增已发布版本、清空草稿。
// 新序列所有口令重新分配 id 与 seq（不沿用本场冻结快照的 id），修订档案随之整体重置。
function publishDraftSequence(draft) {
  state.sequence = draft.cues.map((c, i) => ({
    id: crypto.randomUUID(),
    seq: i + 1,
    text: c.text,
    targets: c.targets,
  }));
  state.timeoutSec = draft.timeoutSec;
  state.publishedVersion += 1;
  state.draft = null;
}

function handleMessage(ws, msg) {
  let data;
  try {
    data = JSON.parse(msg);
  } catch {
    return sendError(ws, '无法解析的消息');
  }

  switch (data.type) {
    case 'hello': {
      const prev = ws.meta;
      // 同一连接换岗：先移除旧岗位在线记录
      if (prev && prev.role === 'position' && prev.position && prev.position !== data.position) {
        const stillUsed = [...wss.clients].some(
          (c) => c !== ws && c.meta && c.meta.position === prev.position && c.readyState === c.OPEN
        );
        if (!stillUsed) onlinePositions.delete(prev.position);
      }
      ws.meta = {
        role: data.role,
        position: data.position || null,
        clientId: data.clientId || null,
      };
      if (data.role === 'position' && data.position) {
        onlinePositions.add(data.position);
        addLog('position-online', { position: data.position });
        broadcastState();
      } else {
        send(ws, { type: 'state', state: publicState() });
      }
      // 持有指挥权的控制端重连（或同 clientId 的另一连接登记）：重新下发租约凭证以恢复心跳续期
      if (ws.meta.role === 'control' && state.lease.holderId === ws.meta.clientId &&
          state.lease.expiresAt > Date.now()) {
        send(ws, {
          type: 'lease-granted',
          token: state.lease.token,
          expiresAt: state.lease.expiresAt,
          ttlMs: LEASE_TTL_MS,
        });
      }
      break;
    }

    case 'lease-acquire': {
      // 申请 / 接管指挥权租约：无人持有或租约已过期时授予；被他人持有且未过期时拒绝。
      // 竞争申请原子裁决：检查与授予在同一同步消息处理内完成，两个并发申请先到者得。
      const meta = ws.meta || {};
      if (meta.role !== 'control') return sendError(ws, '仅控制端可以申请指挥权租约');
      const now = Date.now();
      const lease = state.lease;
      const name = String(data.name || '').trim().slice(0, 24) || null;
      // 持有者本人重复申请：幂等续期，token 不变（客户端重试安全）
      if (lease.holderId === meta.clientId && lease.expiresAt > now) {
        lease.expiresAt = now + LEASE_TTL_MS;
        if (name) lease.holderName = name;
        send(ws, { type: 'lease-granted', token: lease.token, expiresAt: lease.expiresAt, ttlMs: LEASE_TTL_MS });
        broadcastState();
        break;
      }
      if (lease.holderId && lease.expiresAt > now) {
        const remainSec = Math.ceil((lease.expiresAt - now) / 1000);
        addLog('lease-acquire-denied', {
          requester: meta.clientId,
          holderId: lease.holderId,
          holderName: lease.holderName,
          remainingSec: remainSec,
        });
        broadcastState();
        return sendError(ws, `指挥权租约由「${lease.holderName || lease.holderId}」持有（剩余约 ${remainSec} 秒），到期或释放后可接管`);
      }
      // 授予新租约（含接管已过期租约）：生成新 token，旧连接的心跳凭证随之失效
      const previous = lease.holderId && lease.holderId !== meta.clientId
        ? { holderId: lease.holderId, holderName: lease.holderName }
        : null;
      state.lease = {
        holderId: meta.clientId,
        holderName: name,
        token: crypto.randomUUID(),
        acquiredAt: now,
        expiresAt: now + LEASE_TTL_MS,
      };
      addLog('lease-acquired', {
        holderId: state.lease.holderId,
        holderName: name,
        ttlSec: LEASE_TTL_MS / 1000,
        takeover: !!previous, // 接管他人已过期租约
        previousHolder: previous ? (previous.holderName || previous.holderId) : null,
      });
      send(ws, { type: 'lease-granted', token: state.lease.token, expiresAt: state.lease.expiresAt, ttlMs: LEASE_TTL_MS });
      broadcastState();
      break;
    }

    case 'lease-release': {
      // 主动释放：仅持有者本人且携带当前 token 才可释放
      const meta = ws.meta || {};
      if (meta.role !== 'control') return sendError(ws, '仅控制端可以释放指挥权租约');
      const lease = state.lease;
      if (!lease.holderId || lease.holderId !== meta.clientId || data.token !== lease.token) {
        return sendError(ws, '您当前未持有指挥权租约，无法释放');
      }
      addLog('lease-released', { holderId: lease.holderId, holderName: lease.holderName, reason: 'voluntary' });
      resetLease();
      broadcastState();
      break;
    }

    case 'lease-heartbeat': {
      // 心跳续期：仅持有者本人且 token 与当前租约一致才续期。
      // 旧连接的迟到心跳（token 不符 / 租约已易主或释放 / 已过期）只拒绝并记录，绝不续活新租约
      const meta = ws.meta || {};
      const lease = state.lease;
      const now = Date.now();
      if (!lease.holderId || lease.holderId !== meta.clientId || data.token !== lease.token) {
        addLog('stale-lease-heartbeat-ignored', { clientId: meta.clientId || null, reason: 'token-mismatch' });
        broadcastState();
        return sendError(ws, '心跳凭证已失效：指挥权租约已易主或已释放，如需操作请重新申请');
      }
      if (lease.expiresAt <= now) {
        addLog('stale-lease-heartbeat-ignored', { clientId: meta.clientId, reason: 'expired' });
        broadcastState();
        return sendError(ws, '指挥权租约已过期，心跳无法续期，请重新申请');
      }
      lease.expiresAt = now + LEASE_TTL_MS;
      send(ws, { type: 'lease-renewed', expiresAt: lease.expiresAt, ttlMs: LEASE_TTL_MS });
      broadcastState();
      break;
    }

    case 'setSequence': {
      if (state.phase !== 'idle') {
        return sendError(ws, '演出进行中，请先重置再修改序列');
      }
      const cleaned = sanitizeCues(data.cues);
      if (cleaned.length === 0) {
        return sendError(ws, '序列不能为空，每条口令需包含口令内容与至少一个目标岗位');
      }
      state.sequence = cleaned.map((c, i) => ({
        id: crypto.randomUUID(),
        seq: i + 1,
        text: c.text,
        targets: c.targets,
      }));
      state.timeoutSec = normalizeTimeoutSec(data.timeoutSec);
      state.currentIndex = -1;
      state.attemptId = null;
      state.cueHistory = {};
      // idle 状态下发布全新序列：已发布版本 +1；理论上重置后草稿必已清空，此处兜底丢弃任何残留草稿
      state.publishedVersion += 1;
      state.draft = null;
      addLog('sequence-set', {
        version: state.publishedVersion,
        count: state.sequence.length,
        timeoutSec: state.timeoutSec,
        cues: state.sequence.map((c) => ({ seq: c.seq, text: c.text, targets: c.targets })),
      });
      broadcastState();
      break;
    }

    case 'start': {
      if (!requireLease(ws, 'start')) break;
      if (state.phase === 'active') return sendError(ws, '口令正在进行中');
      if (state.sequence.length === 0) return sendError(ws, '请先由导演端创建演出序列');
      if (state.phase === 'done') return sendError(ws, '本场已结束，请重置后重新开始');
      addLog('session-start', {});
      activateCue(0);
      break;
    }

    case 'advance': {
      if (!requireLease(ws, 'advance')) break;
      if (state.phase !== 'active') return sendError(ws, '当前没有进行中的口令');
      if (state.paused) return sendError(ws, '口令已暂停，请先恢复再推进');
      if (!allConfirmed()) {
        const cue = currentCue();
        const missing = effectiveTargets(cue).filter((t) => !state.confirmations[t]);
        return sendError(ws, `以下岗位尚未确认，禁止推进：${missing.join('、')}`);
      }
      const doneCue = currentCue();
      const doneHist = state.cueHistory[doneCue.id] || { revision: 1, currentReason: null, attempts: [] };
      const doneRevision = doneHist.revision;
      // 已完成轮次封存为只读历史，随后旧轮次的迟到确认/定时器回调只能被拒绝
      doneHist.attempts.push(snapshotCurrentAttempt(doneCue, 'completed', null));
      state.cueHistory[doneCue.id] = doneHist;
      addLog('cue-completed', { seq: doneCue.seq, revision: doneRevision, attemptId: state.attemptId });
      if (state.currentIndex + 1 >= state.sequence.length) {
        finishSequence();
      } else {
        activateCue(state.currentIndex + 1);
      }
      break;
    }

    case 'saveDraft': {
      // 下一场草稿：仅导演端可保存，且仅在演出进行中（active）或已结束（done）时有意义。
      // 草稿与本场冻结快照完全隔离：只写入独立的 state.draft，绝不修改
      // state.sequence / currentIndex / cueHistory / 当前口令文本与目标 / 修订档案。
      const meta = ws.meta || {};
      if (meta.role !== 'director') return sendError(ws, '仅导演端可以编辑下一场草稿');
      if (state.phase !== 'active' && state.phase !== 'done') {
        return sendError(ws, '当前不在演出中，直接在「新建 / 编辑演出序列」中保存即可，无需草稿');
      }
      const cleaned = sanitizeCues(data.cues);
      if (cleaned.length === 0) {
        return sendError(ws, '草稿不能为空，每条口令需包含口令内容与至少一个目标岗位');
      }
      // 乐观并发控制：保存必须携带其编辑所基于的草稿 revision。
      // null/缺省表示「尚无草稿、本次为首次创建」；与当前版本不一致即拒绝覆盖，
      // 并把服务端最新草稿随错误定向下发，供用户刷新后在其基础上重做。
      const baseRevision = data.revision == null ? null : Number(data.revision);
      if (data.revision != null && !Number.isInteger(baseRevision)) {
        return sendError(ws, '草稿版本号无效，请刷新页面后重新编辑');
      }
      const currentRevision = state.draft ? state.draft.revision : null;
      if (baseRevision !== currentRevision) {
        addLog('draft-save-conflict', {
          clientId: meta.clientId || null,
          sentRevision: baseRevision,
          currentRevision,
        });
        broadcastState();
        return send(ws, {
          type: 'draft-conflict',
          message: currentRevision === null
            ? '草稿已被其他导演端保存过，请载入最新草稿后重做'
            : `草稿已被其他导演端更新至第 ${currentRevision} 版，已为您载入最新内容，请在其基础上重做`,
          currentRevision,
          draft: state.draft ? structuredClone(state.draft) : null,
        });
      }
      const isCreate = currentRevision === null;
      const newRevision = isCreate ? 1 : currentRevision + 1;
      state.draft = {
        revision: newRevision,
        // 记录草稿所基于的已发布序列版本：首次保存时锁定，后续保存沿用，直到发布
        basedOnVersion: isCreate ? state.publishedVersion : state.draft.basedOnVersion,
        cues: cleaned,
        timeoutSec: normalizeTimeoutSec(data.timeoutSec),
        updatedAt: Date.now(),
        updatedBy: meta.clientId || null,
      };
      addLog(isCreate ? 'draft-created' : 'draft-saved', {
        revision: newRevision,
        basedOnVersion: state.draft.basedOnVersion,
        count: cleaned.length,
        clientId: meta.clientId || null,
      });
      broadcastState();
      // 保存成功定向下发确认（含最新 revision）：导演端据此更新「已保存」版本标记
      send(ws, { type: 'draft-saved', draft: structuredClone(state.draft) });
      break;
    }

    case 'reset': {
      if (!requireLease(ws, 'reset')) break;
      // 存在下一场草稿时，重置必须明确二选一，绝不允许无意中覆盖或丢弃草稿：
      //   keep    —— 沿用当前序列重置（草稿被明确放弃并清空）
      //   publish —— 发布草稿并重置（原子替换下一场序列并清空草稿）
      if (state.draft && data.resetMode !== 'keep' && data.resetMode !== 'publish') {
        return send(ws, {
          type: 'reset-choice-required',
          message: '存在未发布的下一场草稿，重置前必须明确选择：沿用当前序列（放弃草稿）或发布草稿并重置',
          draft: structuredClone(state.draft),
        });
      }
      const draft = state.draft;
      if (draft && data.resetMode === 'publish') {
        // 防御：草稿内容须仍为非空（保存时已校验，此处兜底）
        if (!Array.isArray(draft.cues) || draft.cues.length === 0) {
          return sendError(ws, '草稿内容为空，无法发布；请先修正草稿或选择沿用当前序列');
        }
        resetSessionState();
        // 原子发布：同一步骤内替换序列、递增已发布版本、清空草稿，
        // 随后 start 使用的必然是新序列；任何中途广播都不可能观察到半成品状态
        publishDraftSequence(draft);
        addLog('session-reset', { choice: 'publish-draft', publishedVersion: state.publishedVersion });
        addLog('draft-published', {
          version: state.publishedVersion,
          count: state.sequence.length,
          timeoutSec: state.timeoutSec,
        });
        broadcastState();
        break;
      }
      resetSessionState();
      // keep（沿用当前序列）或无草稿：序列与已发布版本不变；明确放弃草稿时记录清空
      if (draft) {
        state.draft = null;
        addLog('draft-discarded', { clientId: (ws.meta || {}).clientId || null });
      }
      addLog('session-reset', { choice: draft ? 'keep-current' : 'normal' });
      broadcastState();
      break;
    }

    case 'confirm': {
      const meta = ws.meta || {};
      if (meta.role !== 'position' || !meta.position) {
        return sendError(ws, '仅岗位端可以确认口令');
      }
      const cue = currentCue();
      if (!cue) return sendError(ws, '当前没有进行中的口令');
      // 暂停期间冻结一切岗位操作：确认被拒绝并记录
      if (state.paused) {
        addLog('paused-confirm-rejected', { seq: cue.seq, position: meta.position, attemptId: state.attemptId });
        broadcastState();
        return sendError(ws, `口令已暂停（${state.pauseReason}），等待控制端恢复后再确认`);
      }
      const hist = cueHistoryOf(cue);
      const revision = hist ? hist.revision : 1;
      // 旧轮次确认（迟到到达）：attemptId 与当前轮次不符，只拒绝并记录，绝不污染新轮次
      if (!data.attemptId || data.attemptId !== state.attemptId) {
        addLog('stale-confirm-ignored', {
          seq: cue.seq,
          position: meta.position,
          sentAttemptId: data.attemptId || null,
          currentAttemptId: state.attemptId,
          currentRevision: revision,
        });
        broadcastState();
        return sendError(ws, '该确认属于已撤回/已结束的旧轮次，已被拒绝；请按最新修订版口令重新确认');
      }
      const position = meta.position;
      if (!effectiveTargets(cue).includes(position)) {
        // 原岗位被替岗后，确认权已移交替补，不得再确认本轮
        if (cue.targets.includes(position) && state.substitutions[position]) {
          return sendError(ws, `本岗位的确认任务已移交「${state.substitutions[position].substitute}」，无需再确认`);
        }
        return sendError(ws, `本条口令不涉及岗位「${position}」`);
      }
      // 重复确认：实时标记进日志，不改变状态
      if (state.confirmations[position]) {
        addLog('confirm-duplicate', { seq: cue.seq, revision, attemptId: state.attemptId, position });
        broadcastState();
        return;
      }
      const late = state.timedOut.includes(position);
      state.confirmations[position] = {
        clientId: meta.clientId,
        at: Date.now(),
        late,
        attemptId: state.attemptId,
      };
      if (late) state.timedOut = state.timedOut.filter((t) => t !== position);
      addLog(late ? 'confirm-late' : 'confirm', {
        seq: cue.seq, revision, attemptId: state.attemptId, position,
      });
      broadcastState();
      break;
    }

    case 'substitute': {
      // 临时替岗：仅持有指挥权租约的控制端可指定一名在线替补，接管当前口令某个未确认目标
      if (!requireLease(ws, 'substitute')) break;
      const cue = currentCue();
      if (!cue) return sendError(ws, '当前没有进行中的口令');
      // 暂停期间冻结一切岗位操作：替岗被拒绝
      if (state.paused) return sendError(ws, `口令已暂停（${state.pauseReason}），请先恢复再替岗`);
      // 旧轮次的替岗请求（撤回后迟到到达）：拒绝并记录
      if (data.attemptId && data.attemptId !== state.attemptId) {
        addLog('stale-substitute-ignored', {
          seq: cue.seq,
          sentAttemptId: data.attemptId || null,
          currentAttemptId: state.attemptId,
        });
        broadcastState();
        return sendError(ws, '该替岗操作属于已撤回/已结束的旧轮次，已被拒绝');
      }
      const from = String(data.from || '').trim();
      const to = String(data.to || '').trim();
      if (!from || !to) return sendError(ws, '请指定被替岗的原岗位与替补岗位');
      if (!cue.targets.includes(from)) {
        return sendError(ws, `「${from}」不是本条口令的目标岗位`);
      }
      if (state.substitutions[from]) {
        return sendError(ws, `「${from}」的确认任务已被「${state.substitutions[from].substitute}」接管`);
      }
      if (state.confirmations[from]) {
        return sendError(ws, `「${from}」已确认，无需替岗`);
      }
      if (!onlinePositions.has(to)) {
        return sendError(ws, `替补岗位「${to}」不在线，无法接管`);
      }
      // 替补不能已是本条有效目标（含原目标、其他替补及 from 本身）
      if (effectiveTargets(cue).includes(to)) {
        return sendError(ws, `「${to}」已是本条口令的有效目标，不能作为替补`);
      }
      // 原子更新：仅当前口令的有效目标与确认权限，下一条口令不受影响
      state.substitutions[from] = { substitute: to, at: Date.now() };
      // 超时未确认标记随确认权一起移交给替补
      if (state.timedOut.includes(from)) {
        state.timedOut = state.timedOut.map((t) => (t === from ? to : t));
      }
      addLog('position-substituted', {
        seq: cue.seq, revision: cueHistoryOf(cue).revision, attemptId: state.attemptId, from, to,
      });
      broadcastState();
      break;
    }

    case 'recall': {
      // 撤回并纠正重发：仅持有指挥权租约的控制端可发起，须填写撤回原因与修正版口令文本
      if (!requireLease(ws, 'recall')) break;
      if (state.phase !== 'active' || !currentCue()) {
        return sendError(ws, '仅可撤回当前进行中的口令；已推进或已完成的口令不可撤回');
      }
      if (state.paused) {
        return sendError(ws, `口令已暂停（${state.pauseReason}），请先恢复再撤回`);
      }
      if (allConfirmed()) {
        return sendError(ws, '当前口令已全员确认完成，不可撤回；如需更正请在下一条口令中说明');
      }
      const reason = String(data.reason || '').trim();
      const newText = String(data.text || '').trim();
      if (!reason) return sendError(ws, '请填写撤回原因');
      if (!newText) return sendError(ws, '请填写修正版口令文本');
      recallCue(ws, reason, newText);
      break;
    }

    case 'pause': {
      // 暂停当前口令：仅持有指挥权租约的控制端可发起，仅限进行中且尚未全员确认的口令，必须填写原因
      if (!requireLease(ws, 'pause')) break;
      if (state.phase !== 'active' || !currentCue()) {
        return sendError(ws, '当前没有进行中的口令，无法暂停');
      }
      if (state.paused) {
        return sendError(ws, '当前口令已处于暂停状态，请先恢复');
      }
      if (allConfirmed()) {
        return sendError(ws, '当前口令已全员确认完成，不可暂停');
      }
      const reason = String(data.reason || '').trim();
      if (!reason) return sendError(ws, '请填写暂停原因');
      pauseCue(ws, reason);
      break;
    }

    case 'resume': {
      // 恢复当前口令：仅持有指挥权租约的控制端可发起，沿用同一 attemptId 按冻结余量重新计时
      if (!requireLease(ws, 'resume')) break;
      if (state.phase !== 'active' || !currentCue()) {
        return sendError(ws, '当前没有进行中的口令，无法恢复');
      }
      if (!state.paused) {
        return sendError(ws, '当前口令未处于暂停状态');
      }
      resumeCue(ws);
      break;
    }

    default:
      sendError(ws, `未知消息类型：${data.type}`);
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (msg) => handleMessage(ws, msg));
  ws.on('close', () => {
    const meta = ws.meta;
    if (meta && meta.role === 'position' && meta.position) {
      // 同一岗位可能有多个连接，全部断开才算离线
      const stillOnline = [...wss.clients].some(
        (c) => c !== ws && c.meta && c.meta.position === meta.position && c.readyState === c.OPEN
      );
      if (!stillOnline) {
        onlinePositions.delete(meta.position);
        addLog('position-offline', { position: meta.position });
        broadcastState();
      }
    }
    // 租约持有者断线：其最后一个控制端连接关闭时立即释放租约（心跳超时释放由清扫器兜底）
    if (meta && meta.role === 'control' && meta.clientId && state.lease.holderId === meta.clientId) {
      const stillConnected = [...wss.clients].some(
        (c) => c !== ws && c.readyState === c.OPEN && c.meta && c.meta.role === 'control' &&
          c.meta.clientId === meta.clientId
      );
      if (!stillConnected) {
        addLog('lease-released', {
          holderId: state.lease.holderId,
          holderName: state.lease.holderName,
          reason: 'disconnect',
        });
        resetLease();
        broadcastState();
      }
    }
  });
  ws.on('error', () => {});
});

// 过期租约清扫：心跳停止后租约到期自动释放并广播（断线立即释放见 close 处理）
setInterval(sweepLeaseIfExpired, LEASE_SWEEP_MS);

server.listen(PORT, () => {
  console.log(`舞台口令同步系统已启动: http://localhost:${PORT}`);
  console.log(`  导演端:   http://localhost:${PORT}/director.html`);
  console.log(`  控制端:   http://localhost:${PORT}/control.html`);
  console.log(`  岗位端:   http://localhost:${PORT}/position.html`);
  console.log(`  演出复盘: http://localhost:${PORT}/replay.html （只读，回放已结束场次）`);
  console.log(`  复盘批注簿: http://localhost:${PORT}/annotations.html （只读，批注仅存浏览器 IndexedDB）`);
  console.log(`  复盘播放清单: http://localhost:${PORT}/playlist.html （只读，清单仅存浏览器 IndexedDB，跨场次连续回放）`);
  console.log(`  场次对比: http://localhost:${PORT}/compare.html （只读，逐口令对齐两个已结束场次）`);
  console.log(`  确认延迟诊断: http://localhost:${PORT}/latency.html （只读，复用复盘 GET 接口，不接 WebSocket、不写日志）`);
  console.log(`  复盘归档: http://localhost:${PORT}/archive.html （只读，导出 / 本地校验可验证归档）`);
  console.log(`  指挥权租约: ${LEASE_TTL_MS / 1000} 秒（心跳续期，超时/断线自动释放）`);
  console.log(`  事件日志: data/events-${state.sessionId}.jsonl`);
});
