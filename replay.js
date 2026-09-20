'use strict';

// ---------------------------------------------------------------------------
// 演出复盘（只读）模块
//
// 扫描 data 目录中的 events-<sessionId>.jsonl 事件日志，切分出「已结束场次」
// （session-start → sequence-finished 完整闭合的一段运行），供 /replay.html 复盘。
//
// 只读保证：本模块只用 fs.readFileSync 读取日志，绝不打开写流、绝不追加/修改
// 事件日志，也绝不引用或修改 server.js 中当前演出的内存状态 state。
//
// 健壮性保证：逐行解析 JSONL，任何一行损坏（非法 JSON / 字段缺失等）只产生
// 一条告警并跳过该行，其余行照常解析，整场复盘绝不因一行坏数据中断。
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_SEC = 30;
const MAX_RAW_WARNING = 200; // 告警中保留的坏行原文长度
const FILE_RE = /^events-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidFileId(fileId) {
  return typeof fileId === 'string' && UUID_RE.test(fileId);
}

// 与前端 public/replay.js 中保持同一套岗位提取口径：
// 事件涉及的岗位可能出现在 position / from / to / missing / targets 等字段
function eventPositions(event) {
  const d = (event && event.detail) || {};
  const positions = new Set();
  const addOne = (v) => { const p = String(v || '').trim(); if (p) positions.add(p); };
  if (d.position) addOne(d.position);
  if (d.from) addOne(d.from);
  if (d.to) addOne(d.to);
  if (Array.isArray(d.targets)) d.targets.forEach(addOne);
  if (Array.isArray(d.missing)) d.missing.forEach(addOne);
  return [...positions];
}

// 逐行解析单个 JSONL 日志文件。
// 返回 { events, warnings }：
//   events  —— 成功解析的记录，保持文件中的先后顺序（因果顺序，绝不按时间戳重排）
//   warnings —— 损坏记录告警 [{ line, reason, raw }]
function parseLogFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const events = [];
  const warnings = [];
  const lines = text.split('\n');

  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    const trimmed = rawLine.trim();
    if (trimmed === '') return; // 文件末尾换行等空白行：静默跳过，不属于损坏记录

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

// 把逐行事件切分为「已结束场次」（运行段）：
//   - session-start 开启一段运行，sequence-finished 闭合；只有闭合的段才算已结束场次
//   - session-start 后未等到 sequence-finished 就遇到 session-reset / 下一次
//     session-start（异常中断 / 重置）的段是未完成运行，不列入复盘
//   - 段内遇到 cue-started 时按 seq 登记口令（同一 seq 的修订重发不新增口令），
//     口令以首次 cue-started 的文本/目标为该场冻结快照（修订后的文本只反映在事件流中）
//   - timeoutSec 取本场开始前最近一次 sequence-set / draft-published 携带的确认时限
function segmentRuns(parsed) {
  const runs = [];
  let current = null;
  let lastTimeoutSec = DEFAULT_TIMEOUT_SEC;

  for (const e of parsed.events) {
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
      const seq = Number(e.detail && e.detail.seq);
      if (Number.isInteger(seq) && seq > 0 && !current.cues.has(seq)) {
        const text = String((e.detail && e.detail.text) || '').trim();
        const targets = Array.isArray(e.detail && e.detail.targets)
          ? [...new Set(e.detail.targets.map((t) => String(t).trim()).filter(Boolean))]
          : [];
        current.cues.set(seq, { seq, text, targets });
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

function runSummary(fileId, runId, run) {
  const cueCount = run.cues.size;
  return {
    fileId,
    runId,
    startedAt: run.start.iso,
    finishedAt: run.finish.iso,
    durationMs: run.finish.ts - run.start.ts,
    cueCount,
    eventCount: run.events.length,
    timeoutSec: run.timeoutSec,
  };
}

// GET /api/replay/sessions：列出全部已结束场次（按开始时间倒序）+ 各文件坏数据告警汇总
function listSessions(dataDir) {
  let files = [];
  try {
    files = fs.readdirSync(dataDir);
  } catch {
    files = [];
  }
  const sessions = [];
  const fileWarnings = {};

  for (const name of files) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const fileId = m[1];
    let parsed;
    try {
      parsed = parseLogFile(path.join(dataDir, name));
    } catch (err) {
      // 单个文件读取失败不影响其余场次列出
      fileWarnings[fileId] = { count: 1, samples: [{ line: 0, reason: `文件读取失败：${err.message}`, raw: '' }] };
      continue;
    }
    if (parsed.warnings.length > 0) {
      fileWarnings[fileId] = {
        count: parsed.warnings.length,
        samples: parsed.warnings.slice(0, 3),
      };
    }
    const runs = segmentRuns(parsed);
    runs.forEach((run, runId) => sessions.push(runSummary(fileId, runId, run)));
  }

  sessions.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return { sessions, fileWarnings };
}

// GET /api/replay/sessions/:fileId/:runId：返回单场的全部事件（时间轴 + 确定性重放数据源）
function getSession(dataDir, fileId, runId) {
  if (!isValidFileId(fileId)) return { error: 'badId' };
  const filePath = path.join(dataDir, `events-${fileId}.jsonl`);
  let parsed;
  try {
    parsed = parseLogFile(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { error: 'notFound' };
    return { error: 'readFailed', message: err.message };
  }
  const runs = segmentRuns(parsed);
  const id = Number(runId);
  if (!Number.isInteger(id) || id < 0 || id >= runs.length) return { error: 'notFound' };

  const run = runs[id];
  const startTs = run.start.ts;
  const events = run.events.map((e) => ({
    line: e.line,
    ts: e.iso,
    t: e.ts - startTs, // 相对本场起点的毫秒偏移：时间轴与确定性重放的唯一时间基准
    event: e.event,
    detail: e.detail,
    positions: eventPositions(e),
  }));
  const sequence = [...run.cues.values()].sort((a, b) => a.seq - b.seq);

  // 只返回本场行区间内的坏数据告警；区间外的坏行不影响本场
  const warnings = parsed.warnings.filter(
    (w) => w.line >= run.start.line && w.line <= run.finish.line
  );
  // 按事件流中首次出现的顺序收集岗位（与时间轴先后一致，避免按字符集排序带来的歧义）
  const positions = [];
  const seenPos = new Set();
  events.forEach((e) => e.positions.forEach((p) => {
    if (!seenPos.has(p)) { seenPos.add(p); positions.push(p); }
  }));

  return {
    session: runSummary(fileId, id, run),
    timeoutSec: run.timeoutSec,
    sequence,
    events,
    positions,
    warnings,
    fileWarningCount: parsed.warnings.length,
  };
}

module.exports = { listSessions, getSession, parseLogFile, segmentRuns, eventPositions, isValidFileId };
