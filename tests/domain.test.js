const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateTask, reminderState, completeTask, purgeCanceled, cancelExpiry, sortedTasks, reorderTasks,
  collectWeeklyMisses, acknowledgeWeeklyMisses,
} = require('../src/domain');
const local = value => new Date(value);
const make = (patch = {}) => validateTask({ title: '测试事项', category: 'action', priority: 1, reminderMode: 'relative', dueAt: local('2026-11-09T18:00:00').toISOString(), leadMinutes: 60, ...patch }, null, local('2026-11-09T09:00:00'));

test('提前提醒精确触发，并持续到闭环，查看或已通知不会关闭提醒', () => {
  const task = make();
  assert.equal(reminderState(task, local('2026-11-09T16:59:59')).active, false);
  assert.equal(reminderState(task, local('2026-11-09T17:00:00')).active, true);
  task.notifiedKey = reminderState(task, local('2026-11-09T17:00:00')).key;
  assert.equal(reminderState(task, local('2026-11-12T18:00:00')).active, true);
  completeTask(task); assert.equal(reminderState(task).active, false);
});
test('指定提醒时间独立于截止日期，关闭提醒不会闪耀', () => {
  const task = make({ reminderMode: 'absolute', reminderAt: local('2026-11-09T12:00:00').toISOString(), dueAt: null });
  assert.equal(reminderState(task, local('2026-11-09T12:00:00')).active, true);
  task.reminderMode = 'off'; assert.equal(reminderState(task).active, false);
});
test('每日关注只闭环当天，次日重新提醒，开始前不提醒', () => {
  const task = make({ category: 'daily', startDate: '2026-11-09', endDate: '2026-11-12', dailyTime: '09:30' });
  assert.equal(reminderState(task, local('2026-11-08T12:00:00')).active, false);
  assert.equal(reminderState(task, local('2026-11-09T09:29:00')).active, false);
  assert.equal(reminderState(task, local('2026-11-09T09:30:00')).active, true);
  completeTask(task, local('2026-11-09T10:00:00'));
  assert.equal(task.status, 'active');
  assert.equal(reminderState(task, local('2026-11-09T12:00:00')).active, false);
  assert.equal(reminderState(task, local('2026-11-10T09:30:00')).active, true);
});
test('每日最后一天未闭环时跨日仍保留提醒，确认后完成整项', () => {
  const task = make({ category: 'daily', endDate: '2026-11-09', dailyTime: '09:00' });
  assert.equal(reminderState(task, local('2026-11-20T09:00:00')).active, true);
  completeTask(task, local('2026-11-20T09:00:00'));
  assert.equal(task.status, 'completed');
  assert.equal(reminderState(task).active, false);
});
test('等待事项以跟进日期为提醒基准，转本人时可以保留相同提醒时刻', () => {
  const task = make({ category: 'waiting', followUpAt: local('2026-11-09T15:00:00').toISOString() });
  const previous = reminderState(task, local('2026-11-09T14:30:00'));
  assert.equal(previous.active, true);
  task.reminderAt = new Date(previous.at).toISOString(); task.reminderMode = 'absolute'; task.category = 'action';
  assert.deepEqual(reminderState(task, local('2026-11-09T14:30:00')), previous);
});
test('取消记录满一年时仍保留，超过一年清除；闰日按次年二月末计算', () => {
  const task = { ...make(), status: 'canceled', canceledAt: local('2024-02-29T10:00:00').toISOString() };
  const expiry = cancelExpiry(task.canceledAt);
  assert.equal(expiry.getFullYear(), 2025); assert.equal(expiry.getMonth(), 1); assert.equal(expiry.getDate(), 28);
  assert.equal(purgeCanceled([task], expiry).length, 1);
  assert.equal(purgeCanceled([task], new Date(expiry.getTime() + 1)).length, 0);
  task.status = 'active'; assert.equal(purgeCanceled([task], local('2026-11-09T12:00:00')).length, 1);
});
test('分类固定每日、本人、外部，分类内按优先级和手动顺序排列', () => {
  const tasks = [make({ category: 'waiting' }), make({ category: 'daily', priority: 2 }), make({ priority: 0 }), make({ priority: 2 })];
  const result = sortedTasks(tasks);
  assert.deepEqual(result.map(task => task.category), ['daily', 'action', 'action', 'waiting']);
  assert.deepEqual(result.slice(1, 3).map(task => task.priority), [0, 2]);
});
test('拒绝无效日期、倒置范围、无锚点提醒和非法输入', () => {
  assert.throws(() => make({ category: 'daily', startDate: '2026-02-30' }), /日期/);
  assert.throws(() => make({ category: 'daily', startDate: '2026-11-12', endDate: '2026-11-09' }), /结束/);
  assert.throws(() => make({ dueAt: null }), /需要/);
  assert.throws(() => make({ priority: 99 }), /优先级/);
  assert.throws(() => make({ title: ' ' }), /标题/);
  assert.throws(() => make({ dailyTime: '25:00' }), /时间/);
});
test('同级先按截止日期、无截止排最后；拖动覆盖日期顺序，重置恢复', () => {
  const a = make({ dueAt: '2026-11-15T18:00:00Z' });
  const b = make({ dueAt: '2026-11-11T18:00:00Z' });
  const c = make({ dueAt: null, reminderMode: 'off' });
  const tasks = [a, c, b];
  assert.deepEqual(sortedTasks(tasks).map(t => t.id), [b.id, a.id, c.id]);
  reorderTasks(tasks, a.id, b.id);
  assert.deepEqual(sortedTasks(tasks).map(t => t.id), [a.id, b.id, c.id]);
  const d = make({ dueAt: '2026-11-10T18:00:00Z' });
  tasks.push(d);
  assert.deepEqual(sortedTasks(tasks).map(t => t.id), [a.id, b.id, c.id, d.id]);
  tasks.forEach(t => { t.manualOrder = null; });
  assert.equal(sortedTasks(tasks)[0].id, d.id);
  assert.throws(() => reorderTasks([...tasks, make({ priority: 0 })], a.id, 'missing'), /只能拖动/);
});

const weeklyInput = { title: '检查备份', category: 'daily', priority: 1, frequency: 'weekly', weekday: 2, reminderMode: 'relative' };
const weeklyAt = (day, time = '12:00') => local(`2026-11-${day}T${time}:00`);

test('每周二本地时间触发，当晚仍可完成，下周恢复', () => {
  let task = validateTask(weeklyInput, null, weeklyAt('09'));
  assert.throws(() => validateTask({ ...weeklyInput, weekday: null }), /提醒日/);
  assert.equal(reminderState(task, weeklyAt('09')).active, false);
  assert.equal(reminderState(task, weeklyAt('10', '08:59')).active, false);
  assert.equal(reminderState(task, weeklyAt('10', '09:00')).active, true);
  const evening = weeklyAt('10', '23:57');
  const today = validateTask(weeklyInput, null, evening);
  assert.equal(reminderState(today, evening).active, true);
  completeTask(task, evening);
  assert.equal(reminderState(task, evening).active, false);
  assert.equal(reminderState(task, weeklyAt('11')).active, false);
  assert.throws(() => completeTask(task, weeklyAt('11')), /安排当天/);
  task = collectWeeklyMisses(task, weeklyAt('17'));
  assert.deepEqual(task.weeklyMisses, []);
  assert.equal(reminderState(task, weeklyAt('17')).active, true);
});

test('跨两个周二后补齐，新一轮完成和错过确认分别处理', () => {
  const now = weeklyAt('24');
  let task = validateTask(weeklyInput, null, weeklyAt('09'));
  task = collectWeeklyMisses(task, now);
  assert.deepEqual(task.weeklyMisses.map(miss => miss.date), ['2026-11-10', '2026-11-17']);
  assert.equal(collectWeeklyMisses(task, now), task);
  assert.equal(reminderState(task, now).active, true);
  completeTask(task, now);
  assert.equal(reminderState(task, now).active, false);
  assert.equal(task.weeklyMisses.every(miss => !miss.acknowledged), true);
  acknowledgeWeeklyMisses(task, ['2026-11-10']);
  acknowledgeWeeklyMisses(task, ['2026-11-10']);
  assert.deepEqual(task.weeklyMisses.map(miss => miss.acknowledged), [true, false]);
  assert.throws(() => acknowledgeWeeklyMisses(task, ['invalid']), /错过日期/);
  assert.equal(collectWeeklyMisses(task, weeklyAt('25')).weeklyMisses.length, 2);
});

test('修改和恢复计划从当日生效，起止日期包含当天，暂停期间略过', () => {
  let task = validateTask({ ...weeklyInput, startDate: '2026-11-10' }, null, weeklyAt('09'));
  task = collectWeeklyMisses(task, weeklyAt('11'));
  task = validateTask({ ...task, reminderMode: 'off' }, task, weeklyAt('11'));
  assert.equal(collectWeeklyMisses(task, weeklyAt('18')), task);
  task = validateTask({ ...task, weekday: 5, endDate: '2026-11-20', reminderMode: 'relative' }, task, weeklyAt('18'));
  assert.equal(reminderState(task, weeklyAt('20')).active, true);
  task = collectWeeklyMisses(task, weeklyAt('24'));
  assert.equal(reminderState(task, weeklyAt('24')).active, false);
  assert.deepEqual(task.weeklyMisses.map(miss => miss.date), ['2026-11-10', '2026-11-20']);
  const newTask = validateTask({ ...weeklyInput, startDate: '2026-11-01' }, null, weeklyAt('12'));
  assert.equal(collectWeeklyMisses(newTask, weeklyAt('16')), newTask);
});
