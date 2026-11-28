const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage, parseState, configureTimeZone, migrateState } = require('../src/storage');
const { validateTask, dateKey, collectWeeklyMisses, acknowledgeWeeklyMisses, reminderState } = require('../src/domain');
const { DEFAULT_ZONE } = require('../src/time-zone');
function setup(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskcue-test-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return new Storage(directory); }
function task(patch = {}) { return { ...validateTask({ title: '中文保存测试', category: 'action', priority: 1, reminderMode: 'off' }), ...patch }; }
test('原子保存后重启恢复所有事项、提醒标记和设置', t => {
  const store = setup(t);
  const state = store.load();
  state.tasks = [task({ notifiedKey: 'once:123' })];
  Object.assign(state.settings, { mode: 'top', compact: true });
  store.save(state);
  assert.deepEqual(new Storage(store.directory).load(), state);
  assert.equal(fs.existsSync(`${store.file}.tmp`), false);
});
test('损坏主文件从备份恢复，保留原文件证据', t => {
  const store = setup(t); const state = store.load(); state.tasks.push(task()); store.save(state);
  fs.writeFileSync(store.file, '{broken');
  const restored = new Storage(store.directory); assert.deepEqual(restored.load(), state); assert.equal(restored.recovered, true);
  assert.equal(fs.readdirSync(store.directory).some(name => name.startsWith('tasks.json.corrupt-')), true);
});
test('没有有效备份时拒绝静默重置数据', t => {
  const store = setup(t); fs.writeFileSync(store.file, '{broken');
  assert.throws(() => store.load(), /没有可用备份/);
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
});
test('过期取消事项同时从主文件和保留备份中清除', t => {
  const store = setup(t); const state = store.load();
  const old = task({ status: 'canceled', canceledAt: new Date('2024-11-09T10:00:00').toISOString() }); state.tasks = [old];
  const now = new Date('2026-11-09T12:00:00'); const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  fs.writeFileSync(path.join(store.backups, `${dateKey(yesterday)}.json`), JSON.stringify(state));
  const clean = store.save(state, now); assert.equal(clean.tasks.length, 0);
  for (const name of store.backupNames()) assert.equal(parseState(fs.readFileSync(path.join(store.backups, name), 'utf8')).tasks.length, 0);
});
test('备份只保留最近七个日历日，写入失败不会覆盖内存中的旧数据', t => {
  const store = setup(t); const state = store.load(); const now = new Date('2026-11-09T12:00:00');
  for (let days = 9; days >= 0; days--) { const date = new Date(now); date.setDate(date.getDate() - days); store.save(state, date); }
  assert.equal(store.backupNames().length, 7);
  const original = fs.readFileSync(store.file, 'utf8');
  fs.mkdirSync(`${store.file}.tmp`);
  assert.throws(() => store.save({ ...state, tasks: [task()] }));
  assert.equal(fs.readFileSync(store.file, 'utf8'), original);
});

test('待确认的错过记录跨重启保留，取消满一年后仍可确认和清理', t => {
  const store = setup(t);
  const state = store.load();
  const created = new Date('2024-11-04T12:00:00');
  const canceled = new Date('2024-11-06T12:00:00');
  const now = new Date('2026-11-10T12:00:00');
  const planned = validateTask({
    title: '检查备份', category: 'daily', frequency: 'weekly', weekday: 2, priority: 1, reminderMode: 'relative',
  }, null, created);
  const weekly = collectWeeklyMisses(planned, canceled);
  weekly.weeklyMisses[0].notified = true;
  state.tasks.push({ ...weekly, status: 'canceled', canceledAt: canceled.toISOString() });
  store.save(state, now);
  const restored = new Storage(store.directory).load();
  assert.deepEqual(restored.tasks[0].weeklyMisses, [{ date: '2024-11-05', notified: true, acknowledged: false }]);
  acknowledgeWeeklyMisses(restored.tasks[0], ['2024-11-05']);
  store.save(restored, now);
  assert.deepEqual(new Storage(store.directory).load().tasks, []);
});

test('旧版单日和新版多日排期可一起读写并恢复', t => {
  const store = setup(t);
  const state = store.load();
  const now = new Date('2026-11-09T20:00:00Z');
  const weeklyInput = { title: '检查备份', category: 'daily', frequency: 'weekly', weekday: 2, priority: 1, reminderMode: 'relative' };
  const legacy = validateTask(weeklyInput, null, now, DEFAULT_ZONE);
  assert.equal(legacy.weekdays, undefined);
  state.tasks.push(legacy);
  fs.writeFileSync(store.file, JSON.stringify(state));
  const upgraded = store.load();
  assert.deepEqual(upgraded.tasks, [legacy]);

  const workdays = validateTask({ ...weeklyInput, weekdays: [1, 2, 3, 4, 5] }, null, now, DEFAULT_ZONE);
  upgraded.tasks.push(workdays);
  store.save(upgraded, now);
  const reopened = new Storage(store.directory).load();
  assert.deepEqual(reopened.tasks, [legacy, workdays]);
  assert.deepEqual(reopened.tasks[1].weekdays, [1, 2, 3, 4, 5]);
});

test('旧版东八区数据升级为太平洋时间，保留钟点、通知标记和已有错过', t => {
  const store = setup(t);
  const now = new Date('2026-11-17T18:00:00Z');
  const once = task({
    reminderMode: 'absolute', reminderAt: '2026-11-17T01:00:00.000Z', dueAt: '2026-11-17T10:00:00.000Z',
    notifiedKey: `once:${Date.parse('2026-11-17T01:00:00Z')}`,
  });
  const weekly = collectWeeklyMisses(validateTask({
    title: '检查备份', category: 'daily', frequency: 'weekly', weekday: 2, priority: 1, reminderMode: 'relative',
  }, null, new Date('2026-11-02T12:00:00Z'), 'Asia/Singapore'), new Date('2026-11-04T12:00:00Z'), 'Asia/Singapore');
  const legacy = { version: 1, tasks: [once, weekly], settings: { mode: 'normal', compact: false } };
  const state = migrateState(legacy, now);
  assert.equal(state.version, 2);
  assert.equal(state.settings.timeZone, DEFAULT_ZONE);
  assert.equal(state.tasks[0].reminderAt, '2026-11-17T09:00:00.000');
  assert.equal(state.tasks[0].dueAt, '2026-11-17T18:00:00.000');
  assert.equal(reminderState(state.tasks[0], now, DEFAULT_ZONE).at, Date.parse('2026-11-17T17:00:00Z'));
  assert.equal(reminderState(state.tasks[0], now, DEFAULT_ZONE).key, state.tasks[0].notifiedKey);
  assert.deepEqual(state.tasks[1].weeklyMisses, weekly.weeklyMisses);
  assert.equal(state.tasks[1].weeklySince, '2026-11-17');
  store.save(state, now);
  assert.deepEqual(new Storage(store.directory).load(), state);
});

test('固定时区切换与跟随电脑按新时区重算并保留原钟点', t => {
  const state = setup(t).load();
  const now = new Date('2026-11-16T18:30:00Z');
  state.tasks.push(task({ reminderMode: 'absolute', reminderAt: '2026-11-17T09:00' }));
  const singapore = configureTimeZone(state, 'system', now, 'Asia/Singapore');
  assert.equal(singapore.settings.effectiveTimeZone, 'Asia/Singapore');
  assert.equal(reminderState(singapore.tasks[0], now, singapore.settings.effectiveTimeZone).active, false);
  const tokyo = configureTimeZone(singapore, 'Asia/Tokyo', now, 'Asia/Singapore');
  assert.equal(tokyo.tasks[0].reminderAt, state.tasks[0].reminderAt);
  assert.equal(reminderState(tokyo.tasks[0], new Date('2026-11-17T00:30Z'), tokyo.settings.effectiveTimeZone).active, true);
});
