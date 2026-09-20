'use strict';

// ---------------------------------------------------------------------------
// 可验证复盘归档（只读）模块
//
// 在「演出复盘」已切分好的已结束场次（session-start → sequence-finished）
// 之上，导出单个 JSON 归档包：格式版本、场次摘要、冻结序列、有效事件
// （保持日志行序）与逐行告警，并对事件流构造 SHA-256 哈希链：
//
//   h0 = 32 字节零值
//   hi = SHA-256(h(i-1) 字节串接 当前事件的 canonical JSON UTF-8 字节)
//
// canonical JSON：对象键递归排序（UTF-16 码元序）、数组保序、UTF-8 编码。
// manifest 保存事件数与最终摘要（hex），供任何第三方独立重算校验。
//
// 只读保证：本模块仅经 replay.js 的只读解析器读取 data 目录事件日志，
// 绝不打开写流、绝不追加/修改事件日志，不引用 server.js 的当前演出状态，
// 也不连接或广播 WebSocket。
//
// 一致性保证：canonicalJson 与前端 public/archive.js 中的实现为同一算法、
// 同一 JS 语义（键序、数字与字符串序列化均按 ECMAScript 规范），浏览器
// 本地校验重算出的哈希链与服务端导出逐字节一致（test/archive.js 交叉验证）。
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const path = require('path');
const replay = require('./replay');

const FORMAT = 'cue-archive'; // 归档格式标识
const VERSION = 1; // 归档格式版本

// canonical JSON 编码：对象键递归排序（默认 sort 为 UTF-16 码元序）、数组保序。
// 输入必须来自 JSON 可表示的数据（事件日志记录即如此）；非有限数字与
// undefined / 函数等不可表示类型直接抛错，绝不静默写成别的字节。
function canonicalJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonical JSON 不支持非有限数字');
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`canonical JSON 不支持的类型：${typeof value}`);
  }
}

// 事件哈希链：h0 为 32 字节零值；hi = SHA-256(h(i-1) ‖ canonical(event) UTF-8)。
// 事件按日志行序依次入链；返回最终摘要的十六进制串（空事件流即 h0 的 hex）。
function chainDigestHex(events) {
  let h = Buffer.alloc(32); // h0：32 字节零值
  for (const ev of events) {
    const evBytes = Buffer.from(canonicalJson(ev), 'utf8');
    h = crypto.createHash('sha256').update(Buffer.concat([h, evBytes])).digest();
  }
  return h.toString('hex');
}

// GET /api/archive/sessions/:fileId/:runId
// 复用 replay.js 的只读解析器切分已结束场次；fileId 同样强制 UUID 形状。
function buildArchive(dataDir, fileId, runId) {
  if (!replay.isValidFileId(fileId)) return { error: 'badId' };
  const filePath = path.join(dataDir, `events-${fileId}.jsonl`);
  let parsed;
  try {
    parsed = replay.parseLogFile(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { error: 'notFound' };
    return { error: 'readFailed', message: err.message };
  }
  const runs = replay.segmentRuns(parsed);
  const id = Number(runId);
  if (!Number.isInteger(id) || id < 0 || id >= runs.length) return { error: 'notFound' };
  const run = runs[id];

  // 有效事件：保持日志行序，原样保留每条记录的 ts / event / detail（哈希链即对其构造）
  const events = run.events.map((e) => ({ ts: e.iso, event: e.event, detail: e.detail }));
  // 冻结序列：本场首次 cue-started 登记的口令快照（修订后的文本只反映在事件流中）
  const sequence = [...run.cues.values()].sort((a, b) => a.seq - b.seq);
  // 逐行告警：仅本场行区间内的坏行；区间外的坏行不属于本归档
  const warnings = parsed.warnings.filter(
    (w) => w.line >= run.start.line && w.line <= run.finish.line
  );

  return {
    archive: {
      format: FORMAT,
      version: VERSION,
      session: {
        fileId,
        runId: id,
        startedAt: run.start.iso,
        finishedAt: run.finish.iso,
        durationMs: run.finish.ts - run.start.ts,
        cueCount: run.cues.size,
        eventCount: events.length,
        timeoutSec: run.timeoutSec,
      },
      sequence,
      events,
      warnings,
      manifest: {
        eventCount: events.length,
        digest: chainDigestHex(events),
      },
    },
  };
}

module.exports = { FORMAT, VERSION, canonicalJson, chainDigestHex, buildArchive };
