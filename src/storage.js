const fs = require('node:fs');
const path = require('node:path');
const { dateKey, validateTask, STATUSES, purgeCanceled } = require('./domain');

function parseState(raw) {
  const state = JSON.parse(raw);
  if (state.version !== 1 || !Array.isArray(state.tasks) || state.tasks.length > 50000) throw new Error('数据版本或事项列表无效');
  const ids = new Set();
  for (const task of state.tasks) {
    validateTask(task);
    if (typeof task.id !== 'string' || !task.id || ids.has(task.id) || !STATUSES.includes(task.status) || !Number.isFinite(task.order)) throw new Error('事项标识、顺序或状态无效');
    for (const key of ['createdAt', 'updatedAt']) if (!Number.isFinite(Date.parse(task[key]))) throw new Error('记录时间无效');
    if (task.status === 'canceled' && !Number.isFinite(Date.parse(task.canceledAt))) throw new Error('取消时间无效');
    ids.add(task.id);
  }
  state.settings = { mode: 'normal', compact: false, ...state.settings };
  if (!['normal', 'top', 'desktop'].includes(state.settings.mode)) state.settings.mode = 'normal';
  return state;
}
class Storage {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'tasks.json');
    this.backups = path.join(directory, 'backups');
    fs.mkdirSync(this.backups, { recursive: true });
    const probe = path.join(directory, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    this.recovered = false;
  }
  load() {
    if (!fs.existsSync(this.file)) return { version: 1, tasks: [], settings: { mode: 'normal', compact: false } };
    try { return parseState(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      for (const name of this.backupNames().reverse()) {
        try {
          const state = parseState(fs.readFileSync(path.join(this.backups, name), 'utf8'));
          fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
          state.tasks = purgeCanceled(state.tasks);
          this.save(state);
          this.recovered = true;
          return state;
        } catch (backupError) { if (backupError.code && backupError.code !== 'ENOENT') throw backupError; }
      }
      throw new Error(`数据无法读取，且没有可用备份。原文件已保留：${this.file}。${error.message}`);
    }
  }
  backupNames() { return fs.readdirSync(this.backups).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort(); }
  atomicWrite(file, contents) {
    const temp = `${file}.tmp`;
    const fd = fs.openSync(temp, 'w');
    try { fs.writeFileSync(fd, contents, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  }
  save(state, now = new Date()) {
    parseState(JSON.stringify(state));
    const clean = { ...state, tasks: purgeCanceled(state.tasks, now) };
    this.atomicWrite(this.file, JSON.stringify(clean, null, 2));
    // Backups are best effort; a failed backup must not turn a successful save into a duplicate action.
    try {
      this.atomicWrite(path.join(this.backups, `${dateKey(now)}.json`), JSON.stringify(clean, null, 2));
      const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 6);
      for (const name of this.backupNames()) {
        const file = path.join(this.backups, name);
        if (name.slice(0, 10) < dateKey(cutoff)) { fs.unlinkSync(file); continue; }
        const backup = parseState(fs.readFileSync(file, 'utf8'));
        const filtered = purgeCanceled(backup.tasks, now);
        if (filtered.length !== backup.tasks.length) this.atomicWrite(file, JSON.stringify({ ...backup, tasks: filtered }, null, 2));
      }
      this.backupError = '';
    } catch (error) { this.backupError = error.message; }
    return clean;
  }
}
module.exports = { Storage, parseState };
