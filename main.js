const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell, screen, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { Storage, configureTimeZone } = require('./src/storage');
const {
  validateTask, reminderState, purgeCanceled, sortedTasks, completeTask, dateKey, reorderTasks,
  isWeekly, weeklyToday, collectWeeklyMisses, acknowledgeWeeklyMisses, occurrenceDay, occurrenceDone,
} = require('./src/domain');
const { FOLLOW_SYSTEM, systemTimeZone, validateTimeZone, moveDay, wallInstant, taskInstant, wallTime } = require('./src/time-zone');
const { Backgrounds } = require('./src/backgrounds');
const themes = require('./src/appearance');

app.setName('DeskCue');
app.setAppUserModelId('org.deskcue.desktop');
const dataArgument = process.argv.find(value => value.startsWith('--data-dir='));
const baseDirectory = app.isPackaged ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')) : __dirname;
const dataDirectory = dataArgument ? path.resolve(dataArgument.slice(11)) : path.join(baseDirectory, 'data');
let startupError;
try {
  fs.mkdirSync(path.join(dataDirectory, 'runtime'), { recursive: true });
  app.setPath('userData', path.join(dataDirectory, 'runtime'));
  app.setPath('sessionData', path.join(dataDirectory, 'runtime'));
  app.setPath('crashDumps', path.join(dataDirectory, 'runtime', 'crashes'));
  app.setAppLogsPath(path.join(dataDirectory, 'runtime', 'logs'));
} catch (error) { startupError = error; }
let window, tray, store, state, reminderTimer, blinkTimer, boundsTimer, normalIcon, alertIcon;
let quitting = false;
let pendingAlertCount = -1;
let modeQueue = Promise.resolve();
let commandQueue = Promise.resolve();
let maintenanceDay = '';
let backgrounds;
let selectedImageCache = null;
let systemZoneProbe;
const thumbnails = new Map();
const iconPath = path.join(__dirname, 'build', 'icon.ico');

function snapshot() {
  const now = new Date();
  const zone = state.settings.effectiveTimeZone;
  const today = dateKey(now, zone);
  const images = (state.settings.backgrounds || []).map(image => {
    try {
      const file = backgrounds.filePath(image.file);
      if (!fs.existsSync(file)) return { ...image, thumbnail: '', missing: true };
      if (!thumbnails.has(image.id)) thumbnails.set(image.id, nativeImage.createFromPath(file).resize({ width: 100, height: 60, quality: 'good' }).toDataURL());
      return { ...image, thumbnail: thumbnails.get(image.id) };
    } catch { return { ...image, thumbnail: '', missing: true }; }
  });
  let backgroundImage = '';
  const selected = images.find(image => image.id === state.settings.backgroundId && !image.missing);
  if (selected) {
    if (selectedImageCache?.id !== selected.id) {
      const type = selected.file.endsWith('.jpg') ? 'jpeg' : selected.file.split('.').pop();
      selectedImageCache = { id: selected.id, data: `data:image/${type};base64,${fs.readFileSync(backgrounds.filePath(selected.file)).toString('base64')}` };
    }
    backgroundImage = selectedImageCache.data;
  } else selectedImageCache = null;
  for (const id of thumbnails.keys()) if (!images.some(image => image.id === id)) thumbnails.delete(id);
  const tasks = sortedTasks(state.tasks, zone).map(task => ({
    ...task, reminding: reminderState(task, now, zone).active, weeklyToday: weeklyToday(task, now, zone),
    occurrenceDone: task.category === 'daily' && occurrenceDone(task, occurrenceDay(task, now, zone)),
    overdue: task.status === 'active' && !!task.dueAt && now.getTime() > taskInstant(task.dueAt, zone),
  }));
  return { ...state, tasks, images, backgroundImage, dataDirectory, today,
    yesterday: moveDay(today, -1), backupWarning: store.backupError || '' };
}
function broadcast() {
  if (window && !window.isDestroyed()) window.webContents.send('deskcue:state', snapshot());
}
function commit(next, now) { state = store.save(next, now); broadcast(); }
function report(error) {
  console.error(error);
  if (window && !window.isDestroyed()) window.webContents.send('deskcue:error', error.message);
}
function showWindow() {
  if (!window || window.isDestroyed()) return;
  checkReminders();
  if (window.isMinimized()) window.restore();
  window.show();
  if (state.settings.mode !== 'desktop') window.focus();
}
function setTrayAlert(count) {
  if (pendingAlertCount === count) return;
  pendingAlertCount = count;
  clearInterval(blinkTimer);
  tray.setToolTip(count ? `DeskCue · ${count} 项待确认` : 'DeskCue · 定期关注 / 本人推进 / 等待外部');
  tray.setImage(count ? alertIcon : normalIcon);
  if (count) {
    let alternate = true;
    blinkTimer = setInterval(() => { alternate = !alternate; tray.setImage(alternate ? alertIcon : normalIcon); }, 1400);
  }
}
function readSystemTimeZone() {
  if (!systemZoneProbe) {
    // A fresh runtime reads the Windows rule even if this process cached its old default.
    systemZoneProbe = new Promise((resolve, reject) => {
      execFile(process.execPath, ['-p', 'Intl.DateTimeFormat().resolvedOptions().timeZone'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 5000,
      }, (error, stdout) => {
        if (error) return reject(new Error('暂时无法读取电脑时区'));
        try { resolve(validateTimeZone(stdout.trim())); } catch (failure) { reject(failure); }
      });
    }).finally(() => { systemZoneProbe = null; });
  }
  return systemZoneProbe;
}
async function refreshReminders() {
  if (!state || quitting) return;
  if (state.settings.timeZone === FOLLOW_SYSTEM) {
    try {
      const zone = await readSystemTimeZone();
      if (quitting) return;
      if (state.settings.timeZone === FOLLOW_SYSTEM && zone !== state.settings.effectiveTimeZone) {
        const now = new Date();
        commit(configureTimeZone(state, FOLLOW_SYSTEM, now, zone), now);
      }
    } catch (error) { report(error); }
  }
  checkReminders();
}
function checkReminders() {
  clearTimeout(reminderTimer);
  if (!state || quitting) return;
  const now = new Date();
  const zone = state.settings.effectiveTimeZone;
  const today = dateKey(now, zone);
  const midnight = wallInstant(`${moveDay(today, 1)}T00:00`, zone);
  let nextAt = Math.min(now.getTime() + 60000, midnight);
  const due = [];
  const missed = [];
  const updated = state.tasks.map(previous => {
    const task = collectWeeklyMisses(previous, now, zone);
    const reminder = reminderState(task, now, zone);
    if (reminder.at > now.getTime()) nextAt = Math.min(nextAt, reminder.at);
    const remind = reminder.active && task.notifiedKey !== reminder.key && !task.recentNotifiedKeys?.includes(reminder.key);
    const misses = task.weeklyMisses?.filter(miss => !miss.acknowledged && !miss.notified) || [];
    if (!remind && !misses.length) return task;
    if (remind) due.push(task.title);
    if (misses.length) missed.push(`${task.title} · ${misses.length} 次未完成`);
    return {
      ...task,
      notifiedKey: remind ? reminder.key : task.notifiedKey,
      ...(remind && task.category === 'daily' && task.notifiedKey &&
        { recentNotifiedKeys: [...new Set([...(task.recentNotifiedKeys || []), task.notifiedKey])].slice(-3) }),
      ...(misses.length && { weeklyMisses: task.weeklyMisses.map(miss =>
        miss.acknowledged ? miss : { ...miss, notified: true }) }),
    };
  });
  const clean = purgeCanceled(updated, now, zone);
  let saved = true;
  if (clean.length !== state.tasks.length || updated.some((task, index) => task !== state.tasks[index]) || maintenanceDay !== today) {
    try { commit({ ...state, tasks: clean }, now); maintenanceDay = today; }
    catch (error) { saved = false; report(error); }
  }
  if (saved && (due.length || missed.length) && Notification.isSupported()) {
    const notification = new Notification({ title: missed.length ? 'DeskCue · 有每周事项未完成' : 'DeskCue · 事项提醒',
      body: [...missed, ...due].slice(0, 3).join('\n').slice(0, 500), silent: true, icon: iconPath });
    notification.on('click', showWindow);
    notification.on('failed', (_, error) => console.error('系统通知未送达：', error));
    notification.show();
  }
  const count = state.tasks.filter(task => reminderState(task, now, zone).active ||
    task.weeklyMisses?.some(miss => !miss.acknowledged)).length;
  setTrayAlert(count);
  broadcast();
  reminderTimer = setTimeout(refreshReminders, Math.max(1000, nextAt - Date.now()));
}
function applyMode(mode) {
  modeQueue = modeQueue.catch(() => {}).then(() => new Promise((resolve, reject) => {
    if (!window || window.isDestroyed()) return resolve();
    if (process.platform !== 'win32') return reject(new Error('本版本仅支持 Windows'));
    const buffer = window.getNativeWindowHandle();
    const hwnd = buffer.length >= 8 ? buffer.readBigUInt64LE().toString() : buffer.readUInt32LE().toString();
    const script = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'windows-window.ps1') : path.join(__dirname, 'windows-window.ps1');
    window.setAlwaysOnTop(false);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Hwnd', hwnd, '-Mode', mode],
      { windowsHide: true, timeout: 12000 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`切换显示模式失败：${stderr || error.message}`));
        if (!window.isDestroyed()) {
          window.setSkipTaskbar(mode === 'desktop');
          if (mode !== 'desktop') window.setAlwaysOnTop(mode === 'top', 'floating');
          else window.blur();
        }
        resolve();
      });
  }));
  return modeQueue;
}
function assertSender(event) {
  if (!window || event.sender !== window.webContents || !event.senderFrame || event.senderFrame.url !== window.webContents.getURL()) throw new Error('无效调用来源');
}
function installHandlers() {
  ipcMain.handle('deskcue:read', event => { assertSender(event); return snapshot(); });
  ipcMain.handle('deskcue:command', (event, command) => {
    const execute = async () => {
    try {
      assertSender(event);
      if (!command || typeof command !== 'object') throw new Error('操作无效');
      if (command.type === 'time-zone') {
        const setting = validateTimeZone(command.timeZone);
        const systemZone = setting === FOLLOW_SYSTEM ? await readSystemTimeZone() : undefined;
        const now = new Date();
        commit(configureTimeZone(state, setting, now, systemZone), now);
        checkReminders();
        return { ok: true, state: snapshot() };
      }
      const next = structuredClone(state);
      const now = new Date();
      const zone = state.settings.effectiveTimeZone;
      next.tasks = next.tasks.map(task => collectWeeklyMisses(task, now, zone));
      const task = next.tasks.find(item => item.id === command.id);
      const requireTask = () => { if (!task) throw new Error('事项不存在，请刷新后重试'); };
      switch (command.type) {
        case 'save': {
          const previous = command.id ? task : null;
          if (command.id) requireTask();
          if (previous && previous.status !== 'active') throw new Error('请先恢复事项再编辑');
          const saved = validateTask(command.task, previous, now, zone);
          if (previous && (previous.priority !== saved.priority || previous.category !== saved.category || previous.dueAt !== saved.dueAt || previous.endDate !== saved.endDate)) {
            for (const item of next.tasks) if ((item.category === previous.category && item.priority === previous.priority) || (item.category === saved.category && item.priority === saved.priority)) item.manualOrder = null;
            saved.manualOrder = null;
          }
          if (previous) next.tasks[next.tasks.findIndex(item => item.id === saved.id)] = saved;
          else next.tasks.push(saved);
          break;
        }
        case 'complete':
        case 'finish':
          requireTask();
          if (task.status !== 'active') throw new Error('事项已归档');
          if (command.type === 'finish') { task.status = 'completed'; task.completedAt = now.toISOString(); }
          else {
            if (task.category === 'daily' && task.startDate && dateKey(now, zone) < task.startDate) throw new Error('事项尚未开始');
            completeTask(task, now, zone);
          }
          break;
        case 'cancel': requireTask(); task.status = 'canceled'; task.canceledAt = now.toISOString(); break;
        case 'restore':
          requireTask();
          if (task.status !== 'active') {
            if (isWeekly(task)) task.weeklySince = dateKey(now, zone);
            task.status = 'active'; task.canceledAt = null; task.completedAt = null; task.notifiedKey = '';
            delete task.recentNotifiedKeys;
          }
          break;
        case 'acknowledge-misses':
          requireTask();
          acknowledgeWeeklyMisses(task, command.dates);
          break;
        case 'transfer': {
          requireTask();
          if (task.category !== 'waiting' || task.status !== 'active') throw new Error('仅可转移正在等待的事项');
          for (const item of next.tasks) if (item.priority === task.priority && ['waiting', 'action'].includes(item.category)) item.manualOrder = null;
          const reminder = reminderState(task, now, zone);
          if (reminder.at !== null) { task.reminderMode = 'absolute'; task.reminderAt = wallTime(reminder.at, zone); }
          task.category = 'action';
          if (task.notifiedKey === reminder.key) task.notifiedKey = reminderState(task, now, zone).key;
          break;
        }
        case 'priority':
          requireTask();
          if (![0, 1, 2].includes(command.priority)) throw new Error('优先级无效');
          for (const item of next.tasks) if (item.category === task.category && [task.priority, command.priority].includes(item.priority)) item.manualOrder = null;
          task.priority = command.priority; break;
        case 'reorder': {
          requireTask();
          reorderTasks(next.tasks, task.id, command.targetId, zone);
          break;
        }
        case 'auto-sort': for (const item of next.tasks) item.manualOrder = null; break;
        case 'import-background': {
          const selection = await dialog.showOpenDialog(window, { title: '选择自定义背景（最多三张）', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
          if (selection.canceled || !selection.filePaths[0]) return { ok: true, state: snapshot() };
          await backgrounds.importFile(selection.filePaths[0], state.settings, {
            decode: bytes => !nativeImage.createFromBuffer(bytes).isEmpty(),
            confirmEviction: async oldest => {
              const result = await dialog.showMessageBox(window, { type: 'warning', title: '自定义背景已满三张', message: '添加新图片将删除最早导入的背景', detail: `将删除 data/backgrounds 中“${oldest.name}”的副本。原始图片不会删除。`, buttons: ['删除最早图片并添加', '取消'], defaultId: 1, cancelId: 1 });
              return result.response === 0;
            },
            save: ({ backgrounds, backgroundId, backgroundGarbage }) => commit({
              ...state, settings: { ...state.settings, backgrounds, backgroundId, backgroundGarbage },
            }),
          });
          return { ok: true, state: snapshot() };
        }
        case 'settings': {
          if (command.theme !== undefined) {
            if (!Object.hasOwn(themes, command.theme)) throw new Error('配色无效');
            next.settings.theme = command.theme;
          }
          if (command.backgroundId !== undefined) {
            if (command.backgroundId !== null && !(next.settings.backgrounds || []).some(image => image.id === command.backgroundId)) throw new Error('背景图片不存在');
            next.settings.backgroundId = command.backgroundId;
          }
          if (typeof command.compact === 'boolean') {
            if (command.compact && !state.settings.compact) next.settings.expandedHeight = window.getSize()[1];
            next.settings.compact = command.compact;
            window.setSize(window.getSize()[0], command.compact ? 190 : Math.max(420, next.settings.expandedHeight || 760));
          }
          if (command.mode !== undefined) {
            if (!['normal', 'top', 'desktop'].includes(command.mode)) throw new Error('显示模式无效');
            await applyMode(command.mode);
            next.tasks = state.tasks;
            next.settings.effectiveTimeZone = state.settings.effectiveTimeZone;
            next.settings.mode = command.mode;
          }
          break;
        }
        case 'open-data': await shell.openPath(dataDirectory); return { ok: true, state: snapshot() };
        case 'open-project': await shell.openExternal('https://github.com/Gemini-yzc/deskcue'); return { ok: true, state: snapshot() };
        case 'hide': window.hide(); return { ok: true, state: snapshot() };
        default: throw new Error('未知操作');
      }
      if (task) task.updatedAt = now.toISOString();
      commit(next, now); checkReminders();
      return { ok: true, state: snapshot() };
    } catch (error) { return { ok: false, error: error.message }; }
    };
    const result = commandQueue.then(execute, execute);
    commandQueue = result.then(() => {}, () => {});
    return result;
  });
}
function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = state.settings.bounds;
  const visible = bounds && screen.getAllDisplays().some(display => bounds.x < display.workArea.x + display.workArea.width && bounds.x + 100 > display.workArea.x && bounds.y < display.workArea.y + display.workArea.height && bounds.y + 100 > display.workArea.y);
  window = new BrowserWindow({ width: 430, height: Math.min(820, area.height), minWidth: 360, minHeight: 180,
    x: area.x + area.width - 450, y: area.y + 20, ...(visible ? bounds : {}),
    title: 'DeskCue', icon: iconPath, frame: false, backgroundColor: '#f8f9f5', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.loadFile(path.join(__dirname, 'src', 'app.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (process.platform === 'win32') window.hookWindowMessage(0x001e, refreshReminders);
  window.once('ready-to-show', async () => {
    window.showInactive();
    try { await applyMode(state.settings.mode); }
    catch (error) { report(error); commit({ ...state, settings: { ...state.settings, mode: 'normal' } }); }
    if (store.recovered) dialog.showMessageBox(window, { type: 'warning', message: '已从有效备份恢复数据', detail: '损坏的原文件已保留在 data 目录，请检查恢复的事项。' });
  });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (quitting || !window || window.isDestroyed()) return;
      try { commit({ ...state, settings: { ...state.settings, bounds: window.getBounds() } }); } catch (error) { report(error); }
    }, 600);
  };
  window.on('move', saveBounds); window.on('resize', saveBounds);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    try {
      if (startupError) throw startupError;
      store = new Storage(dataDirectory); state = store.load(); backgrounds = new Backgrounds(dataDirectory);
      state = configureTimeZone(state, state.settings.timeZone, new Date(), systemTimeZone());
      state.settings.backgroundGarbage = backgrounds.cleanup(state.settings.backgroundGarbage, state.settings.backgrounds);
      commit(state);
      normalIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
      const bitmap = Buffer.alloc(16 * 16 * 4);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ((x - 7.5) ** 2 + (y - 7.5) ** 2 < 48) { const i = (y * 16 + x) * 4; bitmap[i] = 55; bitmap[i + 1] = 130; bitmap[i + 2] = 225; bitmap[i + 3] = 255; }
      alertIcon = nativeImage.createFromBitmap(bitmap, { width: 16, height: 16 });
      tray = new Tray(normalIcon);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '显示 DeskCue', click: showWindow },
        { label: '新增事项', click: () => { showWindow(); window.webContents.send('deskcue:new'); } },
        { type: 'separator' }, { label: '打开数据目录', click: () => shell.openPath(dataDirectory) },
        { label: '退出 DeskCue', click: () => { quitting = true; app.quit(); } },
      ]));
      tray.on('click', showWindow); tray.on('double-click', showWindow);
      installHandlers(); createWindow(); checkReminders();
      powerMonitor.on('resume', refreshReminders); powerMonitor.on('unlock-screen', refreshReminders);
      app.on('activate', showWindow);
    } catch (error) {
      dialog.showErrorBox('DeskCue 无法启动', `无法读写数据目录：${dataDirectory}\n${error.message}\n请将程序放在可写文件夹，不要直接在压缩包内运行。`);
      quitting = true; app.quit();
    }
  });
}
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; clearTimeout(reminderTimer); clearTimeout(boundsTimer); clearInterval(blinkTimer); });
