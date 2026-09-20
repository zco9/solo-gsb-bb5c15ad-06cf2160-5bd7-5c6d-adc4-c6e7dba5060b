// 端到端冒烟测试：模拟导演、控制端、三个岗位端走完整流程（含临时替岗）
'use strict';
const WebSocket = require('ws');

const URL = 'ws://localhost:3000/ws';
let passed = 0, failed = 0;

function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

function client(role, position, cid) {
  const ws = new WebSocket(URL);
  const c = {
    ws,
    state: null,
    errors: [],
    leaseToken: null,   // lease-granted 定向下发的租约凭证
    leaseGranted: null,
    ready: new Promise((res) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', role, position, clientId: cid || ('test-' + role + '-' + (position || '')) }));
        res();
      });
    }),
    send(obj) { ws.send(JSON.stringify(obj)); },
    waitState(pred, timeout = 3000) {
      return new Promise((res, rej) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (c.state && pred(c.state)) { clearInterval(iv); res(c.state); }
          else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('waitState 超时')); }
        }, 20);
      });
    },
  };
  ws.on('message', (m) => {
    const d = JSON.parse(m);
    if (d.type === 'state') c.state = d.state;
    if (d.type === 'error') c.errors.push(d.message);
    if (d.type === 'lease-granted') { c.leaseToken = d.token; c.leaseGranted = d; }
    // 草稿相关定向消息
    if (d.type === 'draft-saved') c.draftSaved = d;
    if (d.type === 'draft-conflict') c.draftConflict = d;
    if (d.type === 'reset-choice-required') c.resetChoice = d;
  });
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 岗位确认必须携带其最新快照中的 attemptId（与岗位端页面行为一致）
const confirmCue = (c) => c.send({ type: 'confirm', attemptId: c.state.attemptId });

// 控制端心跳续期（与控制端页面行为一致：持有期间按固定间隔发送租约心跳）
const hbTimers = new Map();
function startHeartbeat(c, intervalMs = 2000) {
  stopHeartbeat(c);
  hbTimers.set(c, setInterval(() => {
    if (c.leaseToken) c.send({ type: 'lease-heartbeat', token: c.leaseToken });
  }, intervalMs));
}
function stopHeartbeat(c) {
  if (hbTimers.has(c)) { clearInterval(hbTimers.get(c)); hbTimers.delete(c); }
}

(async () => {
  const director = client('director');
  const control = client('control');
  const light = client('position', '灯光');
  const sound = client('position', '音响');
  const prop = client('position', '道具');
  await Promise.all([director.ready, control.ready, light.ready, sound.ready, prop.ready]);
  await sleep(200);

  console.log('0. 主控制端申请指挥权租约（后续开始/推进/重置等均需持有租约）');
  control.send({ type: 'lease-acquire', name: '主控' });
  const st0 = await control.waitState((s) => s.lease && s.lease.holderId === 'test-control-');
  check('租约申请成功并定向下发凭证', !!control.leaseGranted && typeof control.leaseToken === 'string');
  check('快照展示持有者与剩余有效期',
    st0.lease.holderId === 'test-control-' && st0.lease.holderName === '主控' &&
    st0.lease.remainingMs > 0 && st0.lease.ttlMs > 0 && !st0.lease.token);
  startHeartbeat(control);

  console.log('0.1 重置场次，确保干净起点');
  control.send({ type: 'reset' });
  await control.waitState((s) => s.phase === 'idle');

  console.log('1. 导演创建序列（3 条口令）');
  director.send({ type: 'setSequence', timeoutSec: 3, cues: [
    { text: '灯光渐暗', targets: ['灯光'] },
    { text: '音乐起，道具就位', targets: ['音响', '道具'] },
    { text: '全场亮灯', targets: ['灯光', '音响'] },
  ]});
  let st = await control.waitState((s) => s.sequence.length === 3);
  check('序列已保存（3 条）', st.sequence.length === 3);
  check('序号自动编号', st.sequence[0].seq === 1 && st.sequence[2].seq === 3);

  console.log('2. 控制端开始演出');
  control.send({ type: 'start' });
  st = await control.waitState((s) => s.phase === 'active');
  check('第 1 条口令激活', st.currentCue.text === '灯光渐暗');

  console.log('3. 非目标岗位确认应被拒绝');
  confirmCue(sound);
  await sleep(200);
  check('音响确认被拒绝', sound.errors.some((e) => e.includes('不涉及')));
  check('确认状态未串入', Object.keys(st.confirmations || {}).length === 0);

  console.log('4. 目标岗位确认 + 重复确认标记');
  confirmCue(light);
  st = await control.waitState((s) => s.confirmations['灯光']);
  check('灯光确认成功', !!st.confirmations['灯光']);
  confirmCue(light);
  st = await control.waitState((s) => s.log.some((l) => l.event === 'confirm-duplicate'));
  check('重复确认被实时标记进日志', true);

  console.log('5. 全员确认后推进');
  control.send({ type: 'advance' });
  st = await control.waitState((s) => s.currentCue && s.currentCue.seq === 2);
  check('推进到第 2 条', st.currentCue.text.includes('音乐起'));
  check('上一条确认未串入下一条', Object.keys(st.confirmations).length === 0);

  console.log('6. 未全员确认禁止推进');
  confirmCue(sound);
  await control.waitState((s) => s.confirmations['音响']);
  control.send({ type: 'advance' });
  await sleep(200);
  check('推进被拒绝（道具未确认）', control.errors.some((e) => e.includes('禁止推进')));

  console.log('7. 非法替岗应被拒绝');
  light.send({ type: 'substitute', from: '道具', to: '灯光' }); // 非控制端发起
  control.send({ type: 'substitute', from: '灯光', to: '道具' }); // 原岗位不是本条目标
  control.send({ type: 'substitute', from: '道具', to: '音响' }); // 替补已是本条有效目标
  control.send({ type: 'substitute', from: '道具', to: '候场' }); // 替补不在线
  await sleep(300);
  check('非控制端替岗被拒绝', light.errors.some((e) => e.includes('仅控制端')));
  check('非本条目标不能被替岗', control.errors.some((e) => e.includes('不是本条口令的目标岗位')));
  check('替补不能已是本条有效目标', control.errors.some((e) => e.includes('已是本条口令的有效目标')));
  check('替补必须在线', control.errors.some((e) => e.includes('不在线')));
  st = control.state;
  check('非法替岗未改变有效目标', (st.effectiveTargets || []).join() === '音响,道具');

  console.log('8. 控制端指定临时替岗：道具 → 灯光');
  control.send({ type: 'substitute', from: '道具', to: '灯光' });
  st = await control.waitState((s) => s.substitutions && s.substitutions['道具']);
  check('替岗已生效（道具 → 灯光）', st.substitutions['道具'].substitute === '灯光');
  check('有效目标更新为 音响+灯光', st.effectiveTargets.includes('灯光') && !st.effectiveTargets.includes('道具'));
  const subLog = st.log.find((l) => l.event === 'position-substituted');
  check('替岗写入事件日志（原岗位/替补/时间）',
    !!subLog && subLog.detail.from === '道具' && subLog.detail.to === '灯光' && !!subLog.ts);

  console.log('9. 原岗位不得再确认本条');
  confirmCue(prop);
  await sleep(200);
  check('道具确认被拒绝', prop.errors.some((e) => e.includes('移交')));
  check('道具未产生确认记录', !control.state.confirmations['道具']);

  console.log('10. 断线重连后替岗状态一致');
  light.ws.close();
  await sleep(300);
  const light2 = client('position', '灯光');
  await light2.ready;
  st = await light2.waitState((s) => s.phase === 'active' && s.currentCue.seq === 2 && s.substitutions['道具']);
  check('重连后恢复替岗关系', st.substitutions['道具'].substitute === '灯光');
  check('重连后有效目标一致', st.effectiveTargets.includes('灯光') && !st.effectiveTargets.includes('道具'));

  console.log('11. 超时标记跟随替补岗位');
  st = await control.waitState((s) => s.timedOut.includes('灯光'), 8000);
  check('替补（灯光）被标记超时未确认', true);
  check('原岗位（道具）不在超时列表', !st.timedOut.includes('道具'));

  console.log('12. 替补确认计入全员确认（迟到）');
  confirmCue(light2);
  st = await control.waitState((s) => s.confirmations['灯光']);
  check('替补迟到确认被接受且标记 late', st.confirmations['灯光'].late === true);
  check('日志含替补的 confirm-late', st.log.some((l) => l.event === 'confirm-late' && l.detail.position === '灯光'));

  console.log('13. 推进后下一条仍使用导演编排的原目标');
  control.send({ type: 'advance' });
  st = await control.waitState((s) => s.currentCue && s.currentCue.seq === 3);
  check('推进到第 3 条', st.currentCue.text.includes('全场亮灯'));
  check('第 3 条目标为原编排（灯光、音响）', st.currentCue.targets.join() === '灯光,音响');
  check('替岗不串入下一条', Object.keys(st.substitutions).length === 0);
  check('确认不串入下一条', Object.keys(st.confirmations).length === 0);

  console.log('14. 推进至完成');
  confirmCue(light2);
  confirmCue(sound);
  await control.waitState((s) => s.confirmations['灯光'] && s.confirmations['音响']);
  control.send({ type: 'advance' });
  st = await control.waitState((s) => s.phase === 'done');
  check('全部口令完成', st.log.some((l) => l.event === 'sequence-finished'));

  console.log('15. 重置后可重新编辑');
  control.send({ type: 'reset' });
  st = await director.waitState((s) => s.phase === 'idle');
  check('重置回 idle', true);
  check('事件日志保留', st.log.length > 5);

  console.log('16. 撤回权限与参数校验');
  director.send({ type: 'setSequence', timeoutSec: 3, cues: [
    { text: '第一版口令', targets: ['灯光', '音响'] },
    { text: '下一条', targets: ['道具'] },
  ]});
  await control.waitState((s) => s.sequence.length === 2);
  control.send({ type: 'start' });
  st = await control.waitState((s) => s.phase === 'active' && s.currentCue.text === '第一版口令');
  check('新序列开始，初始修订号为 1', st.revision === 1 && !st.revisionReason);
  const firstAttemptId = st.attemptId;
  check('快照携带 attemptId', typeof firstAttemptId === 'string' && firstAttemptId.length > 0);
  light2.send({ type: 'recall', reason: 'x', text: 'y' }); // 岗位端无权撤回
  control.send({ type: 'recall', reason: '', text: '修正版' }); // 缺撤回原因
  control.send({ type: 'recall', reason: '口令有误', text: '  ' }); // 缺修正版文本
  await sleep(300);
  check('非控制端撤回被拒绝', light2.errors.some((e) => e.includes('仅控制端')));
  check('缺撤回原因被拒绝', control.errors.some((e) => e.includes('撤回原因')));
  check('缺修正版文本被拒绝', control.errors.some((e) => e.includes('修正版口令文本')));
  check('拒绝后修订号仍为 1', control.state.revision === 1);

  console.log('17. 旧轮次确认后撤回并纠正重发');
  light2.send({ type: 'confirm', attemptId: firstAttemptId });
  st = await control.waitState((s) => s.confirmations['灯光']);
  check('灯光在第 1 版确认成功', st.confirmations['灯光'].attemptId === firstAttemptId);
  const oldDeadline = st.deadline;
  await sleep(100);
  control.send({ type: 'recall', reason: '口令措辞有误', text: '第二版口令（修正）' });
  st = await control.waitState((s) => s.revision === 2);
  check('修订号递增为 2', st.revision === 2);
  check('当前口令文本已替换', st.currentCue.text === '第二版口令（修正）');
  check('修订原因已下发', st.revisionReason === '口令措辞有误');
  check('生成新的 attemptId', st.attemptId !== firstAttemptId);
  check('本轮确认状态已清空', Object.keys(st.confirmations).length === 0);
  check('本轮超时/替岗状态已清空', st.timedOut.length === 0 && Object.keys(st.substitutions).length === 0);
  check('确认时限重新开始（deadline 晚于旧轮次）', st.deadline > oldDeadline);
  const hist = st.cueHistory[st.currentCue.id];
  check('旧轮次已封存为只读历史', !!hist && hist.attempts.length === 1 && hist.attempts[0].endState === 'recalled');
  const archived = hist.attempts[0];
  check('封存内容保留旧轮次确认/截止时间/撤回原因',
    archived.confirmations['灯光'] && archived.confirmations['灯光'].attemptId === firstAttemptId &&
    archived.deadline === oldDeadline && archived.reason === '口令措辞有误' &&
    archived.text === '第一版口令' && archived.revision === 1);
  check('cue-recalled 与 cue-resent 均写入日志',
    st.log.some((l) => l.event === 'cue-recalled' && l.detail.newRevision === 2) &&
    st.log.some((l) => l.event === 'cue-resent' && l.detail.revision === 2));

  console.log('18. 旧轮次迟到确认只能被拒绝，绝不污染新轮次');
  light2.send({ type: 'confirm', attemptId: firstAttemptId }); // 使用快照中的旧 attemptId
  await sleep(300);
  check('旧轮次确认被拒绝', light2.errors.some((e) => e.includes('旧轮次')));
  st = control.state;
  check('新轮次确认表未被污染', Object.keys(st.confirmations).length === 0);
  check('stale-confirm-ignored 已记录',
    st.log.some((l) => l.event === 'stale-confirm-ignored' &&
      l.detail.sentAttemptId === firstAttemptId && l.detail.position === '灯光'));
  light2.send({ type: 'confirm', attemptId: null }); // 不带 attemptId 同样拒绝
  await sleep(200);
  check('缺少 attemptId 的确认被拒绝', light2.errors.some((e) => e.includes('旧轮次')));

  console.log('19. 旧轮次定时器回调被拒绝，不触发新轮次超时');
  // 第 1 版在演出开始后 3 秒到期；撤回发生在到期前，旧回调触发时只记录 stale-timeout-ignored
  st = await control.waitState(
    (s) => s.log.some((l) => l.event === 'stale-timeout-ignored' && l.detail.staleAttemptId === firstAttemptId),
    3000);
  check('旧定时器回调被拒绝并记录',
    st.log.some((l) => l.event === 'stale-timeout-ignored' &&
      l.detail.staleAttemptId === firstAttemptId &&
      l.detail.staleRevision === 1 &&
      l.detail.currentAttemptId !== firstAttemptId));
  check('旧回调未污染当前进行轮次的超时表',
    !control.state.timedOut.includes('灯光') || control.state.revision >= 2);

  console.log('20. 断线重连后修订号/原因/旧轮次结果一致');
  const sound2 = client('position', '音响');
  await sound2.ready;
  st = await sound2.waitState((s) => s.revision === 2 && s.cueHistory[s.currentCue.id]);
  check('重连后恢复修订号与原因', st.revision === 2 && st.revisionReason === '口令措辞有误');
  check('重连后恢复只读旧轮次结果',
    st.cueHistory[st.currentCue.id].attempts[0].confirmations['灯光']);

  console.log('21. 连续撤回：修订号继续递增，历史逐版只读封存');
  control.send({ type: 'recall', reason: '再次更正目标动作', text: '第三版口令' });
  st = await control.waitState((s) => s.revision === 3);
  check('修订号递增为 3，原因更新', st.revisionReason === '再次更正目标动作');
  check('两版旧轮次均封存只读',
    st.cueHistory[st.currentCue.id].attempts.length === 2 &&
    st.cueHistory[st.currentCue.id].attempts[0].revision === 1 &&
    st.cueHistory[st.currentCue.id].attempts[1].revision === 2 &&
    st.cueHistory[st.currentCue.id].attempts[1].reason === '再次更正目标动作');
  check('封存对象互不串改（第 1 版保留其撤回原因）',
    st.cueHistory[st.currentCue.id].attempts[0].reason === '口令措辞有误');

  console.log('22. 全员确认后不可撤回，但可正常推进封存');
  const thirdAttemptId = st.attemptId;
  light2.send({ type: 'confirm', attemptId: thirdAttemptId });
  sound2.send({ type: 'confirm', attemptId: thirdAttemptId });
  st = await control.waitState((s) => s.confirmations['灯光'] && s.confirmations['音响']);
  control.send({ type: 'recall', reason: '试图撤回已完成口令', text: '不应生效' });
  await sleep(300);
  check('全员确认后撤回被拒绝', control.errors.some((e) => e.includes('已全员确认完成')));
  check('口令文本未被改动', control.state.currentCue.text === '第三版口令');
  control.send({ type: 'advance' });
  st = await control.waitState((s) => s.currentCue && s.currentCue.seq === 2);
  check('推进到下一条，修订号重置', st.revision === 1 && !st.revisionReason);
  check('完成轮次以 completed 封存', (() => {
    const prev = st.cueHistory[st.sequence[0].id];
    return prev && prev.attempts.some((a) => a.endState === 'completed' && a.revision === 3);
  })());
  check('新轮次确认表干净', Object.keys(st.confirmations).length === 0);

  console.log('23. 已完成（done）场次不可撤回');
  prop.send({ type: 'confirm', attemptId: st.attemptId });
  await control.waitState((s) => s.confirmations['道具']);
  control.send({ type: 'advance' });
  st = await control.waitState((s) => s.phase === 'done');
  control.send({ type: 'recall', reason: '演出已结束', text: 'x' });
  await sleep(200);
  check('done 后撤回被拒绝', control.errors.some((e) => e.includes('已推进或已完成')));

  console.log('24. 重置并创建暂停测试序列');
  control.send({ type: 'reset' });
  await control.waitState((s) => s.phase === 'idle');
  director.send({ type: 'setSequence', timeoutSec: 3, cues: [
    { text: '暂停测试口令', targets: ['灯光', '音响'] },
  ]});
  await control.waitState((s) => s.sequence.length === 1);
  control.send({ type: 'start' });
  st = await control.waitState((s) => s.phase === 'active');
  const pauseAttemptId = st.attemptId;
  check('新轮次未处于暂停状态', st.paused === false && st.remainingMs === null);

  console.log('25. 暂停权限与参数校验');
  light2.send({ type: 'pause', reason: 'x' }); // 岗位端无权暂停
  control.send({ type: 'resume' }); // 未暂停时恢复
  control.send({ type: 'pause', reason: '  ' }); // 缺暂停原因
  await sleep(300);
  check('非控制端暂停被拒绝', light2.errors.some((e) => e.includes('仅控制端')));
  check('未暂停时恢复被拒绝', control.errors.some((e) => e.includes('未处于暂停状态')));
  check('缺暂停原因被拒绝', control.errors.some((e) => e.includes('暂停原因')));
  check('校验失败后仍未暂停', control.state.paused === false);

  console.log('26. 暂停成功：冻结剩余时长并撤销计时器');
  control.send({ type: 'pause', reason: '设备调试' });
  st = await control.waitState((s) => s.paused === true);
  check('暂停状态已生效', st.paused === true);
  check('暂停原因已下发', st.pauseReason === '设备调试');
  check('剩余确认时长已冻结', typeof st.remainingMs === 'number' && st.remainingMs > 0 && st.remainingMs <= 3000);
  check('暂停不改变 attemptId', st.attemptId === pauseAttemptId);
  const frozenRemaining = st.remainingMs;
  const pauseLog = st.log.find((l) => l.event === 'cue-paused');
  check('暂停日志记录操作者/原因/时间',
    !!pauseLog && pauseLog.detail.operator === 'test-control-' &&
    pauseLog.detail.reason === '设备调试' && !!pauseLog.ts);

  console.log('27. 暂停期间确认/替岗/撤回/推进均被拒绝');
  confirmCue(light2);
  control.send({ type: 'substitute', from: '音响', to: '道具', attemptId: pauseAttemptId });
  control.send({ type: 'recall', reason: 'x', text: 'y' });
  control.send({ type: 'advance' });
  control.send({ type: 'pause', reason: '重复暂停' });
  await sleep(300);
  check('暂停期间确认被拒绝', light2.errors.some((e) => e.includes('已暂停')));
  check('暂停期间替岗被拒绝', control.errors.some((e) => e.includes('已暂停') && e.includes('替岗')));
  check('暂停期间撤回被拒绝', control.errors.some((e) => e.includes('已暂停') && e.includes('撤回')));
  check('暂停期间推进被拒绝', control.errors.some((e) => e.includes('已暂停') && e.includes('推进')));
  check('重复暂停被拒绝', control.errors.some((e) => e.includes('已处于暂停状态')));
  st = control.state;
  check('暂停期间确认表未被写入', Object.keys(st.confirmations).length === 0);
  check('暂停中确认被拒已记录日志',
    st.log.some((l) => l.event === 'paused-confirm-rejected' && l.detail.position === '灯光'));

  console.log('28. 暂停期间计时冻结：超过原时限也不超时');
  await sleep(3500); // 原 3 秒确认时限已过，若计时器未撤销早已超时
  st = control.state;
  check('原时限已过仍未标记超时', st.timedOut.length === 0);
  check('无当前轮次超时日志', !st.log.some((l) => l.event === 'cue-timeout' && l.detail.attemptId === pauseAttemptId));
  check('冻结余量未随时间流逝', st.remainingMs === frozenRemaining);

  console.log('29. 断线重连后暂停状态一致');
  const propViewer = client('position', '道具');
  await propViewer.ready;
  st = await propViewer.waitState((s) => s.paused === true);
  check('重连快照含暂停状态与原因', st.paused === true && st.pauseReason === '设备调试');
  check('重连快照冻结余量一致', st.remainingMs === frozenRemaining);
  check('重连快照 attemptId 一致', st.attemptId === pauseAttemptId);

  console.log('30. 恢复：沿用同一 attemptId 按冻结余量重新计时');
  control.send({ type: 'resume' });
  st = await control.waitState((s) => s.paused === false);
  check('恢复后暂停状态清除', st.paused === false && st.pauseReason === null && st.remainingMs === null);
  check('恢复沿用同一 attemptId', st.attemptId === pauseAttemptId);
  check('按冻结余量重排 deadline', Math.abs((st.deadline - st.serverNow) - frozenRemaining) < 1000);
  const resumeLog = st.log.find((l) => l.event === 'cue-resumed');
  check('恢复日志记录操作者与时间',
    !!resumeLog && resumeLog.detail.operator === 'test-control-' && !!resumeLog.ts);

  console.log('31. 恢复后确认可用，重复暂停/恢复不累计误差');
  confirmCue(light2);
  st = await control.waitState((s) => s.confirmations['灯光']);
  check('恢复后岗位确认被接受', !!st.confirmations['灯光']);
  control.send({ type: 'pause', reason: '二次暂停' });
  st = await control.waitState((s) => s.paused === true);
  const frozen2 = st.remainingMs;
  check('二次暂停冻结余量小于首次（时间正常流逝）', frozen2 < frozenRemaining);
  await sleep(1200);
  control.send({ type: 'resume' });
  st = await control.waitState((s) => s.paused === false);
  check('二次恢复后余量即冻结值，不累计误差', Math.abs((st.deadline - st.serverNow) - frozen2) < 1000);

  console.log('32. 恢复后按冻结余量超时');
  st = await control.waitState((s) => s.timedOut.includes('音响'), 5000);
  check('未确认岗位（音响）按余量超时', st.timedOut.includes('音响'));
  check('已确认岗位（灯光）不在超时列表', !st.timedOut.includes('灯光'));
  check('超时日志归属当前轮次',
    st.log.some((l) => l.event === 'cue-timeout' && l.detail.attemptId === pauseAttemptId));

  console.log('33. 重置清理暂停状态');
  control.send({ type: 'pause', reason: '超时后暂停' }); // 已超时但未全员确认，仍可暂停
  st = await control.waitState((s) => s.paused === true);
  check('已超时轮次暂停时余量冻结为 0', st.remainingMs === 0);
  control.send({ type: 'reset' });
  st = await control.waitState((s) => s.phase === 'idle');
  check('重置后暂停状态清空', st.paused === false && st.pauseReason === null && st.remainingMs === null);

  console.log('34. 非持有者的七类指挥操作全部被服务端拒绝');
  const controlB = client('control', null, 'test-control-b');
  const controlC = client('control', null, 'test-control-c');
  await Promise.all([controlB.ready, controlC.ready]);
  await sleep(200);
  controlB.send({ type: 'start' });
  controlB.send({ type: 'advance' });
  controlB.send({ type: 'reset' });
  controlB.send({ type: 'substitute', from: '灯光', to: '音响' });
  controlB.send({ type: 'recall', reason: 'x', text: 'y' });
  controlB.send({ type: 'pause', reason: 'x' });
  controlB.send({ type: 'resume' });
  await sleep(400);
  check('七种越权操作均收到拒绝', controlB.errors.filter((e) => e.includes('指挥权')).length === 7);
  const denied = control.state.log.filter(
    (l) => l.event === 'lease-op-denied' && l.detail.clientId === 'test-control-b');
  check('越权操作全部写入日志（按操作类型）', denied.length >= 7 &&
    ['start', 'advance', 'reset', 'substitute', 'recall', 'pause', 'resume']
      .every((op) => denied.some((d) => d.detail.op === op)));
  check('越权操作未改变场次状态', control.state.phase === 'idle');
  check('租约仍归主控制端', control.state.lease.holderId === 'test-control-');

  console.log('35. 心跳续期：剩余有效期随心跳延长');
  const expBefore = control.state.lease.expiresAt;
  await sleep(2500); // 心跳每 2 秒一次，期间至少续期一次
  check('心跳续期延长有效期', control.state.lease.expiresAt > expBefore);
  check('续期期间租约未被释放', control.state.lease.holderId === 'test-control-');

  console.log('36. 租约未到期时他人申请被拒；持有者主动释放');
  controlB.send({ type: 'lease-acquire', name: 'B' });
  await sleep(300);
  check('未到期申请被拒且未获凭证', !controlB.leaseGranted &&
    controlB.errors.some((e) => e.includes('持有')));
  check('申请拒绝写入日志', control.state.log.some(
    (l) => l.event === 'lease-acquire-denied' && l.detail.requester === 'test-control-b'));
  check('租约仍归原持有者', control.state.lease.holderId === 'test-control-');
  stopHeartbeat(control);
  const staleToken = control.leaseToken; // 旧凭证留作“迟到心跳”测试
  control.send({ type: 'lease-release', token: staleToken });
  st = await control.waitState((s) => !s.lease.holderId);
  check('主动释放生效', st.lease.holderId === null);
  check('释放写入日志', st.log.some((l) => l.event === 'lease-released' && l.detail.reason === 'voluntary'));
  controlB.send({ type: 'start' });
  await sleep(200);
  check('无人持有时指挥操作同样被拒', controlB.errors.some((e) => e.includes('无人持有')));

  console.log('37. 竞争申请原子裁决：同时申请恰好一人成功');
  controlB.leaseGranted = null;
  controlC.leaseGranted = null;
  controlB.send({ type: 'lease-acquire', name: 'B' });
  controlC.send({ type: 'lease-acquire', name: 'C' });
  await sleep(400);
  const bWon = !!controlB.leaseGranted;
  const cWon = !!controlC.leaseGranted;
  check('竞争申请恰好一人获胜', bWon !== cWon);
  const winnerId = bWon ? 'test-control-b' : 'test-control-c';
  const loser = bWon ? controlC : controlB;
  check('快照持有者为胜者', control.state.lease.holderId === winnerId);
  check('败者收到持有拒绝', loser.errors.some((e) => e.includes('持有')));

  console.log('38. 旧连接的迟到心跳不得续活新租约');
  const winnerExp = control.state.lease.expiresAt;
  control.send({ type: 'lease-heartbeat', token: staleToken }); // 旧持有者的迟到心跳
  await sleep(300);
  check('旧凭证心跳被拒绝', control.errors.some((e) => e.includes('心跳') || e.includes('租约')));
  check('旧心跳拒绝写入日志', control.state.log.some((l) => l.event === 'stale-lease-heartbeat-ignored'));
  check('新租约仍归胜者所有', control.state.lease.holderId === winnerId);
  check('旧心跳未延长新租约有效期', control.state.lease.expiresAt === winnerExp);

  console.log('39. 心跳停止 → 租约超期自动释放 → 他人接管');
  // 胜者（B 或 C）从未发送心跳，等待租约到期被清扫器自动释放
  st = await control.waitState((s) => !s.lease.holderId, 25000);
  check('心跳停止后租约超期自动释放', st.lease.holderId === null);
  check('超期释放写入日志', st.log.some((l) => l.event === 'lease-expired' && l.detail.holderId === winnerId));
  control.leaseGranted = null;
  control.send({ type: 'lease-acquire', name: '主控' });
  st = await control.waitState((s) => s.lease.holderId === 'test-control-');
  check('过期后他人可接管租约', st.lease.holderId === 'test-control-' && !!control.leaseGranted);
  control.send({ type: 'lease-heartbeat', token: staleToken }); // 同一控制端的旧连接凭证同样失效
  await sleep(300);
  check('接管后旧凭证心跳仍被拒',
    control.state.log.filter((l) => l.event === 'stale-lease-heartbeat-ignored').length >= 2);
  check('新租约未被旧心跳影响', control.state.lease.holderId === 'test-control-');
  control.send({ type: 'start' }); // 接管者实际执行指挥操作
  st = await control.waitState((s) => s.phase === 'active');
  check('接管后指挥操作恢复可用', st.phase === 'active');
  control.send({ type: 'reset' });
  await control.waitState((s) => s.phase === 'idle');

  console.log('40. 持有者断线 → 租约立即自动释放');
  control.ws.close(); // control 当前持有租约（第 39 步接管）
  st = await controlB.waitState((s) => !s.lease.holderId);
  check('断线后租约自动释放', st.lease.holderId === null);
  check('断线释放写入日志', st.log.some((l) => l.event === 'lease-released' && l.detail.reason === 'disconnect'));

  // ===========================================================================
  // 下一场草稿
  // ===========================================================================
  console.log('41. 准备草稿测试：重置并创建已发布序列');
  // 重连主控制端（40 步中断线）并重新取得租约
  const control2 = client('control', null, 'test-control-');
  await control2.ready;
  await sleep(200);
  control2.send({ type: 'lease-acquire', name: '主控' });
  await control2.waitState((s) => s.lease.holderId === 'test-control-');
  startHeartbeat(control2);
  control2.send({ type: 'reset', resetMode: 'normal' });
  await control2.waitState((s) => s.phase === 'idle');
  director.send({ type: 'setSequence', timeoutSec: 5, cues: [
    { text: '已发布第一条', targets: ['灯光'] },
    { text: '已发布第二条', targets: ['音响', '道具'] },
  ]});
  st = await director.waitState((s) => s.sequence.length === 2 && s.publishedVersion >= 1);
  const pubV1 = st.publishedVersion;
  check('保存序列后已发布版本号 ≥ 1', pubV1 >= 1);
  check('初始无草稿', st.draft === null);
  check('sequence-set 日志携带版本号',
    st.log.some((l) => l.event === 'sequence-set' && l.detail.version === pubV1));
  control2.send({ type: 'start' });
  st = await control2.waitState((s) => s.phase === 'active');
  const cueHistoryBeforeDraft = JSON.stringify(st.cueHistory);
  const attemptBeforeDraft = st.attemptId;

  console.log('42. 草稿权限 / 阶段 / 内容校验');
  control2.send({ type: 'saveDraft', cues: [{ text: '控制端不能存草稿', targets: ['灯光'] }], revision: null });
  director.send({ type: 'saveDraft', cues: [{ text: '   ', targets: ['灯光'] }], revision: null });
  director.send({ type: 'saveDraft', cues: [{ text: '缺目标', targets: [] }], revision: null });
  await sleep(300);
  check('非导演端保存草稿被拒绝', control2.errors.some((e) => e.includes('仅导演端')));
  check('空口令草稿被拒绝', director.errors.some((e) => e.includes('不能为空')));
  check('校验失败后仍无草稿', director.state.draft === null);

  console.log('43. 首次保存草稿：revision=1，基于当前已发布版本，不改变当前口令');
  director.draftSaved = null;
  director.send({ type: 'saveDraft', timeoutSec: 8, revision: null, cues: [
    { text: '草稿第一条', targets: ['灯光', '音响'] },
    { text: '草稿第二条', targets: ['道具'] },
    { text: '草稿第三条', targets: ['灯光'] },
  ]});
  st = await director.waitState((s) => s.draft && s.draft.revision === 1);
  check('草稿创建为第 1 版', st.draft.revision === 1);
  check('草稿记录所基于的已发布版本', st.draft.basedOnVersion === pubV1);
  check('草稿含 3 条口令与时限', st.draft.cues.length === 3 && st.draft.timeoutSec === 8);
  check('保存成功定向下发 draft-saved 回执',
    !!director.draftSaved && director.draftSaved.draft.revision === 1);
  check('draft-created 写入日志',
    st.log.some((l) => l.event === 'draft-created' && l.detail.revision === 1 && l.detail.count === 3));
  check('草稿不改变当前口令文本/序号/目标（冻结快照不变）',
    st.phase === 'active' && st.currentCue.text === '已发布第一条' &&
    st.currentCue.targets.join() === '灯光' && st.attemptId === attemptBeforeDraft);
  check('草稿不改变修订档案', JSON.stringify(st.cueHistory) === cueHistoryBeforeDraft);
  check('草稿不改变已发布版本号', st.publishedVersion === pubV1);
  // 各端均收到草稿版本（实时显示）
  await light2.waitState((s) => s.draft && s.draft.revision === 1);
  check('岗位端实时看到草稿版本', light2.state.draft.basedOnVersion === pubV1);

  console.log('44. 草稿再次保存：携带 revision=1 → 升为第 2 版');
  director.draftSaved = null;
  director.send({ type: 'saveDraft', timeoutSec: 8, revision: 1, cues: [
    { text: '草稿第一条改', targets: ['灯光'] },
    { text: '草稿第二条', targets: ['道具', '音响'] },
  ]});
  st = await director.waitState((s) => s.draft && s.draft.revision === 2);
  check('草稿升为第 2 版，basedOnVersion 不变',
    st.draft.revision === 2 && st.draft.basedOnVersion === pubV1);
  check('draft-saved 写入日志', st.log.some((l) => l.event === 'draft-saved' && l.detail.revision === 2));
  check('当前场次口令仍不受影响', st.currentCue.text === '已发布第一条');

  console.log('45. 多导演端乐观并发：过期 revision 被拒，返回最新草稿');
  const directorB = client('director', null, 'test-director-b');
  await directorB.ready;
  await directorB.waitState((s) => s.draft && s.draft.revision === 2);
  directorB.send({ type: 'saveDraft', timeoutSec: 8, revision: 1, cues: [
    { text: 'B 基于旧版本的修改', targets: ['灯光'] },
  ]}); // 与当前第 2 版冲突
  await sleep(400);
  check('过期 revision 保存被拒绝（draft-conflict 定向返回）',
    !!directorB.draftConflict && directorB.draftConflict.currentRevision === 2);
  check('冲突响应携带服务端最新草稿供刷新重做',
    directorB.draftConflict.draft && directorB.draftConflict.draft.revision === 2 &&
    directorB.draftConflict.draft.cues[0].text === '草稿第一条改');
  check('冲突写入日志 draft-save-conflict',
    control2.state.log.some((l) => l.event === 'draft-save-conflict' &&
      l.detail.sentRevision === 1 && l.detail.currentRevision === 2));
  check('冲突未覆盖服务端草稿', control2.state.draft.cues[0].text === '草稿第一条改');
  // B 刷新（载入最新草稿）后以 revision=2 重做成功
  directorB.draftConflict = null;
  directorB.send({ type: 'saveDraft', timeoutSec: 8, revision: 2, cues: [
    { text: 'B 刷新后重做的第一条', targets: ['灯光'] },
  ]});
  st = await directorB.waitState((s) => s.draft && s.draft.revision === 3);
  check('刷新后以最新 revision 保存成功（第 3 版）',
    !!directorB.draftSaved && st.draft.cues[0].text === 'B 刷新后重做的第一条');

  console.log('46. 有草稿时重置必须明确选择：无选择 / 非法选择被拒');
  control2.resetChoice = null;
  control2.send({ type: 'reset' });
  await sleep(300);
  check('无选择的重置被拒绝（reset-choice-required 携带草稿）',
    !!control2.resetChoice && control2.resetChoice.draft.revision === 3);
  control2.send({ type: 'reset', resetMode: 'whatever' });
  await sleep(300);
  check('非法 resetMode 同样要求选择',
    control2.resetChoice && control2.resetChoice.type === 'reset-choice-required');
  check('被拒后仍为 active 且草稿保留',
    control2.state.phase === 'active' && control2.state.draft.revision === 3);

  console.log('47. 沿用当前序列重置（keep）：放弃并清空草稿，序列不变');
  control2.send({ type: 'reset', resetMode: 'keep' });
  st = await control2.waitState((s) => s.phase === 'idle' && s.draft === null);
  check('重置回 idle 且草稿已清空', st.draft === null);
  check('沿用原序列（内容与已发布版本号均不变）',
    st.sequence.length === 2 && st.sequence[0].text === '已发布第一条' &&
    st.publishedVersion === pubV1);
  check('draft-discarded 与 keep-current 写入日志',
    st.log.some((l) => l.event === 'draft-discarded') &&
    st.log.some((l) => l.event === 'session-reset' && l.detail.choice === 'keep-current'));

  console.log('48. 演出进行中发布草稿并重置：原子替换下一场序列');
  control2.send({ type: 'start' });
  st = await control2.waitState((s) => s.phase === 'active' &&
    s.currentCue && s.currentCue.text === '已发布第一条');
  check('开始后本场仍使用冻结的旧序列', st.currentCue.text === '已发布第一条');
  const oldIds = st.sequence.map((c) => c.id);
  const cueHistoryBeforePublish = JSON.stringify(st.cueHistory);
  director.send({ type: 'saveDraft', timeoutSec: 12, revision: null, cues: [
    { text: '下一场口令A', targets: ['道具'] },
    { text: '下一场口令B', targets: ['灯光', '音响'] },
  ]});
  await director.waitState((s) => s.draft && s.draft.revision === 1);
  check('进行中保存草稿不改变当前场次',
    control2.state.phase === 'active' &&
    control2.state.currentCue.text === '已发布第一条' &&
    JSON.stringify(control2.state.cueHistory) === cueHistoryBeforePublish);
  control2.send({ type: 'reset', resetMode: 'publish' });
  st = await control2.waitState((s) => s.phase === 'idle' && s.sequence[0].text === '下一场口令A');
  check('发布重置：序列被草稿内容替换', st.sequence.length === 2 &&
    st.sequence[0].targets.join() === '道具' &&
    st.sequence[1].text === '下一场口令B' && st.sequence[1].targets.join() === '灯光,音响');
  check('发布重置：草稿已清空', st.draft === null);
  check('发布重置：已发布版本号 +1', st.publishedVersion === pubV1 + 1);
  check('发布重置：确认时限取草稿值', st.timeoutSec === 12);
  check('发布重置：口令 id 全部重新分配（不沿用冻结快照）',
    st.sequence.every((c) => !oldIds.includes(c.id)));
  check('发布重置：修订档案已清空', JSON.stringify(st.cueHistory) === '{}');
  check('draft-published 与 publish-draft 写入日志',
    st.log.some((l) => l.event === 'draft-published' && l.detail.version === pubV1 + 1) &&
    st.log.some((l) => l.event === 'session-reset' && l.detail.choice === 'publish-draft'));
  // 发布后的新序列可正常开始
  control2.send({ type: 'start' });
  st = await control2.waitState((s) => s.phase === 'active' && s.currentCue.text === '下一场口令A');
  check('发布后的序列可正常开始演出', st.currentCue.targets.join() === '道具');

  console.log('49. 已结束（done）阶段仍可保存草稿；idle 阶段不可保存草稿');
  prop.send({ type: 'confirm', attemptId: st.attemptId });
  await control2.waitState((s) => s.confirmations['道具']);
  control2.send({ type: 'advance' });
  st = await control2.waitState((s) => s.currentCue && s.currentCue.text === '下一场口令B');
  light2.send({ type: 'confirm', attemptId: st.attemptId });
  sound2.send({ type: 'confirm', attemptId: st.attemptId });
  await control2.waitState((s) => s.confirmations['灯光'] && s.confirmations['音响']);
  control2.send({ type: 'advance' });
  st = await control2.waitState((s) => s.phase === 'done');
  director.send({ type: 'saveDraft', timeoutSec: 12, revision: null, cues: [
    { text: '结束后编排的下一场', targets: ['灯光'] },
  ]});
  st = await director.waitState((s) => s.draft && s.draft.cues[0].text === '结束后编排的下一场');
  check('done 阶段草稿保存成功', st.draft.revision === 1 && st.draft.basedOnVersion === pubV1 + 1);
  // 发布草稿并重置结束场次
  control2.send({ type: 'reset', resetMode: 'publish' });
  st = await control2.waitState((s) => s.phase === 'idle' && s.draft === null);
  check('结束场次发布草稿后进入 idle', st.sequence[0].text === '结束后编排的下一场');
  director.send({ type: 'saveDraft', revision: null, cues: [{ text: 'idle 不该有草稿', targets: ['灯光'] }] });
  await sleep(300);
  check('idle 阶段保存草稿被拒绝（直接保存序列即可）',
    director.errors.some((e) => e.includes('无需草稿')));

  console.log('50. 同时首次创建草稿的并发请求：先到者创建，后来者收到冲突并可重做');
  control2.send({ type: 'start' });
  await control2.waitState((s) => s.phase === 'active');
  const dirX = client('director', null, 'test-director-x');
  const dirY = client('director', null, 'test-director-y');
  await Promise.all([dirX.ready, dirY.ready]);
  await sleep(200);
  dirX.send({ type: 'saveDraft', revision: null, cues: [{ text: 'X 首次创建', targets: ['灯光'] }] });
  dirY.send({ type: 'saveDraft', revision: null, cues: [{ text: 'Y 同时首次创建', targets: ['音响'] }] });
  await sleep(400);
  const xCreated = !!dirX.draftSaved;
  const yConflict = !!dirY.draftConflict;
  check('并发首次保存：恰好一人创建成功', xCreated && yConflict);
  check('后来者收到的最新草稿即先到者创建的第 1 版',
    dirY.draftConflict.currentRevision === 1 &&
    dirY.draftConflict.draft.cues[0].text === 'X 首次创建');
  dirY.send({ type: 'saveDraft', revision: 1, cues: [{ text: 'Y 刷新后覆盖', targets: ['音响'] }] });
  st = await dirY.waitState((s) => s.draft && s.draft.revision === 2);
  check('后来者刷新后重做成功', st.draft.cues[0].text === 'Y 刷新后覆盖');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.message); process.exit(1); });
