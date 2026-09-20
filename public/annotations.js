/* 复盘批注簿前端：批注的本地存储、事件指纹锚点、失效重定位与 JSON 导入导出。
 *
 * 纯本地 / 只读保证：
 *   - 批注只保存在本浏览器的 IndexedDB（库名 cue-annotations），本文件不创建
 *     WebSocket、不调用任何写接口；场次数据仅经复盘只读 GET 接口拉取；
 *   - 导出为本地生成的 JSON 文件下载，导入只在本地解析用户选择的文件，
 *     绝不上传到服务器。
 *
 * 锚点指纹：区间首尾锚点记录事件（ts / event / detail 三字段，与复盘接口及
 * 归档包中的有效事件口径一致）canonical JSON 的 SHA-256（hex）以及该指纹在
 * 本场事件序列中的出现序号（1 基）。canonical JSON 规则与归档模块逐字节一致：
 * 对象键递归排序（UTF-16 码元序）、数组保序、UTF-8。
 *
 * 重定位：重新载入日志后按指纹 + 序号重新定位；找不到指纹，或重新定位后
 * 终点在起点之前（顺序倒置），批注标记为失效（valid:false + reason），
 * 原文（批注文本、标签、失效原因与原时间信息）完整保留。
 */
'use strict';

const CueAnnotations = (() => {
  const FORMAT = 'cue-annotations'; // 导出文件格式标识
  const VERSION = 1; // 导出文件格式版本
  const DB_NAME = 'cue-annotations';
  const DB_VERSION = 1;
  const STORE = 'annotations';

  // -------------------------------------------------------------------------
  // canonical JSON 与 SHA-256：与 public/archive.js（及服务端 archive.js）
  // 为同一算法、同一 JS 语义，保证指纹与归档哈希链编码口径一致。
  // -------------------------------------------------------------------------
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

  function toHex(bytes) {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  // 事件指纹：仅对事件内容三字段 {ts,event,detail} 做 canonical JSON 后取 SHA-256。
  // 不包含 t / line / positions 等派生展示字段，使同一日志无论从哪个只读接口
  // （复盘、归档）取得，指纹都一致。
  function eventDigest(ev) {
    const canonical = canonicalJson({ ts: ev.ts, event: ev.event, detail: ev.detail || {} });
    return digestHex(canonical);
  }

  async function digestHex(canonicalString) {
    const subtle = (typeof crypto !== 'undefined' && crypto && crypto.subtle)
      || (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle);
    if (!subtle) throw new Error('当前环境不支持 Web Crypto（请通过 localhost 或 HTTPS 访问页面）');
    const bytes = new TextEncoder().encode(canonicalString);
    const out = await subtle.digest('SHA-256', bytes);
    return toHex(new Uint8Array(out));
  }

  // -------------------------------------------------------------------------
  // 指纹出现序号表：遍历本场事件（日志行序），记录每个指纹第 n 次出现对应的
  // 事件索引，返回 { counts: Map(digest -> 出现次数), ordinals: Map(digest#n -> idx) }。
  // 序号为 1 基；同一事件重复出现时用序号消歧，重载日志后仍能定位到「同一行」。
  // -------------------------------------------------------------------------
  // Web Crypto 的 SHA-256 为异步，本表构造同样为异步；digests 为与事件数组等长、
  // 按下标对齐的指纹数组。
  async function buildOccurrenceTable(events) {
    const counts = new Map();
    const ordinals = new Map();
    const digests = new Array(events.length);
    for (let idx = 0; idx < events.length; idx++) {
      const d = await eventDigest(events[idx]);
      digests[idx] = d;
      const n = (counts.get(d) || 0) + 1;
      counts.set(d, n);
      ordinals.set(`${d}#${n}`, idx);
    }
    return { counts, ordinals, digests };
  }

  // 单个锚点重定位：按指纹 + 出现序号回到当前事件序列中的索引。
  // 返回 { ok:true, index } 或 { ok:false, reason }。
  function locateAnchor(anchor, table) {
    if (!anchor || typeof anchor.digest !== 'string' || !/^[0-9a-f]{64}$/.test(anchor.digest)) {
      return { ok: false, reason: '锚点缺少合法的事件指纹' };
    }
    const total = table.counts.get(anchor.digest) || 0;
    if (!total) return { ok: false, reason: '指纹事件在重载后的日志中找不到（日志可能已变更）' };
    const ordinal = Number(anchor.ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      return { ok: false, reason: '锚点记录的指纹出现序号不合法' };
    }
    if (ordinal > total) {
      return { ok: false, reason: `指纹事件仅出现 ${total} 次，锚点记录的是第 ${ordinal} 次（日志可能已变更）` };
    }
    return { ok: true, index: table.ordinals.get(`${anchor.digest}#${ordinal}`) };
  }

  // 重定位整条批注：首尾都要找到，且终点不得在起点之前（顺序倒置即失效）。
  // 返回 { valid, reason?, startIndex?, endIndex?, startT?, endT? }；
  // 失效时不带索引，调用方保留批注原文并按存储的 startT/endT 展示历史区间。
  function relocalize(annotation, table) {
    const a = locateAnchor(annotation.start, table);
    if (!a.ok) return { valid: false, reason: `起点${a.reason}` };
    const b = locateAnchor(annotation.end, table);
    if (!b.ok) return { valid: false, reason: `终点${b.reason}` };
    if (b.index < a.index) {
      return { valid: false, reason: `顺序倒置：终点事件（行序 ${b.index + 1}）出现在起点事件（行序 ${a.index + 1}）之前` };
    }
    return { valid: true, startIndex: a.index, endIndex: b.index };
  }

  // -------------------------------------------------------------------------
  // 标签与批注构造
  // -------------------------------------------------------------------------
  // 标签输入：逗号 / 顿号 / 分号 / 空白分隔，去空白、去重、保序；
  // 数组输入时每个元素仍按同样分隔符拆分（防止 "a,b" 成为一个标签）
  function normalizeTags(input) {
    const raw = input == null ? '' : input;
    const parts = Array.isArray(raw)
      ? raw.flatMap((v) => String(v).split(/[,，、;；\s]+/))
      : String(raw).split(/[,，、;；\s]+/);
    const out = [];
    const seen = new Set();
    for (const p of parts) {
      const t = String(p).trim();
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out;
  }

  function makeId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `ann-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  // 由圈定结果构造一条批注记录（不做校验，调用前应已保证 startIdx <= endIdx）。
  // sessionRef 为 { fileId, runId, startedAt, finishedAt }；
  // start/end 为事件数组中的索引；startT/endT 为相对本场起点的毫秒偏移。
  async function buildAnnotation(opts) {
    const { events, sessionRef, startIndex, endIndex, text, tags } = opts;
    const table = opts.table || await buildOccurrenceTable(events);
    const sEv = events[startIndex];
    const eEv = events[endIndex];
    return {
      id: makeId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionRef: {
        fileId: sessionRef.fileId,
        runId: sessionRef.runId,
        startedAt: sessionRef.startedAt || null,
        finishedAt: sessionRef.finishedAt || null,
      },
      start: { digest: table.digests[startIndex], ordinal: countBefore(table, startIndex) },
      end: { digest: table.digests[endIndex], ordinal: countBefore(table, endIndex) },
      startEvent: snapshotEvent(sEv),
      endEvent: snapshotEvent(eEv),
      startT: sEv.t,
      endT: eEv.t,
      text: String(text == null ? '' : text),
      tags: normalizeTags(tags),
      valid: true,
      invalidReason: null,
      conflict: false,
      conflictGroup: null,
    };
  }

  // 该指纹在 idx（含）之前第几次出现（1 基）
  function countBefore(table, idx) {
    const d = table.digests[idx];
    let n = 0;
    for (let i = 0; i <= idx; i++) if (table.digests[i] === d) n++;
    return n;
  }

  // 锚点旁保留的事件原文摘要（失效时仍可看到圈定的是什么事件；只保留三字段）
  function snapshotEvent(ev) {
    return { ts: ev.ts, event: ev.event, detail: ev.detail || {} };
  }

  // -------------------------------------------------------------------------
  // 内容等价：id / 时间戳 / 有效性 / 冲突标记之外的用户内容与锚点完全一致。
  // 导入合并时「内容一致去重」即按此判断（canonical 字符串比较，无字段序歧义）。
  // -------------------------------------------------------------------------
  function contentKey(a) {
    return canonicalJson({
      sessionRef: a.sessionRef,
      start: a.start,
      end: a.end,
      startT: a.startT,
      endT: a.endT,
      text: a.text,
      tags: Array.isArray(a.tags) ? a.tags : [],
    });
  }
  function sameContent(a, b) { return contentKey(a) === contentKey(b); }

  // 规范化导入记录：仅挑取可持久化字段，补齐缺省值；不合法返回 null。
  function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const isDigest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
    const isAnchor = (v) => v && typeof v === 'object' && isDigest(v.digest) &&
      Number.isInteger(Number(v.ordinal)) && Number(v.ordinal) >= 1;
    if (typeof raw.id !== 'string' || raw.id === '') return null;
    const ref = raw.sessionRef;
    if (!ref || typeof ref !== 'object' || typeof ref.fileId !== 'string' ||
        !Number.isInteger(Number(ref.runId))) return null;
    if (!isAnchor(raw.start) || !isAnchor(raw.end)) return null;
    return {
      id: raw.id,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
      sessionRef: {
        fileId: ref.fileId,
        runId: Number(ref.runId),
        startedAt: typeof ref.startedAt === 'string' ? ref.startedAt : null,
        finishedAt: typeof ref.finishedAt === 'string' ? ref.finishedAt : null,
      },
      start: { digest: raw.start.digest, ordinal: Number(raw.start.ordinal) },
      end: { digest: raw.end.digest, ordinal: Number(raw.end.ordinal) },
      startEvent: raw.startEvent && typeof raw.startEvent === 'object' ? raw.startEvent : null,
      endEvent: raw.endEvent && typeof raw.endEvent === 'object' ? raw.endEvent : null,
      startT: Number.isFinite(Number(raw.startT)) ? Number(raw.startT) : null,
      endT: Number.isFinite(Number(raw.endT)) ? Number(raw.endT) : null,
      text: typeof raw.text === 'string' ? raw.text : '',
      tags: normalizeTags(Array.isArray(raw.tags) ? raw.tags : []),
      valid: true,
      invalidReason: null,
      conflict: raw.conflict === true,
      conflictGroup: typeof raw.conflictGroup === 'string' ? raw.conflictGroup : null,
    };
  }

  // -------------------------------------------------------------------------
  // 导入合并（纯函数，不触碰 IndexedDB）：existing 为库中现有记录，incoming
  // 为导入文件中的记录（已规范化）。按批注 id 合并：
  //   - 库中无同 id（或同 id 仅内容一致的已去重副本）：直接插入；
  //   - 同 id 且内容一致：去重，跳过；
  //   - 同 id 但内容不同：两份都保留，导入份改 id（<原id>#imp[-n]），双方都
  //     明确打上冲突标记并归入同一 conflictGroup（原 id）。
  // 返回 { records, stats:{ added, duplicated, conflicts, invalid, groups:Map } }。
  // records 为合并后的完整记录数组（现有 + 新增），调用方整体写回存储。
  // -------------------------------------------------------------------------
  function mergeAnnotations(existing, incoming) {
    const records = existing.map((r) => ({ ...r, tags: [...(r.tags || [])] }));
    const byId = new Map(records.map((r) => [r.id, r]));
    // 冲突组键：已在冲突中的记录沿用其组，否则用自身 id
    const groupKeyOf = (r) => r.conflictGroup || r.id;
    const groupMembers = new Map();
    records.forEach((r) => {
      const g = groupKeyOf(r);
      if (!groupMembers.has(g)) groupMembers.set(g, []);
      groupMembers.get(g).push(r);
    });

    const stats = { added: 0, duplicated: 0, conflicts: 0, invalid: 0, groups: new Map() };
    const usedIds = new Set(records.map((r) => r.id));

    const flagConflict = (rec, group) => {
      rec.conflict = true;
      rec.conflictGroup = group;
      if (!stats.groups.has(group)) stats.groups.set(group, []);
    };

    for (const rawIn of incoming) {
      const rec = normalizeRecord(rawIn);
      if (!rec) { stats.invalid++; continue; }

      // 同组内（按冲突组键）已有内容一致的副本：去重（含冲突组内的重复导入）
      const ownGroup = rec.conflictGroup || rec.id;
      const members = groupMembers.get(ownGroup) || [];
      if (members.some((m) => sameContent(m, rec))) { stats.duplicated++; continue; }

      const exact = byId.get(rec.id);
      if (!exact) {
        // 库中无此 id：保留原冲突标记；新 id 插入
        const toInsert = { ...rec };
        if (toInsert.conflict) flagConflict(toInsert, ownGroup);
        records.push(toInsert);
        byId.set(toInsert.id, toInsert);
        usedIds.add(toInsert.id);
        if (!groupMembers.has(ownGroup)) groupMembers.set(ownGroup, []);
        groupMembers.get(ownGroup).push(toInsert);
        if (toInsert.conflict) stats.groups.get(ownGroup).push(toInsert.id);
        stats.added++;
        continue;
      }

      if (sameContent(exact, rec)) {
        // 同 id 内容一致：去重。若导入份带冲突标记而库中份没有，补标并归组
        if (rec.conflict && !exact.conflict) {
          flagConflict(exact, ownGroup);
          groupMembers.has(ownGroup) || groupMembers.set(ownGroup, [exact]);
          stats.groups.get(ownGroup).push(exact.id);
        }
        stats.duplicated++;
        continue;
      }

      // 同 id 内容不同：两份都保留，全部明确标冲突，归入同一冲突组（原 id）
      const group = exact.conflictGroup || exact.id;
      flagConflict(exact, group);
      let n = 1;
      let newId = `${rec.id}#imp`;
      while (usedIds.has(newId)) { n++; newId = `${rec.id}#imp-${n}`; }
      const copy = { ...rec, id: newId, conflict: true, conflictGroup: group };
      records.push(copy);
      byId.set(copy.id, copy);
      usedIds.add(copy.id);
      if (!groupMembers.has(group)) groupMembers.set(group, []);
      const gMembers = groupMembers.get(group);
      if (!gMembers.includes(exact)) gMembers.push(exact);
      gMembers.push(copy);
      stats.conflicts++;
      stats.added++;
      if (!stats.groups.has(group)) stats.groups.set(group, []);
      const gm = stats.groups.get(group);
      if (!gm.includes(exact.id)) gm.push(exact.id);
      gm.push(copy.id);
    }

    return { records, stats };
  }

  // -------------------------------------------------------------------------
  // 导出文件
  // -------------------------------------------------------------------------
  function buildExportPayload(annotations) {
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      count: annotations.length,
      annotations: annotations.map((a) => ({
        id: a.id,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        sessionRef: a.sessionRef,
        start: a.start,
        end: a.end,
        startEvent: a.startEvent || null,
        endEvent: a.endEvent || null,
        startT: a.startT,
        endT: a.endT,
        text: a.text,
        tags: a.tags || [],
        conflict: a.conflict === true,
        conflictGroup: a.conflictGroup || null,
      })),
    };
  }

  // 解析导入文件：校验格式标识 / 版本 / 批注数组，返回 { ok, annotations?, error? }
  function parseImportPayload(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, error: '文件不是 JSON 对象' };
    }
    if (obj.format !== FORMAT) {
      return { ok: false, error: `格式标识缺失或不支持（应为 "${FORMAT}"）` };
    }
    if (obj.version !== VERSION) {
      return { ok: false, error: `格式版本不支持（应为 ${VERSION}）` };
    }
    if (!Array.isArray(obj.annotations)) {
      return { ok: false, error: '缺少 annotations 数组' };
    }
    const annotations = [];
    let invalid = 0;
    for (const raw of obj.annotations) {
      const rec = normalizeRecord(raw);
      if (rec) annotations.push(rec);
      else invalid++;
    }
    return { ok: true, annotations, invalid };
  }

  // -------------------------------------------------------------------------
  // IndexedDB 存储（批注只存浏览器本地，无任何服务端写操作）
  // -------------------------------------------------------------------------
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
  }

  function txAll(db, mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async function getAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = txAll(db, 'readonly').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function putAll(records) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      records.forEach((r) => store.put(r));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('写入被中止'));
    });
  }

  async function put(record) { return putAll([record]); }

  async function remove(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return {
    FORMAT,
    VERSION,
    canonicalJson,
    eventDigest,
    digestHex,
    buildOccurrenceTable,
    locateAnchor,
    relocalize,
    normalizeTags,
    makeId,
    buildAnnotation,
    snapshotEvent,
    sameContent,
    contentKey,
    normalizeRecord,
    mergeAnnotations,
    buildExportPayload,
    parseImportPayload,
    // IndexedDB
    getAll,
    put,
    putAll,
    remove,
    clearAll,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CueAnnotations };
}
