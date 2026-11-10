const $ = selector => document.querySelector(selector);
const form = $('#task-form');
const field = name => form.elements.namedItem(name);
const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state;
let editingId = null;
let saving = false;
const collapsed = new Set();
function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function localValue(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return `${dateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function displayDate(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : ''; }
function reminder(task) {
  if (task.status !== 'active' || task.reminderMode === 'off') return false;
  const now = new Date(state.now);
  if (task.category === 'daily') {
    let day = dateKey(now);
    if (task.startDate && day < task.startDate) return false;
    if (task.endDate && day > task.endDate) day = task.endDate;
    return task.dailyDone < day && now >= new Date(`${day}T${task.dailyTime}:00`);
  }
  const anchor = task.reminderMode === 'absolute' ? task.reminderAt : task.category === 'waiting' ? task.followUpAt || task.dueAt : task.dueAt;
  return !!anchor && now.getTime() >= Date.parse(anchor) - (task.reminderMode === 'relative' ? task.leadMinutes * 60000 : 0);
}
function error(message) { $('#error').textContent = message; $('#error').hidden = !message; }
async function command(value) {
  try {
    const result = await window.deskcue.command(value);
    if (!result.ok) throw new Error(result.error);
    if (result.state) { state = result.state; render(); }
    error(''); return true;
  } catch (failure) { error(failure.message); return false; }
}
function taskMarkup(task, peers) {
  const now = new Date(state.now);
  const today = dateKey(now);
  const dailyDone = task.category === 'daily' && task.dailyDone >= (task.endDate && today > task.endDate ? task.endDate : today);
  const notStarted = task.category === 'daily' && task.startDate && today < task.startDate;
  const meta = [];
  if (task.description) meta.push(task.description);
  if (task.category === 'daily') meta.push(`每天 ${task.dailyTime}${task.startDate ? ` · ${task.startDate} 起` : ''}${task.endDate ? ` · 至 ${task.endDate}` : ''}${dailyDone ? ' · 今日已关注' : ''}${notStarted ? ' · 尚未开始' : ''}`);
  if (task.waitingFor) meta.push(`等待：${task.waitingFor}`);
  if (task.followUpAt && task.category === 'waiting') meta.push(`跟进 ${displayDate(task.followUpAt)}`);
  if (task.dueAt && task.category !== 'daily') meta.push(`截止 ${displayDate(task.dueAt)}`);
  if (task.reminderMode === 'absolute') meta.push(`提醒 ${displayDate(task.reminderAt)}`);
  if (task.reminderMode === 'relative' && task.category !== 'daily') meta.push(task.leadMinutes ? `提前 ${task.leadMinutes} 分钟提醒` : '准时提醒');
  if (task.status === 'canceled') meta.push(`取消于 ${displayDate(task.canceledAt)} · 保留一年`);
  const overdue = task.status === 'active' && task.dueAt && now > new Date(task.dueAt);
  if (overdue) meta.push('已逾期');
  const isActive = task.status === 'active';
  const index = peers.indexOf(task);
  const samePrevious = index > 0 && peers[index - 1].priority === task.priority;
  const sameNext = index + 1 < peers.length && peers[index + 1].priority === task.priority;
  return `<li class="task ${reminder(task) ? 'reminding' : ''} ${dailyDone ? 'done' : ''}" data-id="${escapeText(task.id)}"><div class="task-top"><button class="complete" data-action="complete" ${!isActive || dailyDone || notStarted ? 'disabled' : ''} title="${task.category === 'daily' ? '今日已关注' : task.category === 'waiting' ? '结果已收到，整件事已闭环' : '完成事项'}" aria-label="${task.category === 'daily' ? '今日已关注' : '标记完成'}">${dailyDone || !isActive ? '✓' : '○'}</button><div><div class="task-title">${reminder(task) ? '<span class="reminder-label">● 待闭环</span>' : ''}<button data-action="edit" ${!isActive ? 'disabled' : ''}>${escapeText(task.title)}</button></div><div class="meta ${overdue ? 'overdue' : ''}">${meta.map(escapeText).join('<br>')}</div></div><select class="priority p${task.priority}" data-action="priority" aria-label="优先级" ${!isActive ? 'disabled' : ''}>${['高', '中', '低'].map((label, priority) => `<option value="${priority}" ${task.priority === priority ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="task-actions">${isActive ? `<button data-action="up" ${!samePrevious ? 'disabled' : ''} title="同优先级内上移">↑</button><button data-action="down" ${!sameNext ? 'disabled' : ''} title="同优先级内下移">↓</button>${task.category === 'waiting' ? '<button data-action="transfer">转为本人推进</button>' : ''}${task.category === 'daily' ? '<button data-action="finish">结束整项</button>' : ''}<button data-action="edit">编辑</button><button data-action="cancel">取消事项</button>` : '<button data-action="restore">恢复事项</button>'}</div></li>`;
}
function render() {
  if (!state) return;
  const active = state.tasks.filter(task => task.status === 'active');
  const total = active.filter(reminder).length;
  document.body.classList.toggle('compact', state.settings.compact);
  $('#compact').setAttribute('aria-label', state.settings.compact ? '展开面板' : '收起面板');
  $('#summary').textContent = `每日 ${active.filter(t => t.category === 'daily').length}　·　本人 ${active.filter(t => t.category === 'action').length}　·　外部 ${active.filter(t => t.category === 'waiting').length}${total ? `　｜ ${total} 项待闭环` : ''}`;
  $('#summary').classList.toggle('summary-alert', total > 0);
  $('#mode').value = state.settings.mode;
  const view = $('#view').value;
  $('#groups').innerHTML = [['daily', '每日关注', '☀'], ['action', '本人推进', '↗'], ['waiting', '等待外部', '◷']].map(([category, title, icon]) => {
    const tasks = state.tasks.filter(task => task.category === category && task.status === view);
    return `<section class="group"><button class="group-head" data-group="${category}" aria-expanded="${!collapsed.has(category)}"><span class="symbol">${icon}</span>${title}<span class="count">${tasks.length}</span>${tasks.length ? `<span class="empty">${collapsed.has(category) ? '展开' : '收起'}</span>` : '<span class="empty">暂无事项</span>'}</button><ul class="tasks" ${collapsed.has(category) ? 'hidden' : ''}>${tasks.map(task => taskMarkup(task, tasks)).join('')}</ul></section>`;
  }).join('');
  if (state.backupWarning) error(`事项已保存，但备份未完成：${state.backupWarning}`);
}
function updateFields() {
  const daily = field('category').value === 'daily';
  $('#daily-fields').hidden = !daily;
  $('#waiting-fields').hidden = field('category').value !== 'waiting';
  $('#deadline-field').hidden = daily;
  const mode = field('reminderMode');
  mode.options[2].disabled = daily;
  mode.options[1].textContent = daily ? '每天按指定时间提醒' : '按截止／跟进时间提前提醒';
  if (daily && mode.value === 'absolute') mode.value = 'relative';
  $('#lead-field').hidden = daily || mode.value !== 'relative';
  $('#absolute-field').hidden = mode.value !== 'absolute';
}
function edit(task = null) {
  editingId = task?.id || null; form.reset(); $('#form-error').hidden = true;
  $('#editor-title').textContent = task ? '编辑事项' : '新增事项';
  for (const name of ['title', 'category', 'priority', 'description', 'waitingFor', 'startDate', 'endDate', 'dailyTime', 'reminderMode', 'leadMinutes']) if (task && task[name] !== undefined) field(name).value = task[name];
  if (!task) { field('category').value = 'daily'; field('reminderMode').value = 'relative'; field('startDate').value = dateKey(new Date()); }
  for (const name of ['followUpAt', 'reminderAt']) field(name).value = localValue(task?.[name]);
  const due = localValue(task?.dueAt); field('dueDate').value = due.slice(0, 10); field('dueTime').value = due ? due.slice(11) : '18:00';
  updateFields(); $('#editor').showModal(); field('title').focus();
}
$('#task-form').addEventListener('submit', async event => {
  event.preventDefault(); if (saving) return;
  const values = Object.fromEntries(new FormData(form)); values.priority = Number(values.priority); values.leadMinutes = Number(values.leadMinutes);
  const iso = value => value ? new Date(value).toISOString() : null;
  try {
    values.dueAt = values.category !== 'daily' && values.dueDate ? iso(`${values.dueDate}T${values.dueTime || '18:00'}`) : null;
    values.followUpAt = values.category === 'waiting' ? iso(values.followUpAt) : null;
    values.reminderAt = values.reminderMode === 'absolute' ? iso(values.reminderAt) : null;
    if (values.category !== 'daily') { values.startDate = ''; values.endDate = ''; }
    saving = true;
    const result = await window.deskcue.command({ type: 'save', id: editingId, task: values });
    if (!result.ok) throw new Error(result.error);
    state = result.state; render(); $('#editor').close(); error('');
  } catch (failure) { $('#form-error').textContent = failure.message; $('#form-error').hidden = false; }
  finally { saving = false; }
});
$('#groups').addEventListener('click', async event => {
  const head = event.target.closest('[data-group]');
  if (head) { const key = head.dataset.group; collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key); render(); return; }
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const id = button.closest('[data-id]').dataset.id;
  const task = state.tasks.find(item => item.id === id); const type = button.dataset.action;
  if (type === 'edit') return edit(task);
  if (type === 'cancel' && !confirm('取消这个事项？取消后停止提醒，保留一年，期间可以恢复。')) return;
  if (type === 'finish' && !confirm('结束整个每日事项？之后将不再提醒。')) return;
  button.disabled = true;
  await command({ type: ['up', 'down'].includes(type) ? 'move' : type, id, direction: type });
});
$('#groups').addEventListener('change', event => { if (event.target.matches('select[data-action=priority]')) command({ type: 'priority', id: event.target.closest('[data-id]').dataset.id, priority: Number(event.target.value) }); });
$('#add').addEventListener('click', () => edit()); $('#view').addEventListener('change', render);
$('#mode').addEventListener('change', async event => { const mode = event.target.value; event.target.disabled = true; await command({ type: 'settings', mode }); event.target.disabled = false; render(); });
$('#compact').addEventListener('click', () => command({ type: 'settings', compact: !state.settings.compact }));
$('#summary').addEventListener('click', () => command({ type: 'settings', compact: !state.settings.compact }));
$('#hide').addEventListener('click', () => command({ type: 'hide' })); $('#data').addEventListener('click', () => command({ type: 'open-data' }));
for (const id of ['dismiss', 'cancel-edit']) $(`#${id}`).addEventListener('click', () => $('#editor').close());
field('category').addEventListener('change', updateFields); field('reminderMode').addEventListener('change', updateFields);
window.deskcue.onState(value => { state = value; render(); }); window.deskcue.onError(error);
window.deskcue.onNew(() => { if (!$('#editor').open) edit(); });
window.deskcue.read().then(value => { state = value; render(); }).catch(failure => error(failure.message));
