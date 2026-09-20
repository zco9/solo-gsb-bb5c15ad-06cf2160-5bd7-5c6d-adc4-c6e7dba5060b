'use strict';

// ---------------------------------------------------------------------------
// 场次对比（只读）模块
//
// 在「演出复盘」已切分好的已结束场次（session-start → sequence-finished）
// 之上，提取每条口令的执行指标，并按「规范化口令文本 + 排序后的目标岗位」
// 构造匹配键，用动态规划在保持两场原有序列顺序的前提下完成序列对齐
// （类 Needleman–Wunsch / LCS），输出逐口令对照表：
//   - match（匹配，两场共有）| added（仅右场，新增）| deleted（仅左场，删除）
//
// 同一批重复键可能对应多种最优对齐，按以下全序裁决唯一结果：
//   1) 匹配数最多；
//   2) 所有匹配对的总序号偏移 Σ|aSeq - bSeq| 最小；
//   3) 仍并列时，按左场序号升序逐项优先取左场序号更小的匹配（左场序号优先）。
//
// 只读保证：本模块仅经 replay.js 的只读解析器读取 data 目录事件日志，
// 绝不打开写流、绝不追加/修改事件日志，不引用 server.js 的当前演出状态，
// 也不连接或广播 WebSocket。
// ---------------------------------------------------------------------------

const replay = require('./replay');
const ReplayCore = require('./public/replay-core'); // Node / 浏览器共用的事件折叠内核

// 口令文本规范化：NFKC 全角/半角统一（全角空格 U+3000 等在这一步归一为 ASCII 空白）→
// 删除汉字之间 / 汉字两侧的排版空白（中文口令中的空格通常只是排版）→
// 折叠连续空白 → 去首尾空白 → 小写。
// 与目标岗位口径一致地容忍排版差异；不做激进改写（不去标点），避免误并不同口令。
const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff';
function normalizeText(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(new RegExp(`\\s+(?=[${CJK}])`, 'g'), '') // 空白后紧跟汉字：删除
    .replace(new RegExp(`(?<=[${CJK}])\\s+`, 'g'), '') // 汉字后的空白：删除
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// 目标岗位规范化 + 去重 + 字典序排序：忽略岗位书写顺序与重复岗位差异
function normalizeTargets(targets) {
  return [...new Set((Array.isArray(targets) ? targets : [])
    .map((t) => normalizeText(t))
    .filter(Boolean))]
    .sort();
}

// 匹配键：规范化口令文本 + 排序后的目标岗位
function cueKey(cue) {
  return `${normalizeText(cue.text)}::${normalizeTargets(cue.targets).join('|')}`;
}

// ---------------------------------------------------------------------------
// 单场口令指标提取：直接基于共享事件折叠内核（public/replay-core.js）按日志行序
// 折叠出的场次 / 口令 / 轮次模型（与复盘 foldUntil、确认延迟诊断同一状态机）。
//
// 每条口令统计：
//   durationMs  从口令开始（首次 cue-started；修订重发不重置，即「从口令开始到完成」）
//               到 cue-completed 的墙钟耗时；未闭合口令为 null
//   timeouts    确认超时次数（归属到该口令各轮次的 cue-timeout；修订后再次超时累计）
//   lateConfirms 迟到确认次数（confirm-late，按归属轮次计入口令）
//   revisions   修订次数（修订轮次数，即 cue-resent / cue-recalled 次数）
//   pauses      暂停次数（归属到该口令各轮次的 cue-paused）
//   finalText   最终修订版文本（未修订时等于原文本）
// 匹配键由本模块的规范化策略经 keyBuilder 注入（内核不依赖具体规范化）。
// startT 为口令开始事件的相对偏移，供前端跳转复盘时刻。
// ---------------------------------------------------------------------------
function extractCues(sessionData) {
  const events = Array.isArray(sessionData.events) ? sessionData.events : [];
  const timeoutSec = Number(sessionData && sessionData.timeoutSec);
  return ReplayCore.extractCues(events, {
    timeoutSec: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : undefined,
    keyBuilder: (cue) => cueKey({ text: cue.originalText, targets: cue.targets }),
  });
}

// ---------------------------------------------------------------------------
// 序列对齐（动态规划，保持两场原顺序）
//
// dp[i][j] 保存把左场前 i 条、右场前 j 条对齐的最优方案：
//   { matches: [[aIndex, bIndex], ...] }（索引为 0 基，按左场顺序排列）
// 三种转移：匹配末位（键相等）/ 左场末位删除 / 右场末位新增。
// 方案按「匹配数 → 总序号偏移 → 左场序号优先」的全序比较，重复键产生的
// 多种最优解由此收敛为唯一结果。
// ---------------------------------------------------------------------------
function isBetterSolution(cand, best, aCues, bCues) {
  if (!best) return true;
  if (cand.matches.length !== best.matches.length) {
    return cand.matches.length > best.matches.length; // 1) 匹配数最多
  }
  // 2) 总序号偏移最小（序号取 1 基：索引 +1）
  const offsetOf = (m) => m.reduce((sum, [ai, bi]) => sum + Math.abs(aCues[ai].seq - bCues[bi].seq), 0);
  const co = offsetOf(cand.matches);
  const bo = offsetOf(best.matches);
  if (co !== bo) return co < bo;
  // 3) 左场序号优先：按左场顺序逐项比较，左序号更小者优先
  for (let k = 0; k < cand.matches.length; k++) {
    const [ca, cb] = cand.matches[k];
    const [pa, pb] = best.matches[k];
    if (ca !== pa) return ca < pa;
    if (cb !== pb) return cb < pb;
  }
  return false; // 完全相同：保持已选结果，保证裁决确定性
}

function alignCues(aCues, bCues) {
  const n = aCues.length;
  const m = bCues.length;
  const empty = () => ({ matches: [] });

  // dp[i][j]：(n+1) × (m+1) 网格
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1));
  dp[0][0] = empty();
  for (let i = 1; i <= n; i++) dp[i][0] = { matches: [] };
  for (let j = 1; j <= m; j++) dp[0][j] = { matches: [] };

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = dp[i - 1][j]; // 左场末位删除（deleted）

      const fromRight = dp[i][j - 1]; // 右场末位新增（added）
      if (isBetterSolution(fromRight, best, aCues, bCues)) best = fromRight;

      if (aCues[i - 1].key === bCues[j - 1].key) {
        const diag = dp[i - 1][j - 1];
        const candidate = { matches: [...diag.matches, [i - 1, j - 1]] };
        if (isBetterSolution(candidate, best, aCues, bCues)) best = candidate;
      }
      dp[i][j] = best;
    }
  }

  // 回溯：由最优匹配对集合生成逐行对照（match / deleted / added），保持原顺序
  const rows = [];
  const matchMap = new Map(dp[n][m].matches.map(([ai, bi]) => [ai, bi]));
  let ai = 0;
  let bi = 0;
  while (ai < n || bi < m) {
    if (ai < n && matchMap.has(ai)) {
      const bj = matchMap.get(ai);
      while (bi < bj) rows.push({ type: 'added', right: bCues[bi++] });
      rows.push({ type: 'match', left: aCues[ai], right: bCues[bj] });
      ai += 1;
      bi = bj + 1;
    } else if (ai < n) {
      rows.push({ type: 'deleted', left: aCues[ai++] });
    } else {
      rows.push({ type: 'added', right: bCues[bi++] });
    }
  }
  return { matches: dp[n][m].matches, rows };
}

// ---------------------------------------------------------------------------
// 单场读取与校验（复用 replay 只读解析器；fileId 同样强制 UUID 形状）
// ---------------------------------------------------------------------------
function loadSession(dataDir, fileId, runId) {
  if (!replay.isValidFileId(fileId)) return { error: 'badId' };
  const id = Number(runId);
  if (!Number.isInteger(id) || id < 0) return { error: 'badId' };
  const data = replay.getSession(dataDir, fileId, String(id));
  if (data.error) return { error: data.error };
  return { data };
}

function sideView(ref, sessionData) {
  return {
    ref, // 'left' | 'right'
    session: sessionData.session,
    timeoutSec: sessionData.timeoutSec,
    cues: extractCues(sessionData),
  };
}

// GET /api/compare/sessions?a=<fileId>/<runId>&b=<fileId>/<runId>
function compareSessions(dataDir, aFileId, aRunId, bFileId, bRunId) {
  const a = loadSession(dataDir, aFileId, aRunId);
  const b = loadSession(dataDir, bFileId, bRunId);
  if (a.error === 'badId' || b.error === 'badId') return { error: 'badId' };
  if (a.error === 'notFound' || b.error === 'notFound') return { error: 'notFound' };
  if (a.error || b.error) return { error: 'readFailed' };

  const aCues = extractCues(a.data);
  const bCues = extractCues(b.data);
  const { rows } = alignCues(aCues, bCues);

  return {
    left: sideView('left', a.data),
    right: sideView('right', b.data),
    rows,
    summary: {
      leftCount: aCues.length,
      rightCount: bCues.length,
      matched: rows.filter((r) => r.type === 'match').length,
      added: rows.filter((r) => r.type === 'added').length,
      deleted: rows.filter((r) => r.type === 'deleted').length,
    },
  };
}

module.exports = {
  normalizeText,
  normalizeTargets,
  cueKey,
  extractCues,
  alignCues,
  isBetterSolution,
  compareSessions,
};
