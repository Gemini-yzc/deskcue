const { randomUUID } = require('node:crypto');
const { dateKey, validDate, moveDay, weekday, wallValue, wallTime, wallInstant, taskInstant } = require('./time-zone');

const CATEGORIES = ['daily', 'action', 'waiting'];
const STATUSES = ['active', 'completed', 'canceled'];
function instant(value, label) {
  if (!value) return null;
  if (wallValue(value)) return value;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label}不是有效时间`);
  return new Date(value).toISOString();
}
function isWeekly(task) {
  return task?.category === 'daily' && task.frequency === 'weekly';
}
function selectedWeekdays(task) {
  return task.weekdays ?? [task.weekday];
}
function validateWeekdays(task) {
  const selection = task.weekdays === undefined ? [task.weekday] : task.weekdays;
  if (!Array.isArray(selection) || !selection.length || selection.length > 7) throw new Error('请选择至少一个有效的每周提醒日');
  const days = [...selection];
  if (days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(days).size !== days.length) {
    throw new Error('每周提醒日无效或重复');
  }
  return days.sort((a, b) => (a || 7) - (b || 7));
}
function weeklyToday(task, now, zone) {
  if (!isWeekly(task) || task.status !== 'active') return false;
  const day = dateKey(now, zone);
  return selectedWeekdays(task).includes(weekday(day)) &&
    (!task.startDate || day >= task.startDate) && (!task.endDate || day <= task.endDate) &&
    (!task.weeklySince || day >= task.weeklySince);
}
function validateTask(input, previous = null, now = new Date(), zone) {
  if (!input || typeof input !== 'object') throw new Error('事项格式无效');
  const title = String(input.title || '').trim();
  if (!title || title.length > 200) throw new Error('事项标题需为1至200个字符');
  if (!CATEGORIES.includes(input.category)) throw new Error('请选择有效分类');
  if (![0, 1, 2].includes(input.priority)) throw new Error('优先级无效');
  const text = (value, max) => String(value || '').trim().slice(0, max);
  const task = {
    id: previous?.id || randomUUID(), title, category: input.category, priority: input.priority,
    order: previous?.order ?? now.getTime(), status: previous?.status || 'active',
    manualOrder: previous?.manualOrder ?? null,
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
  if (task.category === 'daily') {
    task.frequency = input.frequency ?? 'daily';
    if (!['daily', 'weekly'].includes(task.frequency)) throw new Error('重复频率无效');
    if (isWeekly(task)) {
      const days = validateWeekdays(input);
      task.weekday = days[0];
      if (days.length > 1) task.weekdays = days;
      const previousDays = isWeekly(previous) ? selectedWeekdays(previous) : [];
      const sameSchedule = days.length === previousDays.length && days.every(day => previousDays.includes(day)) &&
        ['dailyTime', 'startDate', 'endDate', 'reminderMode'].every(key => previous[key] === task[key]);
      task.weeklySince = sameSchedule ? previous.weeklySince : dateKey(now, zone);
    }
    if (isWeekly(previous) !== isWeekly(task)) {
      task.dailyDone = '';
      task.notifiedKey = '';
    }
  }
  if (isWeekly(task) || previous?.weeklyDone) task.weeklyDone = previous?.weeklyDone || '';
  if (previous?.weeklyMisses) task.weeklyMisses = previous.weeklyMisses;
  if (previous?.completionDates && isWeekly(previous) === isWeekly(task)) task.completionDates = previous.completionDates;
  if (previous?.recentNotifiedKeys && isWeekly(previous) === isWeekly(task)) task.recentNotifiedKeys = previous.recentNotifiedKeys;
  return task;
}
function occurrenceDone(task, day) {
  return (isWeekly(task) ? task.weeklyDone : task.dailyDone) === day || !!task.completionDates?.includes(day);
}
function nextWeeklyDay(day, days) {
  const first = weekday(day);
  return moveDay(day, Math.min(...days.map(target => (target - first + 7) % 7)));
}
function collectWeeklyMisses(task, now, zone) {
  if (!isWeekly(task) || task.status !== 'active' || task.reminderMode === 'off') return task;
  const today = dateKey(now, zone);
  const first = task.startDate > task.weeklySince ? task.startDate : task.weeklySince;
  if (first >= today || (task.endDate && first > task.endDate)) return task;
  const days = selectedWeekdays(task);
  let day = nextWeeklyDay(first, days);
  if (day >= today || (task.endDate && day > task.endDate)) return task;

  const misses = [...(task.weeklyMisses || [])];
  const seen = new Set(misses.map(miss => miss.date));
  while (day < today && (!task.endDate || day <= task.endDate)) {
    if (!occurrenceDone(task, day) && !seen.has(day) && dateKey(wallInstant(`${day}T00:00`, zone), zone) === day) {
      misses.push({ date: day, notified: false, acknowledged: false });
    }
    day = nextWeeklyDay(moveDay(day, 1), days);
  }
  return { ...task, weeklySince: day, weeklyMisses: misses };
}
function canAnnounceWeeklyMisses(task, now, zone) {
  return !(task.weekdays?.length > 1) || task.weekdays.includes(weekday(dateKey(now, zone)));
}
function acknowledgeWeeklyMisses(task, dates) {
  if (!Array.isArray(dates) || !dates.length || !dates.every(validDate)) throw new Error('请选择要确认的错过日期');
  const shown = new Set(dates);
  task.weeklyMisses = (task.weeklyMisses || []).map(miss =>
    shown.has(miss.date) ? { ...miss, acknowledged: true } : miss);
}
function occurrenceDay(task, now, zone) {
  const today = dateKey(now, zone);
  return !isWeekly(task) && task.endDate && today > task.endDate ? task.endDate : today;
}
function reminderState(task, now = new Date(), zone) {
  if (task.status !== 'active' || task.reminderMode === 'off') return { active: false, key: '', at: null };
  let at;
  let key;
  if (task.category === 'daily') {
    const day = occurrenceDay(task, now, zone);
    if ((task.startDate && day < task.startDate) || (isWeekly(task) && !weeklyToday(task, now, zone)) ||
        occurrenceDone(task, day)) return { active: false, key: '', at: null };
    at = wallInstant(`${day}T${task.dailyTime}`, zone);
    if (dateKey(at, zone) !== day) return { active: false, key: '', at: null };
    key = `${isWeekly(task) ? 'weekly' : 'daily'}:${day}:${task.dailyTime}`;
  } else {
    const anchor = task.reminderMode === 'absolute' ? task.reminderAt : (task.category === 'waiting' ? task.followUpAt || task.dueAt : task.dueAt);
    if (!anchor) return { active: false, key: '', at: null };
    const lead = task.reminderMode === 'relative' ? task.leadMinutes : 0;
    at = taskInstant(anchor, zone) - lead * 60000;
    key = wallValue(anchor) ? `once:${Date.parse(`${anchor}Z`)}:${lead}` : `once:${at}`;
  }
  return { active: Number.isFinite(at) && now.getTime() >= at, key, at };
}
function cancelExpiry(canceledAt, zone) {
  const date = new Date(`${wallTime(canceledAt, zone)}Z`);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return new Date(wallInstant(date.toISOString().slice(0, -1), zone));
}
function purgeCanceled(tasks, now = new Date(), zone) {
  return tasks.filter(task => !(task.status === 'canceled' && task.canceledAt &&
    now > cancelExpiry(task.canceledAt, zone) && !task.weeklyMisses?.some(miss => !miss.acknowledged)));
}
function deadline(task, zone) {
  if (task.category === 'daily') return task.endDate ? wallInstant(`${task.endDate}T23:59:59`, zone) : Infinity;
  return task.dueAt ? taskInstant(task.dueAt, zone) : Infinity;
}
function sortedTasks(tasks, zone) {
  const deadlines = new Map(tasks.map(task => [task, deadline(task, zone)]));
  return [...tasks].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.priority - b.priority ||
    (Number.isFinite(a.manualOrder) || Number.isFinite(b.manualOrder) ? (a.manualOrder ?? Number.MAX_SAFE_INTEGER) - (b.manualOrder ?? Number.MAX_SAFE_INTEGER) : 0) ||
    (deadlines.get(a) === deadlines.get(b) ? 0 : deadlines.get(a) - deadlines.get(b)) || a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}
function reorderTasks(tasks, id, targetId, zone) {
  const task = tasks.find(item => item.id === id);
  const target = tasks.find(item => item.id === targetId);
  if (!task || !target || task.status !== 'active' || target.status !== 'active' || task.category !== target.category || task.priority !== target.priority) throw new Error('只能拖动同分类、同优先级的当前事项');
  const peers = sortedTasks(tasks.filter(item => item.status === 'active' && item.category === task.category && item.priority === task.priority), zone);
  const from = peers.indexOf(task), to = peers.indexOf(target);
  peers.splice(from, 1); peers.splice(to, 0, task);
  peers.forEach((item, index) => { item.manualOrder = index; });
  return tasks;
}
function completeTask(task, now = new Date(), zone) {
  const previous = isWeekly(task) ? task.weeklyDone : task.dailyDone;
  if (isWeekly(task)) {
    if (!weeklyToday(task, now, zone)) throw new Error('只能在安排当天完成每周事项');
    task.weeklyDone = dateKey(now, zone);
  } else if (task.category === 'daily') {
    const today = dateKey(now, zone);
    task.dailyDone = task.endDate && today > task.endDate ? task.endDate : today;
    if (task.endDate && today >= task.endDate) task.status = 'completed';
  } else task.status = 'completed';
  if (task.category === 'daily' && previous) {
    task.completionDates = [...new Set([...(task.completionDates || []), previous])].slice(-3);
  }
  if (task.status === 'completed') task.completedAt = now.toISOString();
  task.updatedAt = now.toISOString();
  return task;
}
module.exports = {
  CATEGORIES, STATUSES, dateKey, validDate, validateTask, isWeekly, weeklyToday,
  collectWeeklyMisses, canAnnounceWeeklyMisses, acknowledgeWeeklyMisses, reminderState, cancelExpiry, purgeCanceled,
  sortedTasks, completeTask, reorderTasks, occurrenceDay, occurrenceDone,
};
