/* 场次对比模块测试：匹配键规范化、指标提取、DP 序列对齐（含重复键最优解裁决）与只读 HTTP 接口。
 *
 * 运行前提：服务已在 localhost:3000 启动（npm start）。
 * 解析/提取/对齐部分直接调用 compare.js（合成日志写入临时目录），
 * HTTP 接口部分对真实 data 目录断言。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const replay = require('../replay');
const compare = require('../compare');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

function cue(seq, text, targets) { return { seq, text, targets }; }
function keyed(seq, key) { return { seq, key }; } // 仅用于对齐测试：键直接给定

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${urlPath}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 合成日志构造：两条口令，第 2 条经历暂停、超时、迟到、修订重发；另写第二场用于对齐
// ---------------------------------------------------------------------------
const SESSION_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SESSION_B = 'bbbbbbbb-1111-2222-3333-444444444444';

function writeSynthLogs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // A 场：
  //  #1 共同口令「灯光渐暗」[灯光]，正常完成
  //  #2 A 独有「幕布拉开」[道具]，暂停 1 次、超时 1 次、迟到确认 1 次
  //  #3 共同口令「全场亮灯」[灯光,音响]，修订 1 次（仅措辞，不改口令/目标键）后完成
  const a = [
    ['2026-09-19T10:00:00.000Z', 'sequence-set', { timeoutSec: 5, cues: [] }],
    ['2026-09-19T10:00:01.000Z', 'session-start', {}],
    ['2026-09-19T10:00:01.000Z', 'cue-started', { seq: 1, text: '灯光渐暗', targets: ['灯光'], revision: 1, attemptId: 'a1' }],
    ['2026-09-19T10:00:02.000Z', 'confirm', { seq: 1, position: '灯光' }],
    ['2026-09-19T10:00:02.500Z', 'cue-completed', { seq: 1 }],
    ['2026-09-19T10:00:02.500Z', 'cue-started', { seq: 2, text: '幕布拉开', targets: ['道具'], revision: 1, attemptId: 'a2' }],
    ['2026-09-19T10:00:03.000Z', 'cue-paused', { seq: 2, reason: '等待机械' }],
    ['2026-09-19T10:00:20.000Z', 'cue-resumed', { seq: 2 }],
    ['2026-09-19T10:00:20.600Z', 'cue-timeout', { seq: 2, missing: ['道具'] }],
    ['2026-09-19T10:00:21.000Z', 'confirm-late', { seq: 2, position: '道具' }],
    ['2026-09-19T10:00:21.500Z', 'cue-completed', { seq: 2 }],
    ['2026-09-19T10:00:21.500Z', 'cue-started', { seq: 3, text: '全场亮灯', targets: ['灯光', '音响'], revision: 1, attemptId: 'a3' }],
    ['2026-09-19T10:00:22.000Z', 'confirm', { seq: 3, position: '灯光' }],
    ['2026-09-19T10:00:23.000Z', 'cue-recalled', { seq: 3, oldRevision: 1, newRevision: 2, reason: '重发确认', newText: '全场亮灯' }],
    ['2026-09-19T10:00:23.000Z', 'cue-resent', { seq: 3, text: '全场亮灯', reason: '重发确认', revision: 2, attemptId: 'a3b' }],
    ['2026-09-19T10:00:24.000Z', 'confirm', { seq: 3, position: '灯光' }],
    ['2026-09-19T10:00:24.500Z', 'confirm', { seq: 3, position: '音响' }],
    ['2026-09-19T10:00:25.000Z', 'cue-completed', { seq: 3 }],
    ['2026-09-19T10:00:25.100Z', 'sequence-finished', {}],
  ];
  // B 场：
  //  #1 B 独有「提前就位」[音响]
  //  #2 共同口令「灯光渐暗」[灯光]（顺序后移：序号偏移 1）
  //  #3 共同口令「全场亮灯」[音响,灯光]（目标书写顺序相反、空白与全角差异，键应相同）
  const b = [
    ['2026-09-19T11:00:00.000Z', 'sequence-set', { timeoutSec: 10, cues: [] }],
    ['2026-09-19T11:00:01.000Z', 'session-start', {}],
    ['2026-09-19T11:00:01.000Z', 'cue-started', { seq: 1, text: '提前就位', targets: ['音响'], revision: 1, attemptId: 'b0' }],
    ['2026-09-19T11:00:01.500Z', 'confirm', { seq: 1, position: '音响' }],
    ['2026-09-19T11:00:02.000Z', 'cue-completed', { seq: 1 }],
    ['2026-09-19T11:00:02.000Z', 'cue-started', { seq: 2, text: ' 灯光　渐暗 ', targets: ['灯光'], revision: 1, attemptId: 'b1' }],
    ['2026-09-19T11:00:03.000Z', 'confirm', { seq: 2, position: '灯光' }],
    ['2026-09-19T11:00:03.500Z', 'cue-completed', { seq: 2 }],
    ['2026-09-19T11:00:03.500Z', 'cue-started', { seq: 3, text: '全场亮灯', targets: ['音响', '灯光'], revision: 1, attemptId: 'b3' }],
    ['2026-09-19T11:00:04.000Z', 'confirm', { seq: 3, position: '音响' }],
    ['2026-09-19T11:00:04.500Z', 'confirm', { seq: 3, position: '灯光' }],
    ['2026-09-19T11:00:05.000Z', 'cue-completed', { seq: 3 }],
    ['2026-09-19T11:00:05.100Z', 'sequence-finished', {}],
  ];
  const write = (id, lines) => {
    fs.writeFileSync(path.join(dir, `events-${id}.jsonl`),
      lines.map(([ts, event, detail]) => JSON.stringify({ ts, event, detail })).join('\n') + '\n');
  };
  write(SESSION_A, a);
  write(SESSION_B, b);
}

async function main() {
  console.log('一、匹配键：规范化口令文本 + 排序后目标岗位');
  check('口令文本 NFKC/空白/大小写规范化',
    compare.cueKey(cue(1, ' Ｌight　Cue ', ['x'])) === compare.cueKey(cue(2, 'light cue', ['x'])));
  check('目标岗位排序后比较（顺序不敏感）',
    compare.cueKey(cue(1, 'Q', ['灯光', '音响'])) === compare.cueKey(cue(2, 'Q', ['音响', '灯光'])));
  check('文本不同则键不同',
    compare.cueKey(cue(1, 'Q1', ['灯光'])) !== compare.cueKey(cue(2, 'Q2', ['灯光'])));
  check('目标不同则键不同',
    compare.cueKey(cue(1, 'Q', ['灯光'])) !== compare.cueKey(cue(1, 'Q', ['音响'])));
  check('normalizeText 去首尾空白并折叠连续空白',
    compare.normalizeText('  a   b\t c ') === 'a b c');
  check('normalizeTargets 去空、去重、排序（经规范化：小写）',
    JSON.stringify(compare.normalizeTargets(['B', ' a ', '', 'A', 'a'])) === JSON.stringify(['a', 'b']));

  console.log('二、指标提取：耗时 / 超时 / 迟到 / 修订 / 暂停');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-compare-'));
  writeSynthLogs(dir);
  const dataA = replay.getSession(dir, SESSION_A, '0');
  const dataB = replay.getSession(dir, SESSION_B, '0');
  check('两场均成功读取', !dataA.error && !dataB.error);
  const cuesA = compare.extractCues(dataA);
  const cuesB = compare.extractCues(dataB);
  check('各提取 3 条口令', cuesA.length === 3 && cuesB.length === 3);

  const a2 = cuesA[1];
  check('#2 耗时从口令开始到完成（21.5-2.5=19 秒；暂停墙钟计入墙钟耗时）',
    a2.durationMs === 19000 && a2.startT === 1500);
  check('#2 超时 1 次、迟到确认 1 次、暂停 1 次、修订 0 次',
    a2.timeouts === 1 && a2.lateConfirms === 1 && a2.pauses === 1 && a2.revisions === 0);
  const a3 = cuesA[2];
  check('#3 修订 1 次（文本未改，最终文本仍为原文本）', a3.revisions === 1 && a3.finalText === '全场亮灯');
  check('#3 耗时从首次发令到完成（修订不重置起点）', a3.durationMs === 3500);
  check('#3 匹配键仍基于冻结快照原始文本与原始目标',
    a3.key === compare.cueKey(cue(0, '全场亮灯', ['灯光', '音响'])));
  // 直接构造事件流：修订改了口令文本时，匹配键保持原始口令，finalText 反映最终版本
  {
    const revisedCues = compare.extractCues({ events: [
      { event: 'cue-started', t: 0, detail: { seq: 1, text: '旧文本', targets: ['灯光'] } },
      { event: 'cue-recalled', t: 10, detail: { seq: 1 } },
      { event: 'cue-resent', t: 10, detail: { seq: 1, text: '新文本', revision: 2 } },
      { event: 'cue-completed', t: 50, detail: { seq: 1 } },
    ] });
    check('修订改文本：键按原始口令、finalText 为最终修订版、修订数 1',
      revisedCues[0].key === compare.cueKey(cue(0, '旧文本', ['灯光'])) &&
      revisedCues[0].finalText === '新文本' && revisedCues[0].revisions === 1 &&
      revisedCues[0].durationMs === 50);
  }

  console.log('三、序列对齐：匹配 / 新增 / 删除，保持原顺序');
  const result = compare.alignCues(cuesA, cuesB);
  const kinds = result.rows.map((r) => r.type);
  check('行数 = 4（3 类关系）', result.rows.length === 4);
  check('新增行：B#1 提前就位',
    kinds[0] === 'added' && result.rows[0].right.seq === 1);
  check('匹配行：A#1 灯光渐暗 ↔ B#2',
    result.rows[1].type === 'match' && result.rows[1].left.seq === 1 && result.rows[1].right.seq === 2);
  check('删除行：A#2 幕布拉开',
    result.rows[2].type === 'deleted' && result.rows[2].left.seq === 2);
  check('匹配行：A#3 ↔ B#3（全角空白/目标顺序差异仍匹配）',
    result.rows[3].type === 'match' && result.rows[3].left.seq === 3 && result.rows[3].right.seq === 3);
  check('总序号偏移：|1-2| + |3-3| = 1',
    result.matches.reduce((s, [i, j]) => s + Math.abs(cuesA[i].seq - cuesB[j].seq), 0) === 1);

  console.log('四、重复键多解裁决：匹配数 → 总序号偏移 → 左场序号优先');
  // 4.1 偏移最小：x 出现两次时，必须选 (1,2)/(2,3)（偏移 2）而非 (1,3)/(2,2)（偏移 2 但...)
  {
    const L = [keyed(1, 'x'), keyed(2, 'x'), keyed(3, 'y')];
    const R = [keyed(1, 'z'), keyed(2, 'x'), keyed(3, 'x')];
    const al = compare.alignCues(L, R);
    check('重复键：总偏移最小匹配 (x#1↔x#2, x#2↔x#3)',
      JSON.stringify(al.matches) === JSON.stringify([[0, 1], [1, 2]]));
  }
  // 4.2 匹配数最多优先于偏移：L = x,x,y ; R = x,y,x。
  //   2 个匹配可行：(x1,x1)+(x2,r3) 偏移 1；(x1,x1)+(y3,y2) 不可行（保持顺序时 x2 无位可放）；
  //   3 个匹配：(x1,x1)+(x2,r3)+(y3,y2) 乱序非法。故最优为 2 匹配、偏移 1。
  {
    const L = [keyed(1, 'x'), keyed(2, 'x'), keyed(3, 'y')];
    const R = [keyed(1, 'x'), keyed(2, 'y'), keyed(3, 'x')];
    const al = compare.alignCues(L, R);
    check('匹配数/偏移：可行 2 匹配取偏移最小 (x#1↔x#1, x#2↔x#3)',
      JSON.stringify(al.matches) === JSON.stringify([[0, 0], [1, 2]]));
  }
  // 4.2b 偏移裁决：L = x,y ; R = y,x（同键交叉）。只能匹配 1 个：
  //   (x1,r2) 偏移 1，(y2,y1) 偏移 1 → 偏移并列，左场序号优先取左序号更小的 (x1,r2)。
  {
    const L = [keyed(1, 'x'), keyed(2, 'y')];
    const R = [keyed(1, 'y'), keyed(2, 'x')];
    const al = compare.alignCues(L, R);
    check('单匹配且偏移并列：左场序号优先（取左场 #1 的 x）',
      JSON.stringify(al.matches) === JSON.stringify([[0, 1]]));
  }
  // 4.3 匹配数与偏移均并列时左场序号优先：
  //   L=x,y ; R=y,x：只能匹配 1 个，(x1,r2) 与 (y2,y1) 偏移均为 1 →
  //   按左场序号升序逐项比较，取左序号更小的 x1↔r2。
  {
    const L = [keyed(1, 'x'), keyed(2, 'y')];
    const R = [keyed(1, 'y'), keyed(2, 'x')];
    const al = compare.alignCues(L, R);
    check('偏移并列：左场序号优先（取左场 #1 的 x → 右 #2）',
      JSON.stringify(al.matches) === JSON.stringify([[0, 1]]));
  }
  // 4.3b 更长的并列：L=x,y,x ; R=x,x,y。
  //   x1↔x1 偏移 0 固定；剩余可配 (y2,r3) 与 (x3,r2)，偏移均为 1，
  //   左场序号优先取左 #2（y）先匹配 → (x1,x1),(y2,r3)。
  {
    const L = [keyed(1, 'x'), keyed(2, 'y'), keyed(3, 'x')];
    const R = [keyed(1, 'x'), keyed(2, 'x'), keyed(3, 'y')];
    const al = compare.alignCues(L, R);
    check('偏移并列（多匹配）：逐项比较后取左场 #2 优先',
      JSON.stringify(al.matches) === JSON.stringify([[0, 0], [1, 2]]));
    check('对齐结果确定（重复执行完全相同）',
      JSON.stringify(compare.alignCues(L, R).matches) === JSON.stringify(al.matches));
  }
  // 4.4 空序列 / 无公共键
  check('两场无公共键：全部删除 + 新增',
    (() => {
      const al = compare.alignCues([keyed(1, 'a')], [keyed(1, 'b')]);
      return al.rows.length === 2 && al.rows[0].type === 'deleted' && al.rows[1].type === 'added';
    })());
  check('空场对齐为空表', compare.alignCues([], []).rows.length === 0);
  check('右场为空：全部删除',
    compare.alignCues([keyed(1, 'a'), keyed(2, 'b')], []).rows.every((r) => r.type === 'deleted'));

  // 4.5 穷举交叉验证：随机小序列上，DP 结果必须与「所有保序匹配集合」按
  //     匹配数 → 总偏移 → 左场序号优先 全序枚举的最优解一致
  {
    function bruteForce(L, R) {
      let best = null;
      const rankOf = (ms) => {
        const off = ms.reduce((s, [i, j]) => s + Math.abs(L[i].seq - R[j].seq), 0);
        return [ms.length, -off, ...ms.flatMap(([i, j]) => [-i, -j])];
      };
      const better = (ms) => {
        if (!best) return true;
        const a = rankOf(ms), b = rankOf(best);
        for (let k = 0; k < Math.max(a.length, b.length); k++) {
          const x = a[k] || 0, y = b[k] || 0;
          if (x !== y) return x > y;
        }
        return false;
      };
      const gen = (li, ri, picked) => {
        if (li >= L.length || ri >= R.length) {
          if (better(picked)) best = picked.map((p) => [...p]);
          return;
        }
        for (let i = li; i < L.length; i++) {
          for (let j = ri; j < R.length; j++) {
            if (L[i].key === R[j].key) gen(i + 1, j + 1, [...picked, [i, j]]);
          }
        }
        if (better(picked)) best = picked.map((p) => [...p]);
      };
      gen(0, 0, []);
      return best || [];
    }
    let rnd = 123456789;
    const rand = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
    let allOk = true;
    for (let t = 0; t < 400; t++) {
      const alpha = ['x', 'y', 'z'];
      const L = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) =>
        keyed(i + 1, alpha[Math.floor(rand() * alpha.length)]));
      const R = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) =>
        keyed(i + 1, alpha[Math.floor(rand() * alpha.length)]));
      const dpM = compare.alignCues(L, R).matches.map((p) => [...p]);
      const bfM = bruteForce(L, R);
      if (JSON.stringify(dpM) !== JSON.stringify(bfM)) { allOk = false; break; }
    }
    check('400 组随机小序列：DP 对齐与穷举最优解（三层全序）逐一相同', allOk);
  }

  console.log('五、端到端 compareSessions（合成目录）');
  const cmp = compare.compareSessions(dir, SESSION_A, '0', SESSION_B, '0');
  check('汇总计数：2 匹配 / 1 新增 / 1 删除',
    cmp.summary.matched === 2 && cmp.summary.added === 1 && cmp.summary.deleted === 1 &&
    cmp.summary.leftCount === 3 && cmp.summary.rightCount === 3);
  check('两侧场次元数据带回（fileId/runId/时限）',
    cmp.left.session.fileId === SESSION_A && cmp.right.timeoutSec === 10);
  check('非法 fileId 返回 badId',
    compare.compareSessions(dir, '../evil', '0', SESSION_B, '0').error === 'badId');
  check('非法 runId 返回 badId',
    compare.compareSessions(dir, SESSION_A, '-1', SESSION_B, '0').error === 'badId');
  check('不存在场次返回 notFound',
    compare.compareSessions(dir, '99999999-9999-9999-9999-999999999999', '0', SESSION_B, '0').error === 'notFound');

  console.log('六、HTTP 接口（只读，GET）');
  const missing = await httpGet('/api/compare/sessions?a=x/1');
  check('缺少 b 参数返回 400', missing.status === 400);
  const bad = await httpGet('/api/compare/sessions?a=..%2F..%2Fevil/0&b=x/1');
  check('非法 ID / 路径穿越返回 400', bad.status === 400);
  const notFound = await httpGet(`/api/compare/sessions?a=99999999-9999-9999-9999-999999999999/0&b=${SESSION_B}/0`);
  check('不存在场次返回 404', notFound.status === 404);
  const list = await httpGet('/api/replay/sessions');
  if (list.json.sessions.length >= 2) {
    const [s1, s2] = list.json.sessions;
    const ok = await httpGet(`/api/compare/sessions?a=${s1.fileId}/${s1.runId}&b=${s2.fileId}/${s2.runId}`);
    check('真实场次对比 200 且含 rows/summary/left/right',
      ok.status === 200 && Array.isArray(ok.json.rows) && ok.json.summary && ok.json.left && ok.json.right);
  }
  const page = await new Promise((resolve) => {
    http.get('http://localhost:3000/compare.html', (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
  });
  check('对比页面可访问且不创建 WebSocket（无 /ws 引用）',
    page.status === 200 && !/new\s+WebSocket/.test(page.body) && page.body.includes('/api/compare/sessions'));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
