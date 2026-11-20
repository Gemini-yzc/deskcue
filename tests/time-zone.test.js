const test = require('node:test');
const assert = require('node:assert/strict');
const { wallInstant, dateKey, validateTimeZone } = require('../src/time-zone');
const { validateTask, reminderState, collectWeeklyMisses, completeTask } = require('../src/domain');

test('太平洋时间按日期离线区分夏令时和冬令时', () => {
  const zone = 'America/Los_Angeles';
  assert.equal(wallInstant('2026-07-07T09:00', zone), Date.parse('2026-07-07T16:00Z'));
  assert.equal(wallInstant('2026-11-17T09:00', zone), Date.parse('2026-11-17T17:00Z'));
  assert.equal(wallInstant('2026-03-08T02:30', zone), Date.parse('2026-03-08T10:00Z'));
  assert.equal(wallInstant('2026-11-01T01:30', zone), Date.parse('2026-11-01T08:30Z'));
});

test('支持 30 分钟季节跳转及 45 分钟偏移', () => {
  assert.equal(wallInstant('2026-10-04T02:10', 'Australia/Lord_Howe'), Date.parse('2026-10-03T15:30Z'));
  assert.equal(wallInstant('2026-11-17T09:00', 'Asia/Kathmandu'), Date.parse('2026-11-17T03:15Z'));
  assert.equal(validateTimeZone('UTC'), 'UTC');
  assert.throws(() => validateTimeZone('Invalid/Zone'), /有效时区/);
});

test('按事项时区判断周几与过午夜，不受电脑时区影响', () => {
  const zone = 'Asia/Singapore';
  const now = new Date('2026-11-17T01:00Z');
  const task = validateTask({
    title: '每周检查', category: 'daily', frequency: 'weekly', weekday: 2, priority: 1, reminderMode: 'relative',
  }, null, now, zone);
  assert.equal(reminderState(task, now, zone).active, true);
  const midnight = new Date('2026-11-17T16:00Z');
  assert.equal(dateKey(midnight, zone), '2026-11-18');
  assert.equal(collectWeeklyMisses(task, midnight, zone).weeklyMisses[0].date, '2026-11-17');
  completeTask(task, now, zone);
  assert.equal(reminderState(task, now, zone).active, false);
  assert.deepEqual(collectWeeklyMisses(task, midnight, zone).weeklyMisses, []);
});

test('地区跳过一整天时，定期任务不产生错过记录', () => {
  const zone = 'Pacific/Apia';
  const task = validateTask({
    title: '每周检查', category: 'daily', frequency: 'weekly', weekday: 5, priority: 1,
    startDate: '2011-12-30', endDate: '2011-12-30', reminderMode: 'relative',
  }, null, new Date('2011-12-29T01:00Z'), zone);
  assert.deepEqual(collectWeeklyMisses(task, new Date('2011-12-31T12:00Z'), zone).weeklyMisses, []);
});
