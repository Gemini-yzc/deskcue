const fs = require('node:fs');
const path = require('node:path');
const { dateKey, validDate, validateTask, isWeekly, STATUSES, purgeCanceled, reminderState } = require('./domain');
const { DEFAULT_ZONE, LEGACY_ZONE, effectiveTimeZone, moveDay, wallTime, wallValue, validateTimeZone } = require('./time-zone');
const calendarFields = ['dueAt', 'followUpAt', 'reminderAt'];

function configureTimeZone(state, setting, now, systemZone) {
  const zone = effectiveTimeZone(setting, systemZone);
  const changed = state.settings.effectiveTimeZone !== zone;
  const today = dateKey(now, zone);
  const tasks = changed ? state.tasks.map(task => isWeekly(task) && task.status === 'active' ?
    { ...task, weeklySince: today } : task) : state.tasks;
  const settings = { ...state.settings, timeZone: setting, effectiveTimeZone: zone };
  return { ...state, tasks, settings };
}

function migrateState(state, now = new Date()) {
  if (state.version === 2) return state;
  const tasks = state.tasks.map(previous => {
    const task = { ...previous };
    for (const field of calendarFields) if (task[field]) task[field] = wallTime(task[field], LEGACY_ZONE);
    if (task.notifiedKey?.startsWith('once:') && task.notifiedKey === reminderState(previous, now, LEGACY_ZONE).key) {
      task.notifiedKey = reminderState(task, now, DEFAULT_ZONE).key;
    }
    return task;
  });
  return configureTimeZone({ ...state, version: 2, tasks }, DEFAULT_ZONE, now);
}

function parseState(raw) {
  const state = JSON.parse(raw);
  if (![1, 2].includes(state.version) || !Array.isArray(state.tasks) || state.tasks.length > 50000) throw new Error('数据版本或事项列表无效');
  const ids = new Set();
  for (const task of state.tasks) {
    validateTask(task);
    if (typeof task.id !== 'string' || !task.id || ids.has(task.id) || !STATUSES.includes(task.status) || !Number.isFinite(task.order)) throw new Error('事项标识、顺序或状态无效');
    for (const key of ['createdAt', 'updatedAt']) if (!Number.isFinite(Date.parse(task[key]))) throw new Error('记录时间无效');
    if (task.status === 'canceled' && !Number.isFinite(Date.parse(task.canceledAt))) throw new Error('取消时间无效');
    if (state.version === 2 && calendarFields.some(field => task[field] != null && !wallValue(task[field]))) throw new Error('事项日期时刻无效');
    if (task.completionDates !== undefined && (!Array.isArray(task.completionDates) || !task.completionDates.every(validDate))) throw new Error('完成日期无效');
    if (task.recentNotifiedKeys !== undefined && (!Array.isArray(task.recentNotifiedKeys) || !task.recentNotifiedKeys.every(key => typeof key === 'string'))) throw new Error('通知记录无效');
    if ((isWeekly(task) && !validDate(task.weeklySince)) || (task.weeklyDone && !validDate(task.weeklyDone))) throw new Error('每周计划记录无效');
    if (task.weeklyMisses !== undefined) {
      if (!Array.isArray(task.weeklyMisses)) throw new Error('错过记录无效');
      const dates = new Set();
      for (const miss of task.weeklyMisses) {
        if (!miss || !validDate(miss.date) || dates.has(miss.date) ||
            typeof miss.notified !== 'boolean' || typeof miss.acknowledged !== 'boolean') throw new Error('错过记录无效');
        dates.add(miss.date);
      }
    }
    ids.add(task.id);
  }
  state.settings = { mode: 'normal', compact: false, ...state.settings };
  if (state.version === 2) {
    validateTimeZone(state.settings.timeZone);
    if (validateTimeZone(state.settings.effectiveTimeZone) === 'system') throw new Error('事项时区无效');
  }
  if (!['normal', 'top', 'desktop'].includes(state.settings.mode)) state.settings.mode = 'normal';
  if (state.settings.backgrounds !== undefined) {
    if (!Array.isArray(state.settings.backgrounds) || state.settings.backgrounds.length > 3) throw new Error('自定义图片最多三张');
    const images = new Set();
    for (const image of state.settings.backgrounds) {
      if (!image || !/^[0-9a-f]{64}$/.test(image.id) || !/^[0-9a-f]{64}\.(png|jpg|webp)$/.test(image.file) || image.file.split('.')[0] !== image.id || !Number.isFinite(Date.parse(image.addedAt)) || images.has(image.id)) throw new Error('背景图片记录无效');
      images.add(image.id);
    }
  }
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
    if (!fs.existsSync(this.file)) return configureTimeZone({ version: 2, tasks: [], settings: { mode: 'normal', compact: false } }, DEFAULT_ZONE, new Date());
    try { return migrateState(parseState(fs.readFileSync(this.file, 'utf8'))); }
    catch (error) {
      for (const name of this.backupNames().reverse()) {
        try {
          const state = migrateState(parseState(fs.readFileSync(path.join(this.backups, name), 'utf8')));
          fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
          state.tasks = purgeCanceled(state.tasks, new Date(), state.settings.effectiveTimeZone);
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
    const zone = state.settings.effectiveTimeZone;
    const clean = { ...state, tasks: purgeCanceled(state.tasks, now, zone) };
    this.atomicWrite(this.file, JSON.stringify(clean, null, 2));
    // Backups are best effort; a failed backup must not turn a successful save into a duplicate action.
    try {
      const today = dateKey(now, zone);
      this.atomicWrite(path.join(this.backups, `${today}.json`), JSON.stringify(clean, null, 2));
      const cutoff = moveDay(today, -6);
      for (const name of this.backupNames()) {
        const file = path.join(this.backups, name);
        if (name.slice(0, 10) < cutoff) { fs.unlinkSync(file); continue; }
        const backup = parseState(fs.readFileSync(file, 'utf8'));
        const filtered = purgeCanceled(backup.tasks, now, zone);
        if (filtered.length !== backup.tasks.length) this.atomicWrite(file, JSON.stringify({ ...backup, tasks: filtered }, null, 2));
      }
      this.backupError = '';
    } catch (error) { this.backupError = error.message; }
    return clean;
  }
}
module.exports = { Storage, parseState, configureTimeZone, migrateState };
