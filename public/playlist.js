/* 复盘播放清单前端：清单存储（仅 IndexedDB）、播放前批注重定位与
 * 「虚拟时间轴」的纯函数映射。
 *
 * 纯本地 / 只读保证（与批注簿一致）：
 *   - 清单只保存在本浏览器的 IndexedDB（独立库名 cue-playlists，单例文档），
 *     本文件不创建 WebSocket、不调用任何写接口；场次数据仅经复盘只读 GET
 *     接口拉取；
 *   - 清单项仅引用批注 id（外加加入时的文本快照，便于批注被删后仍可辨认），
 *     批注本体仍全部留在 cue-annotations 库中。
 *
 * 虚拟时间轴：清单条目经播放前重定位后得到若干「播放段」（按清单顺序，可
 * 跨场次、可重叠——重叠区间按顺序分别播放，绝不合并）。每段贡献
 * (endT - startT) 的累计时长；虚拟时间轴上的任意时刻先定位到唯一一段，再
 * 线性映射回该段所属场次的原始相对时刻（localT = startT + (vt - segStart)）。
 * 边界规则：虚拟时刻恰好落在段边界上时进入后一段（零长段除外——零长段只能
 * 通过「定位到本段」的显式跳转呈现）。
 */
'use strict';

const CuePlaylist = (() => {
  const DB_NAME = 'cue-playlists';
  const DB_VERSION = 1;
  const STORE = 'playlist';
  const DOC_ID = 'main'; // 单例：整本「复盘播放清单」为一条文档

  // -------------------------------------------------------------------------
  // 清单文档：{ id, updatedAt, entries: [{ id, addedAt }] }
  // entries 顺序即播放顺序；拖拽排序只改这个数组。
  // -------------------------------------------------------------------------
  function emptyDoc() {
    return { id: DOC_ID, updatedAt: new Date(0).toISOString(), entries: [] };
  }

  function normalizeDoc(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyDoc();
    const seen = new Set();
    const entries = [];
    const list = Array.isArray(raw.entries) ? raw.entries : [];
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const id = String(e.id || '');
      if (!id || seen.has(id)) continue; // 去重：同一批注只能在清单中出现一次
      seen.add(id);
      entries.push({
        id,
        addedAt: typeof e.addedAt === 'string' ? e.addedAt : new Date(0).toISOString(),
      });
    }
    return {
      id: DOC_ID,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
      entries,
    };
  }

  function makeEntry(annotationId) {
    return { id: String(annotationId), addedAt: new Date().toISOString() };
  }

  // -------------------------------------------------------------------------
  // IndexedDB 存储（清单只存浏览器本地，无任何服务端写操作）
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

  async function get() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(DOC_ID);
      req.onsuccess = () => resolve(normalizeDoc(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  async function save(doc) {
    const db = await openDB();
    const clean = normalizeDoc(doc);
    clean.updatedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(clean);
      tx.oncomplete = () => resolve(clean);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('写入被中止'));
    });
  }

  async function clear() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(DOC_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // 便捷操作：读-改-写整本文档（mutator 返回新 entries 或 void）
  async function mutate(fn) {
    const doc = await get();
    const next = fn(doc) || doc.entries;
    return save({ ...doc, entries: next });
  }

  // 追加批注 id 到清单末尾（已存在则保持原位置不重复加入）
  async function addIds(ids) {
    return mutate((doc) => {
      const have = new Set(doc.entries.map((e) => e.id));
      for (const id of ids) {
        const sid = String(id);
        if (!have.has(sid)) { doc.entries.push(makeEntry(sid)); have.add(sid); }
      }
      return doc.entries;
    });
  }

  async function removeId(id) {
    return mutate((doc) => doc.entries.filter((e) => e.id !== String(id)));
  }

  // 直接写入拖拽后的完整 id 顺序（只允许当前清单内 id 的重排，不偷偷新增）
  async function reorder(orderedIds) {
    return mutate((doc) => {
      const byId = new Map(doc.entries.map((e) => [e.id, e]));
      const seen = new Set();
      const next = [];
      for (const id of orderedIds) {
        const sid = String(id);
        if (byId.has(sid) && !seen.has(sid)) { next.push(byId.get(sid)); seen.add(sid); }
      }
      // 未出现在 orderedIds 中的条目追加到末尾（防御性，正常拖拽不会触发）
      for (const e of doc.entries) if (!seen.has(e.id)) next.push(e);
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // 播放前重定位（纯函数部分）：输入清单引用顺序、批注记录与各场次重定位
  // 结果，输出 { segments, skipped }：
  //   segments —— 可播放段，严格保持清单顺序，不按场次归并、不合并重叠：
  //     [{ entryId, fileId, runId, startIndex, endIndex, startT, endT,
  //        durationMs }]
  //   skipped —— 无法播放的条目（批注缺失 / 场次日志缺失 / 批注失效）：
  //     [{ entryId, reason, annotation? }]
  // resolvedMap: annotationId ->
  //     { ok:true,  events, startIndex, endIndex } 或
  //     { ok:false, reason }
  // 其中日志缺失与指纹失效的区分由调用方在构造 resolvedMap 时给出 reason。
  // -------------------------------------------------------------------------
  function resolveEntries(entries, annotationMap, resolvedMap) {
    const segments = [];
    const skipped = [];
    for (const entry of entries) {
      const ann = annotationMap.get(entry.id);
      if (!ann) {
        skipped.push({ entryId: entry.id, reason: '批注记录不存在（可能已从批注簿删除）' });
        continue;
      }
      const res = resolvedMap.get(entry.id);
      if (!res || !res.ok) {
        skipped.push({ entryId: entry.id, reason: (res && res.reason) || '批注重定位失败', annotation: ann });
        continue;
      }
      const startT = res.events[res.startIndex].t;
      const endT = res.events[res.endIndex].t;
      segments.push({
        entryId: entry.id,
        fileId: ann.sessionRef.fileId,
        runId: Number(ann.sessionRef.runId),
        startIndex: res.startIndex,
        endIndex: res.endIndex,
        startT,
        endT,
        durationMs: Math.max(0, endT - startT),
      });
    }
    return { segments, skipped };
  }

  // -------------------------------------------------------------------------
  // 虚拟时间轴映射（纯函数）
  //
  // segments 为 resolveEntries 的输出（顺序即播放顺序）。每段在虚拟轴上占据
  // [offsetStart, offsetEnd)，offsetEnd 为含本段在内的累计时长。
  // 定位规则（恰好落在边界时进入后一段）：
  //   取第一个「严格结束于 vt 之后」的段；都不满足则为最后一段。
  // 于是：vt == 某正长段结束边界 → 进入下一段；正长段内部与起点 → 本段。
  // 零长段（startT == endT）offsetStart == offsetEnd，永不自然命中；
  // 调用方可传 forceIndex（点击该段跳转）临时精确呈现它。
  // -------------------------------------------------------------------------
  function withOffsets(segments) {
    let acc = 0;
    return segments.map((seg) => {
      const offsetStart = acc;
      acc += seg.durationMs;
      return { ...seg, offsetStart, offsetEnd: acc };
    });
  }

  function totalDuration(segmentsWithOffsets) {
    if (!segmentsWithOffsets.length) return 0;
    return segmentsWithOffsets[segmentsWithOffsets.length - 1].offsetEnd;
  }

  function locateIndex(segmentsWithOffsets, vt, forceIndex) {
    const n = segmentsWithOffsets.length;
    if (n === 0) return -1;
    if (Number.isInteger(forceIndex) && forceIndex >= 0 && forceIndex < n) return forceIndex;
    const t = Math.max(0, Math.min(totalDuration(segmentsWithOffsets), Number(vt) || 0));
    for (let i = 0; i < n; i++) {
      if (segmentsWithOffsets[i].offsetEnd > t) return i;
    }
    return n - 1;
  }

  // 虚拟时刻 -> 播放现场：
  // { index, seg, localT, progress, atEnd }
  // forceIndex 仅用于零长段的显式跳转；对正长段强制时按其起点处理。
  function locate(segmentsWithOffsets, vt, forceIndex) {
    const n = segmentsWithOffsets.length;
    if (!n) return null;
    const total = totalDuration(segmentsWithOffsets);
    const t = Math.max(0, Math.min(total, Number(vt) || 0));
    const i = locateIndex(segmentsWithOffsets, t, forceIndex);
    const seg = segmentsWithOffsets[i];
    const forced = Number.isInteger(forceIndex) && forceIndex === i;
    let localT;
    if (seg.durationMs === 0) {
      localT = seg.startT; // 零长段：精确呈现批注起点（=终点）事件
    } else if (forced) {
      localT = seg.startT;
    } else {
      localT = seg.startT + Math.max(0, Math.min(seg.durationMs, t - seg.offsetStart));
    }
    const progress = seg.durationMs > 0
      ? Math.max(0, Math.min(1, (localT - seg.startT) / seg.durationMs))
      : 1;
    return { index: i, seg, localT, progress, atEnd: t >= total && total > 0 };
  }

  // 跳转到某一段的虚拟起点（点击段概览行）；零长段同样可精确呈现
  function segmentStartVt(segmentsWithOffsets, index) {
    const seg = segmentsWithOffsets[index];
    return seg ? seg.offsetStart : 0;
  }

  // 相对当前段跳转 deltaMs 虚拟时间（键盘 ← / →），并返回是否应解除强制段
  function nudge(segmentsWithOffsets, vt, deltaMs) {
    const total = totalDuration(segmentsWithOffsets);
    return { vt: Math.max(0, Math.min(total, (Number(vt) || 0) + deltaMs)), releaseForce: true };
  }

  // 播放前批量重定位的浏览器装配器（异步，含场次缓存）：
  //   entries        —— 清单文档的 entries（或仅 id 数组）
  //   annotations    —— CueAnnotations.getAll() 的结果
  //   loadSession    —— async (fileId, runId) => { ok, events?, reason? }
  // 与批注簿页同一口径：按指纹 + 出现序号重定位；日志缺失 / 指纹找不到 /
  // 顺序倒置都转为 skipped 原因，绝不影响其他条目。
  async function resolvePlaylist(entries, annotations, loadSession) {
    const A = (typeof globalThis !== 'undefined' && globalThis.CueAnnotations) || null;
    if (!A) throw new Error('CueAnnotations 未加载');
    const list = (entries || []).map((e) => (typeof e === 'string' ? { id: e } : e));
    const annotationMap = new Map((annotations || []).map((a) => [a.id, a]));

    // 每个场次只拉一次日志、只建一次指纹表
    const sessionCache = new Map(); // key -> { ok, events?, reason? }
    const tableCache = new Map();   // key -> occurrence table
    async function sessionFor(fileId, runId) {
      const key = `${fileId}/${runId}`;
      if (!sessionCache.has(key)) sessionCache.set(key, await loadSession(fileId, runId));
      const loaded = sessionCache.get(key);
      if (loaded.ok && !tableCache.has(key)) tableCache.set(key, await A.buildOccurrenceTable(loaded.events));
      return { loaded, key };
    }

    const resolvedMap = new Map();
    for (const entry of list) {
      const ann = annotationMap.get(entry.id);
      if (!ann) continue; // resolveEntries 会归入 skipped（批注缺失）
      const ref = ann.sessionRef || {};
      if (typeof ref.fileId !== 'string' || !Number.isInteger(Number(ref.runId))) {
        resolvedMap.set(entry.id, { ok: false, reason: '批注缺少合法的场次引用（sessionRef 损坏）' });
        continue;
      }
      const { loaded, key } = await sessionFor(ref.fileId, Number(ref.runId));
      if (!loaded.ok) {
        resolvedMap.set(entry.id, { ok: false, reason: loaded.reason || '场次日志找不到' });
        continue;
      }
      const out = A.relocalize(ann, tableCache.get(key));
      if (out.valid) {
        resolvedMap.set(entry.id, { ok: true, events: loaded.events, startIndex: out.startIndex, endIndex: out.endIndex });
      } else {
        resolvedMap.set(entry.id, { ok: false, reason: out.reason });
      }
    }
    return resolveEntries(list, annotationMap, resolvedMap);
  }

  return {
    DB_NAME,
    DOC_ID,
    emptyDoc,
    normalizeDoc,
    makeEntry,
    // IndexedDB
    get,
    save,
    clear,
    mutate,
    addIds,
    removeId,
    reorder,
    // 纯函数
    resolveEntries,
    withOffsets,
    totalDuration,
    locateIndex,
    locate,
    segmentStartVt,
    nudge,
    // 浏览器装配
    resolvePlaylist,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CuePlaylist };
}
