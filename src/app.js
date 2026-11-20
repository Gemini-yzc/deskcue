const $ = selector => document.querySelector(selector);
const form = $('#task-form');
const field = name => form.elements.namedItem(name);
const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state;
let editingId = null;
let saving = false;
const collapsed = new Set();
let draggingId = null;
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const zoneLabels = new Map();
let timeZones;
let clockFormatter;
function zoneLabel(zone) {
  if (zone === 'system') return '跟随电脑';
  if (zone === 'America/Los_Angeles') return '太平洋时间';
  if (!zoneLabels.has(zone)) {
    const label = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value;
    zoneLabels.set(zone, label || zone);
  }
  return zoneLabels.get(zone);
}
function displayDate(value) {
  return value ? `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))} ${value.slice(11, 16)}` : '';
}
function renderClock(now = new Date()) {
  if (!state) return;
  const zone = state.settings.effectiveTimeZone;
  if (clockFormatter?.resolvedOptions().timeZone !== zone) {
    clockFormatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  }
  const parts = Object.fromEntries(clockFormatter.formatToParts(now).map(part => [part.type, part.value]));
  const time = $('#zone-clock-time');
  time.dateTime = now.toISOString();
  time.textContent = `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
  $('#zone-clock-label').textContent = zoneLabel(zone);
}
function tickClock() {
  renderClock();
  setTimeout(tickClock, 60000 - Date.now() % 60000);
}
function filterTimeZones(preferred) {
  const options = $('#time-zone-options');
  const query = $('#time-zone-search').value.trim().toLowerCase();
  let alias;
  if (query.includes('/')) {
    try { alias = new Intl.DateTimeFormat('en', { timeZone: query }).resolvedOptions().timeZone; } catch {}
  }
  const zones = [...new Set(['system', 'America/Los_Angeles', 'UTC', state.settings.timeZone, ...timeZones, ...(alias ? [alias] : [])])];
  const matches = zones.filter(zone => zone === alias || `${zoneLabel(zone)} ${zone.replaceAll('_', ' ')} ${zone}`.toLowerCase().includes(query));
  options.replaceChildren(...matches.map(zone => new Option(zone === 'system' ? zoneLabel(zone) : `${zoneLabel(zone)} · ${zone}`, zone)));
  options.value = matches.includes(preferred) ? preferred : matches[0] || '';
  $('#time-zone-save').disabled = !matches.length;
}
function pendingMisses(task) { return (task.weeklyMisses || []).filter(miss => !miss.acknowledged); }
function missMarkup(task, datesOpen) {
  const dates = pendingMisses(task).map(miss => miss.date);
  if (!dates.length) return '';
  const title = dates.length > 1 ? `${dates.length} 次未完成` :
    dates[0] === state.yesterday ? '昨天未完成' : `${dates[0]} 未完成`;
  return `<li class="miss-notice" data-id="${escapeText(task.id)}">
    <details ${datesOpen.has(task.id) ? 'open' : ''}><summary>${title} · ${escapeText(task.title)}</summary>
      <div class="miss-dates">${dates.join('、')}</div>
    </details>
    <button type="button" data-action="acknowledge-misses" data-dates="${dates.join(',')}">我知道了</button>
  </li>`;
}
function error(message) {
  $('#error').textContent = message; $('#error').hidden = !message;
  const appearanceError = $('#appearance-error');
  if (appearanceError) { appearanceError.textContent = message; appearanceError.hidden = !message; }
}
async function command(value) {
  try {
    const result = await window.deskcue.command(value);
    if (!result.ok) throw new Error(result.error);
    if (result.state) { state = result.state; render(); }
    error(''); return true;
  } catch (failure) { error(failure.message); return false; }
}
function taskMarkup(task) {
  const weekly = task.category === 'daily' && task.frequency === 'weekly';
  const dailyDone = task.occurrenceDone && (!weekly || task.weeklyToday);
  const unavailable = weekly ? !task.weeklyToday : task.category === 'daily' && task.startDate && state.today < task.startDate;
  const active = task.status === 'active';
  const overdue = task.overdue;
  const label = weekly ? (unavailable ? '仅可在安排当天确认本次' : '完成本次') :
    task.category === 'daily' ? '今日已做，停止当天提醒，明天恢复' : '完成事项，停止提醒';
  const schedule = (weekly ? '每' + weekdays[task.weekday] : '每天') + ' ' + task.dailyTime;
  let date = '无截止';
  if (task.category === 'daily') date = !weekly && task.endDate ? task.endDate.slice(5).replace('-', '/') + ' 止' : schedule;
  else if (task.dueAt) date = displayDate(task.dueAt);
  else if (task.category === 'waiting' && task.followUpAt) date = displayDate(task.followUpAt);
  if (dailyDone) date = '今日已完成';
  if (task.status === 'completed') date = '已完成';
  if (task.status === 'canceled') date = '已取消';
  const details = [task.title, task.description, task.waitingFor ? '等待：' + task.waitingFor : '', task.category === 'daily' ? schedule + (task.endDate ? '，至 ' + task.endDate : '') : '', task.dueAt ? '截止 ' + task.dueAt.slice(0, 16) : '', task.followUpAt ? '跟进 ' + task.followUpAt.slice(0, 16) : '', task.reminderAt ? '提醒 ' + task.reminderAt.slice(0, 16) : '', zoneLabel(state.settings.effectiveTimeZone)].filter(Boolean).join('\n');
  const actions = active ? '<button data-action="edit">编辑事项</button>' + (task.category === 'waiting' ? '<button data-action="transfer">转为本人推进</button>' : '') + (task.category === 'daily' ? '<button data-action="finish">结束整项</button>' : '') + '<button data-action="cancel">取消事项</button>' : '<button data-action="restore">恢复事项</button>';
  return '<li class="task ' + (task.reminding ? 'reminding ' : '') + (dailyDone ? 'done' : '') + '" data-id="' + escapeText(task.id) + '">' +
    '<button class="task-grip" draggable="' + active + '" aria-label="拖动同类同优先级事项排序，或按Alt加上下方向键" title="拖拽调整同优先级顺序">⠿</button>' +
    '<button class="complete" data-action="complete" ' + (!active || dailyDone || unavailable ? 'disabled' : '') + ' title="' + label + '" aria-label="' + label + '">' + (dailyDone || !active ? '✓' : '○') + '</button>' +
    '<select class="priority p' + task.priority + '" data-action="priority" aria-label="优先级" ' + (!active ? 'disabled' : '') + '>' + ['高','中','低'].map((name,p)=>'<option value="' + p + '" ' + (task.priority === p ? 'selected' : '') + '>' + name + '</option>').join('') + '</select>' +
    '<button class="task-title task-main" data-action="edit" title="' + escapeText(details) + '" ' + (!active ? 'disabled' : '') + '>' + escapeText(task.title) + '</button>' +
    '<span class="time-cell task-side ' + (overdue ? 'overdue' : '') + '" title="' + escapeText(details) + '">' + escapeText(date) + '</span>' +
    '<details class="task-menu"><summary aria-label="更多操作" title="更多操作">⋯</summary><div class="task-actions">' + actions + '</div></details></li>';
}

function render() {
  if (!state) return;
  applyAppearance();
  renderClock();
  const active = state.tasks.filter(task => task.status === 'active');
  const total = state.tasks.filter(task => task.reminding || pendingMisses(task).length).length;
  document.body.classList.toggle('compact', state.settings.compact);
  $('#compact').setAttribute('aria-label', state.settings.compact ? '展开面板' : '收起面板');
  $('#summary').textContent = `定期 ${active.filter(t => t.category === 'daily').length}　·　本人 ${active.filter(t => t.category === 'action').length}　·　外部 ${active.filter(t => t.category === 'waiting').length}${total ? `　｜ ${total} 项待确认` : ''}`;
  $('#summary').classList.toggle('summary-alert', total > 0);
  $('#mode').value = state.settings.mode;
  const zone = zoneLabel(state.settings.effectiveTimeZone);
  $('#time-zone').title = `事项时区 · ${zone}`;
  $('#current-time-zone').textContent = `当前时区 · ${zone} · ${state.settings.effectiveTimeZone}`;
  $('#editor-time-zone').textContent = `事项时区 · ${zone}`;
  const view = $('#view').value;
  const datesOpen = new Set([...$('#groups').querySelectorAll('.miss-notice details[open]')].map(details => details.closest('[data-id]').dataset.id));
  const archivedMisses = view === 'active' ? state.tasks.filter(task => task.status !== 'active').map(task => missMarkup(task, datesOpen)).join('') : '';
  const groups = [['daily', '定期关注', '☀'], ['action', '本人推进', '↗'], ['waiting', '等待外部', '◷']].map(([category, title, icon]) => {
    const tasks = state.tasks.filter(task => task.category === category && task.status === view);
    return `<section class="group"><button class="group-head" data-group="${category}" aria-expanded="${!collapsed.has(category)}"><span class="symbol">${icon}</span>${title}<span class="count">${tasks.length}</span>${category === 'daily' ? '<span class="daily-help">点 ○：完成本次</span>' : tasks.length ? `<span class="empty">${collapsed.has(category) ? '展开' : '收起'}</span>` : '<span class="empty">暂无事项</span>'}</button><ul class="tasks" ${collapsed.has(category) ? 'hidden' : ''}>${tasks.map(task => taskMarkup(task) + missMarkup(task, datesOpen)).join('')}</ul></section>`;
  }).join('');
  $('#groups').innerHTML = (archivedMisses ? `<ul class="tasks">${archivedMisses}</ul>` : '') + groups;
  $('#auto-sort').disabled = !state.tasks.some(task => Number.isFinite(task.manualOrder));
  renderAppearance();
  if (state.backupWarning) error(`事项已保存，但备份未完成：${state.backupWarning}`);
}
function applyAppearance() {
  const palette = window.DeskCueThemes[state.settings.theme] || window.DeskCueThemes.sage;
  const tokens = ['bg', 'text', 'muted', 'line', 'soft', 'accent', 'urgent', 'surface'];
  tokens.forEach((token, index) => document.documentElement.style.setProperty(`--${token}`, `light-dark(${palette.light[index]}, ${palette.dark[index]})`));
  const id = state.backgroundImage ? state.settings.backgroundId : '';
  if ($('#wallpaper').dataset.image !== (id || '')) {
    $('#wallpaper').style.backgroundImage = state.backgroundImage ? `url("${state.backgroundImage}")` : 'none';
    $('#wallpaper').dataset.image = id || '';
  }
}
function renderAppearance() {
  $('#theme-grid').innerHTML = Object.entries(window.DeskCueThemes).map(([id, theme]) => `<button data-theme="${id}" class="theme-button ${id === (state.settings.theme || 'sage') ? 'selected' : ''}"><span class="theme-dot"></span>${theme.name}</button>`).join('');
  for (const button of $('#theme-grid').querySelectorAll('[data-theme]')) button.style.setProperty('--swatch', window.DeskCueThemes[button.dataset.theme].light[5]);
  $('#image-count').textContent = `自定义图片 ${(state.images || []).length}/3`;
  $('#image-gallery').innerHTML = (state.images || []).map(image => `<button data-image="${image.id}" class="image-choice ${image.id === state.settings.backgroundId ? 'selected' : ''}" ${image.missing ? 'disabled' : ''} title="${escapeText(image.name)}">${image.thumbnail ? `<img src="${image.thumbnail}" alt="${escapeText(image.name)}">` : '<span>图片已移除</span>'}</button>`).join('');
}
function updateFields() {
  const daily = field('category').value === 'daily';
  const weekly = daily && field('frequency').value === 'weekly';
  $('#daily-fields').hidden = !daily;
  $('#weekday-field').hidden = !weekly;
  field('weekday').required = weekly;
  $('#waiting-fields').hidden = field('category').value !== 'waiting';
  $('#deadline-field').hidden = daily;
  const mode = field('reminderMode');
  mode.options[2].disabled = daily;
  mode.options[1].textContent = daily ? (weekly ? '每周按指定时间提醒' : '每天按指定时间提醒') : '按截止／跟进时间提前提醒';
  if (daily && mode.value === 'absolute') mode.value = 'relative';
  $('#lead-field').hidden = daily || mode.value !== 'relative';
  $('#absolute-field').hidden = mode.value !== 'absolute';
}
function edit(task = null) {
  editingId = task?.id || null; form.reset(); $('#form-error').hidden = true;
  $('#editor-title').textContent = task ? '编辑事项' : '新增事项';
  for (const name of ['title', 'category', 'priority', 'description', 'waitingFor', 'startDate', 'endDate', 'dailyTime', 'frequency', 'weekday', 'reminderMode', 'leadMinutes']) if (task && task[name] !== undefined) field(name).value = task[name];
  if (!task) { field('category').value = 'daily'; field('reminderMode').value = 'relative'; field('startDate').value = state.today; }
  for (const name of ['followUpAt', 'reminderAt']) field(name).value = task?.[name]?.slice(0, 16) || '';
  const due = task?.dueAt || ''; field('dueDate').value = due.slice(0, 10); field('dueTime').value = due ? due.slice(11, 16) : '18:00';
  updateFields(); $('#editor').showModal(); field('title').focus();
}
$('#task-form').addEventListener('submit', async event => {
  event.preventDefault(); if (saving) return;
  const values = Object.fromEntries(new FormData(form)); values.priority = Number(values.priority); values.leadMinutes = Number(values.leadMinutes);
  values.weekday = values.weekday === '' ? null : Number(values.weekday);
  try {
    values.dueAt = values.category !== 'daily' && values.dueDate ? `${values.dueDate}T${values.dueTime || '18:00'}` : null;
    values.followUpAt = values.category === 'waiting' ? values.followUpAt || null : null;
    values.reminderAt = values.reminderMode === 'absolute' ? values.reminderAt || null : null;
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
  if (type === 'cancel' && !confirm('取消这个事项？取消会停止后续提醒，事项保留至少一年。')) return;
  if (type === 'finish' && !confirm('结束整个定期事项？结束后停止后续提醒。')) return;
  button.disabled = true;
  const dates = button.dataset.dates?.split(',');
  if (!await command({ type, id, dates })) button.disabled = false;
});
$('#groups').addEventListener('change', event => { if (event.target.matches('select[data-action=priority]')) command({ type: 'priority', id: event.target.closest('[data-id]').dataset.id, priority: Number(event.target.value) }); });
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.task-menu[open]')) if (!menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#editor').open) for (const menu of document.querySelectorAll('.task-menu[open]')) menu.open = false;
});
$('#add').addEventListener('click', () => edit()); $('#view').addEventListener('change', render);
$('#mode').addEventListener('change', async event => { const mode = event.target.value; event.target.disabled = true; await command({ type: 'settings', mode }); event.target.disabled = false; render(); });
$('#compact').addEventListener('click', () => command({ type: 'settings', compact: !state.settings.compact }));
$('#summary').addEventListener('click', () => command({ type: 'settings', compact: !state.settings.compact }));
$('#hide').addEventListener('click', () => command({ type: 'hide' })); $('#data').addEventListener('click', () => command({ type: 'open-data' }));
$('#project').addEventListener('click', () => command({ type: 'open-project' }));
for (const id of ['dismiss', 'cancel-edit']) $(`#${id}`).addEventListener('click', () => $('#editor').close());
field('category').addEventListener('change', updateFields); field('reminderMode').addEventListener('change', updateFields);
field('frequency').addEventListener('change', updateFields);
$('#auto-sort').addEventListener('click', () => command({ type: 'auto-sort' }));
$('#appearance').addEventListener('click', () => { error(''); $('#appearance-dialog').showModal(); });
$('#appearance-close').addEventListener('click', () => $('#appearance-dialog').close());
$('#theme-grid').addEventListener('click', event => { const button = event.target.closest('[data-theme]'); if (button) command({ type: 'settings', theme: button.dataset.theme }); });
$('#image-gallery').addEventListener('click', event => { const button = event.target.closest('[data-image]'); if (button) command({ type: 'settings', backgroundId: button.dataset.image }); });
$('#plain-background').addEventListener('click', () => command({ type: 'settings', backgroundId: null }));
$('#time-zone').addEventListener('click', () => {
  timeZones ||= [
    ...Intl.supportedValuesOf('timeZone'),
    ...Array.from({ length: 14 }, (_, index) => `Etc/GMT-${index + 1}`),
    ...Array.from({ length: 12 }, (_, index) => `Etc/GMT+${index + 1}`),
  ];
  $('#time-zone-search').value = '';
  $('#time-zone-error').hidden = true;
  filterTimeZones(state.settings.timeZone);
  $('#time-zone-dialog').showModal();
  $('#time-zone-search').focus();
});
$('#time-zone-search').addEventListener('input', () => filterTimeZones($('#time-zone-options').value));
$('#time-zone-close').addEventListener('click', () => $('#time-zone-dialog').close());
$('#time-zone-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#time-zone-save');
  button.disabled = true;
  try {
    const result = await window.deskcue.command({ type: 'time-zone', timeZone: $('#time-zone-options').value });
    if (!result.ok) throw new Error(result.error);
    state = result.state;
    render();
    $('#time-zone-dialog').close();
  } catch (failure) {
    $('#time-zone-error').textContent = failure.message;
    $('#time-zone-error').hidden = false;
  } finally { button.disabled = !$('#time-zone-options').value; }
});
$('#import-background').addEventListener('click', async () => {
  $('#import-background').disabled = true;
  await command({ type: 'import-background' });
  $('#import-background').disabled = false;
});
$('#groups').addEventListener('dragstart', event => {
  const grip = event.target.closest('.task-grip'); if (!grip || grip.draggable !== true) return;
  draggingId = grip.closest('[data-id]').dataset.id; event.dataTransfer.setData('text/plain', draggingId); event.dataTransfer.effectAllowed = 'move';
});
$('#groups').addEventListener('dragover', event => { const row = event.target.closest('[data-id]'); if (!row || !draggingId) return; event.preventDefault(); document.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target')); row.classList.add('drop-target'); });
$('#groups').addEventListener('drop', async event => {
  const row = event.target.closest('[data-id]'); if (!row) return; event.preventDefault();
  const id = draggingId || event.dataTransfer.getData('text/plain'); draggingId = null;
  document.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target'));
  if (id && id !== row.dataset.id) await command({ type: 'reorder', id, targetId: row.dataset.id });
});
$('#groups').addEventListener('dragend', () => { draggingId = null; document.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target')); });
$('#groups').addEventListener('keydown', event => {
  const grip = event.target.closest('.task-grip'); if (!grip || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault(); const task = state.tasks.find(item => item.id === grip.closest('[data-id]').dataset.id);
  const peers = state.tasks.filter(item => item.status === 'active' && item.category === task.category && item.priority === task.priority);
  const index = peers.indexOf(task), target = peers[index + (event.key === 'ArrowUp' ? -1 : 1)];
  if (target) command({ type: 'reorder', id: task.id, targetId: target.id });
});
window.deskcue.onState(value => { state = value; render(); }); window.deskcue.onError(error);
window.deskcue.onNew(() => { if (!$('#editor').open) edit(); });
window.deskcue.read().then(value => { state = value; render(); }).catch(failure => error(failure.message));
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderClock(); });
tickClock();
