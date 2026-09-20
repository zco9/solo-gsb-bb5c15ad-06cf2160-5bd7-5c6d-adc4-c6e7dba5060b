'use strict';

// ---------------------------------------------------------------------------
// 演出复盘（只读）模块 —— Node 侧适配层
//
// 逐行解析、场次切分与「场次 / 口令 / 轮次」折叠模型全部位于与浏览器共用的
// 纯函数内核 public/core.js（CueCore）；本模块只承担 Node 环境职责：
//   - 扫描 data 目录、读取 events-<sessionId>.jsonl 文件；
//   - 组装 GET 接口响应（相对偏移 t、岗位聚合、区间告警）。
//
// 只读保证：本模块只用 fs.readFileSync 读取日志，绝不打开写流、绝不追加/修改
// 事件日志，也绝不引用或修改 server.js 中当前演出的内存状态 state。
//
// 健壮性保证：逐行解析 JSONL，任何一行损坏（非法 JSON / 字段缺失等）只产生
// 一条告警并跳过该行，其余行照常解析，整场复盘绝不因一行坏数据中断
// （策略实现在 CueCore.parseLogText，复盘 / 对比 / 归档 / 延迟诊断共用）。
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { CueCore } = require('./public/core');

const DEFAULT_TIMEOUT_SEC = CueCore.DEFAULT_TIMEOUT_SEC;
const FILE_RE = /^events-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const isValidFileId = CueCore.isValidFileId;
const eventPositions = CueCore.eventPositions;

// 逐行解析单个 JSONL 日志文件。
// 返回 { events, warnings }（字段口径同 CueCore.parseLogText）：
//   events  —— 成功解析的记录，保持文件中的先后顺序（因果顺序，绝不按时间戳重排）
//   warnings —— 损坏记录告警 [{ line, reason, raw }]
function parseLogFile(filePath) {
  return CueCore.parseLogText(fs.readFileSync(filePath, 'utf8'));
}

// 把逐行事件切分为「已结束场次」（运行段）；实现与口径见 CueCore.segmentEvents。
function segmentRuns(parsed) {
  return CueCore.segmentEvents(parsed.events);
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

module.exports = {
  listSessions,
  getSession,
  parseLogFile,
  segmentRuns,
  eventPositions,
  isValidFileId,
  DEFAULT_TIMEOUT_SEC,
};
