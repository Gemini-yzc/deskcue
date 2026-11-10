const { randomUUID } = require('node:crypto');

const CATEGORIES = ['daily', 'action', 'waiting'];
const STATUSES = ['active', 'completed', 'canceled'];
function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && dateKey(date) === value;
}
function instant(value, label) {
  if (!value) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label}不是有效时间`);
  return new Date(value).toISOString();
}
function validateTask(input, previous = null, now = new Date()) {
  if (!input || typeof input !== 'object') throw new Error('事项格式无效');
  const title = String(input.title || '').trim();
  if (!title || title.length > 200) throw new Error('事项标题需为1至200个字符');
  if (!CATEGORIES.includes(input.category)) throw new Error('请选择有效分类');
  if (![0, 1, 2].includes(input.priority)) throw new Error('优先级无效');
  const text = (value, max) => String(value || '').trim().slice(0, max);
  const task = {
    id: previous?.id || randomUUID(), title, category: input.category, priority: input.priority,
    order: previous?.order ?? now.getTime(), status: previous?.status || 'active',
    description: text(input.description, 4000), waitingFor: text(input.waitingFor, 200),
    startDate: input.startDate || '', endDate: input.endDate || '', dailyTime: input.dailyTime || '09:00',
    dueAt: instant(input.dueAt, '最后期限'), followUpAt: instant(input.followUpAt, '跟进时间'),
    reminderMode: input.reminderMode || 'off', reminderAt: instant(input.reminderAt, '提醒时间'),
    leadMinutes: Number(input.leadMinutes ?? 0), createdAt: previous?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(), canceledAt: previous?.canceledAt || null,
    completedAt: previous?.completedAt || null, dailyDone: previous?.dailyDone || '',
    notifiedKey: previous?.notifiedKey || '',
  };
  if (!['off', 'relative', 'absolute'].includes(task.reminderMode)) throw new Error('提醒方式无效');
  if (!Number.isFinite(task.leadMinutes) || task.leadMinutes < 0 || task.leadMinutes > 525600) throw new Error('提前量需为0至525600分钟');
  for (const value of [task.startDate, task.endDate]) if (value && !validDate(value)) throw new Error('日期无效');
  if (task.startDate && task.endDate && task.endDate < task.startDate) throw new Error('结束日期不能早于开始日期');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(task.dailyTime)) throw new Error('每日时间无效');
  if (task.category === 'daily' && task.reminderMode === 'absolute') throw new Error('每日事项使用每日时间提醒');
  if (task.category !== 'daily' && task.reminderMode === 'relative' && !(task.category === 'waiting' ? task.followUpAt || task.dueAt : task.dueAt)) throw new Error('提前提醒需要先设置截止或跟进时间');
  if (task.reminderMode === 'absolute' && !task.reminderAt) throw new Error('请选择提醒时间');
  return task;
}
function reminderState(task, now = new Date()) {
  if (task.status !== 'active' || task.reminderMode === 'off') return { active: false, key: '', at: null };
  let at;
  let key;
  if (task.category === 'daily') {
    let day = dateKey(now);
    if (task.startDate && day < task.startDate) return { active: false, key: '', at: null };
    if (task.endDate && day > task.endDate) day = task.endDate;
    if (task.dailyDone >= day) return { active: false, key: '', at: null };
    at = new Date(`${day}T${task.dailyTime}:00`).getTime();
    key = `daily:${day}:${task.dailyTime}`;
  } else {
    const anchor = task.reminderMode === 'absolute' ? task.reminderAt : (task.category === 'waiting' ? task.followUpAt || task.dueAt : task.dueAt);
    if (!anchor) return { active: false, key: '', at: null };
    at = Date.parse(anchor);
    if (task.reminderMode === 'relative') at -= task.leadMinutes * 60000;
    key = `once:${at}`;
  }
  return { active: Number.isFinite(at) && now.getTime() >= at, key, at };
}
function cancelExpiry(canceledAt) {
  const date = new Date(canceledAt);
  const month = date.getMonth();
  date.setFullYear(date.getFullYear() + 1);
  if (date.getMonth() !== month) date.setDate(0);
  return date;
}
function purgeCanceled(tasks, now = new Date()) {
  return tasks.filter(task => !(task.status === 'canceled' && task.canceledAt && now > cancelExpiry(task.canceledAt)));
}
function sortedTasks(tasks) {
  return [...tasks].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.priority - b.priority || a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}
function completeTask(task, now = new Date()) {
  if (task.category === 'daily') {
    const today = dateKey(now);
    task.dailyDone = task.endDate && today > task.endDate ? task.endDate : today;
    if (task.endDate && today >= task.endDate) task.status = 'completed';
  } else task.status = 'completed';
  if (task.status === 'completed') task.completedAt = now.toISOString();
  task.updatedAt = now.toISOString();
  return task;
}
module.exports = { CATEGORIES, STATUSES, dateKey, validDate, validateTask, reminderState, cancelExpiry, purgeCanceled, sortedTasks, completeTask };
