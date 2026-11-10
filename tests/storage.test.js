const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage, parseState } = require('../src/storage');
const { validateTask, dateKey } = require('../src/domain');
function setup(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskcue-test-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return new Storage(directory); }
function task(patch = {}) { return { ...validateTask({ title: '中文保存测试', category: 'action', priority: 1, reminderMode: 'off' }), ...patch }; }
test('原子保存后重启恢复所有事项、提醒标记和设置', t => {
  const store = setup(t);
  const state = { version: 1, tasks: [task({ notifiedKey: 'once:123' })], settings: { mode: 'top', compact: true } };
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
