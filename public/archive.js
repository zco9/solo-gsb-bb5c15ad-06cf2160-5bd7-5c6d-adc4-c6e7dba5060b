/* 可验证复盘归档前端：canonical JSON、SHA-256 哈希链重算与归档本地校验。
 *
 * 纯本地保证：verify() 只在浏览器内解析用户选择的归档文件并重算校验，
 * 文件绝不上传到服务器；本文件不创建 WebSocket、不发起任何网络请求。
 *
 * 算法与服务端 archive.js 逐字节一致（同一 JS 语义）：
 *   canonical JSON —— 对象键递归排序（UTF-16 码元序）、数组保序、UTF-8 编码；
 *   哈希链 —— h0 为 32 字节零值，hi = SHA-256(h(i-1) 字节串接当前事件字节)。
 */
'use strict';

const CueArchive = (() => {
  const FORMAT = 'cue-archive'; // 归档格式标识
  const VERSION = 1; // 归档格式版本

  // canonical JSON 编码：对象键递归排序（默认 sort 为 UTF-16 码元序）、数组保序
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

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  function toHex(bytes) {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  async function sha256(bytes) {
    const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle;
    if (!subtle) throw new Error('当前环境不支持 Web Crypto（请通过 localhost 或 HTTPS 访问页面）');
    return new Uint8Array(await subtle.digest('SHA-256', bytes));
  }

  // 事件哈希链：h0 为 32 字节零值；hi = SHA-256(h(i-1) ‖ canonical(event) UTF-8)。
  // 事件按数组顺序（即日志行序）依次入链；返回最终摘要的十六进制串。
  async function chainDigest(events) {
    let h = new Uint8Array(32); // h0：32 字节零值
    for (const ev of events) {
      const evBytes = utf8(canonicalJson(ev));
      const joined = new Uint8Array(h.length + evBytes.length);
      joined.set(h, 0);
      joined.set(evBytes, h.length);
      h = await sha256(joined);
    }
    return toHex(h);
  }

  // -------------------------------------------------------------------------
  // 归档本地校验：逐项重算并校验场次边界、事件数与哈希链摘要。
  // 失败：{ ok:false, error:{ message, index?, field? } }——index 为首个问题
  // 事件在 events 中的索引（0 基），field 为首个问题字段路径；
  // 成功：{ ok:true, summary }——summary 为归档摘要（场次、计数与最终摘要）。
  // -------------------------------------------------------------------------
  async function verify(archive) {
    const fail = (message, loc) => ({ ok: false, error: Object.assign({ message }, loc) });
    const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

    // 1) 顶层结构：格式标识与版本
    if (!isPlainObject(archive)) return fail('归档不是 JSON 对象', { field: '(root)' });
    if (archive.format !== FORMAT) {
      return fail(`格式标识缺失或不支持（应为 "${FORMAT}"，实际为 ${JSON.stringify(archive.format ?? null)}）`, { field: 'format' });
    }
    if (archive.version !== VERSION) {
      return fail(`格式版本不支持（应为 ${VERSION}，实际为 ${JSON.stringify(archive.version ?? null)}）`, { field: 'version' });
    }

    // 2) 场次摘要字段
    const s = archive.session;
    if (!isPlainObject(s)) return fail('缺少场次摘要 session 对象', { field: 'session' });
    if (typeof s.fileId !== 'string' || s.fileId === '') {
      return fail('场次摘要缺少合法的 fileId', { field: 'session.fileId' });
    }
    if (!Number.isInteger(s.runId) || s.runId < 0) {
      return fail('场次摘要缺少合法的 runId', { field: 'session.runId' });
    }
    const startMs = Date.parse(s.startedAt);
    if (!Number.isFinite(startMs)) return fail('场次摘要 startedAt 不是合法时间', { field: 'session.startedAt' });
    const finishMs = Date.parse(s.finishedAt);
    if (!Number.isFinite(finishMs)) return fail('场次摘要 finishedAt 不是合法时间', { field: 'session.finishedAt' });
    if (typeof s.durationMs !== 'number' || !Number.isFinite(s.durationMs) || s.durationMs < 0) {
      return fail('场次摘要 durationMs 不合法', { field: 'session.durationMs' });
    }
    if (!Number.isInteger(s.cueCount) || s.cueCount < 0) {
      return fail('场次摘要 cueCount 不合法', { field: 'session.cueCount' });
    }
    if (!Number.isInteger(s.eventCount) || s.eventCount < 0) {
      return fail('场次摘要 eventCount 不合法', { field: 'session.eventCount' });
    }
    if (typeof s.timeoutSec !== 'number' || !(s.timeoutSec > 0)) {
      return fail('场次摘要 timeoutSec 不合法', { field: 'session.timeoutSec' });
    }

    // 3) 冻结序列
    if (!Array.isArray(archive.sequence)) return fail('缺少冻结序列 sequence 数组', { field: 'sequence' });
    for (let i = 0; i < archive.sequence.length; i++) {
      const c = archive.sequence[i];
      const f = `sequence[${i}]`;
      if (!isPlainObject(c)) return fail('冻结序列条目不是对象', { field: f });
      if (!Number.isInteger(c.seq) || c.seq <= 0) return fail('冻结序列条目缺少合法的 seq', { field: `${f}.seq` });
      if (typeof c.text !== 'string') return fail('冻结序列条目缺少合法的 text', { field: `${f}.text` });
      if (!Array.isArray(c.targets) || c.targets.some((t) => typeof t !== 'string')) {
        return fail('冻结序列条目 targets 不是字符串数组', { field: `${f}.targets` });
      }
    }
    if (s.cueCount !== archive.sequence.length) {
      return fail(`场次摘要口令数（${s.cueCount}）与冻结序列条数（${archive.sequence.length}）不一致`, { field: 'session.cueCount' });
    }

    // 4) 有效事件结构（首个问题事件即定位其索引与字段）
    if (!Array.isArray(archive.events)) return fail('缺少有效事件 events 数组', { field: 'events' });
    const events = archive.events;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const f = `events[${i}]`;
      if (!isPlainObject(e)) return fail('事件不是 JSON 对象', { index: i, field: f });
      if (!Number.isFinite(Date.parse(e.ts))) return fail('事件缺少合法的 ts 时间戳', { index: i, field: `${f}.ts` });
      if (typeof e.event !== 'string' || e.event === '') return fail('事件缺少合法的 event 字段', { index: i, field: `${f}.event` });
      if (!isPlainObject(e.detail)) return fail('事件 detail 字段不是对象', { index: i, field: `${f}.detail` });
    }

    // 5) 场次边界：session-start 开场、sequence-finished 闭合，场中不得再出现边界事件
    if (events.length < 2) {
      return fail('事件数不足：已结束场次至少包含 session-start 与 sequence-finished 两条边界事件', { field: 'events' });
    }
    if (events[0].event !== 'session-start') {
      return fail(`场次边界缺失：首个事件应为 session-start，实际为 ${events[0].event}`, { index: 0, field: 'events[0].event' });
    }
    if (events[0].ts !== s.startedAt) {
      return fail(`场次边界不一致：首个事件时间（${events[0].ts}）与 session.startedAt（${s.startedAt}）不符`, { index: 0, field: 'events[0].ts' });
    }
    const lastIdx = events.length - 1;
    if (events[lastIdx].event !== 'sequence-finished') {
      return fail(`场次边界缺失：末个事件应为 sequence-finished，实际为 ${events[lastIdx].event}`, { index: lastIdx, field: `events[${lastIdx}].event` });
    }
    if (events[lastIdx].ts !== s.finishedAt) {
      return fail(`场次边界不一致：末个事件时间（${events[lastIdx].ts}）与 session.finishedAt（${s.finishedAt}）不符`, { index: lastIdx, field: `events[${lastIdx}].ts` });
    }
    for (let i = 1; i < lastIdx; i++) {
      if (events[i].event === 'session-start' || events[i].event === 'sequence-finished' || events[i].event === 'session-reset') {
        return fail(`场次边界被破坏：场中出现 ${events[i].event}（仅允许出现在场次首尾或场外）`, { index: i, field: `events[${i}].event` });
      }
    }
    if (s.durationMs !== finishMs - startMs) {
      return fail(`场次摘要 durationMs（${s.durationMs}）与起止时间差（${finishMs - startMs}）不符`, { field: 'session.durationMs' });
    }
    if (s.eventCount !== events.length) {
      return fail(`场次摘要事件数（${s.eventCount}）与有效事件数（${events.length}）不一致`, { field: 'session.eventCount' });
    }

    // 6) 逐行告警结构
    if (!Array.isArray(archive.warnings)) return fail('缺少逐行告警 warnings 数组', { field: 'warnings' });
    for (let i = 0; i < archive.warnings.length; i++) {
      const w = archive.warnings[i];
      const f = `warnings[${i}]`;
      if (!isPlainObject(w)) return fail('告警条目不是对象', { field: f });
      if (!Number.isInteger(w.line) || w.line <= 0) return fail('告警条目缺少合法行号 line', { field: `${f}.line` });
      if (typeof w.reason !== 'string') return fail('告警条目缺少原因 reason', { field: `${f}.reason` });
      if (typeof w.raw !== 'string') return fail('告警条目缺少原文 raw', { field: `${f}.raw` });
    }

    // 7) manifest：事件数与哈希链最终摘要
    const m = archive.manifest;
    if (!isPlainObject(m)) return fail('缺少 manifest 对象', { field: 'manifest' });
    if (m.eventCount !== events.length) {
      return fail(`manifest 事件数（${m.eventCount}）与有效事件数（${events.length}）不一致`, { field: 'manifest.eventCount' });
    }
    if (typeof m.digest !== 'string' || !/^[0-9a-f]{64}$/.test(m.digest)) {
      return fail('manifest.digest 不是 64 位十六进制 SHA-256 摘要', { field: 'manifest.digest' });
    }
    const recomputed = await chainDigest(events);
    if (recomputed !== m.digest) {
      return fail(
        `哈希链摘要不一致：本地重算为 ${recomputed.slice(0, 16)}…，manifest 记录为 ${m.digest.slice(0, 16)}…（事件内容或顺序可能被篡改）`,
        { field: 'manifest.digest' }
      );
    }

    return {
      ok: true,
      summary: {
        format: archive.format,
        version: archive.version,
        session: s,
        cueCount: archive.sequence.length,
        eventCount: events.length,
        warningCount: archive.warnings.length,
        digest: m.digest,
      },
    };
  }

  return { FORMAT, VERSION, canonicalJson, chainDigest, verify };
})();
