const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell, screen, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { Storage } = require('./src/storage');
const { validateTask, reminderState, purgeCanceled, sortedTasks, completeTask, dateKey } = require('./src/domain');

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
const notifiedThisRun = new Set();
const iconPath = path.join(__dirname, 'build', 'icon.ico');

function snapshot() {
  return { ...state, tasks: sortedTasks(state.tasks), dataDirectory, now: new Date().toISOString(), backupWarning: store.backupError || '' };
}
function broadcast() {
  if (window && !window.isDestroyed()) window.webContents.send('deskcue:state', snapshot());
}
function commit(next) { state = store.save(next); broadcast(); }
function report(error) {
  console.error(error);
  if (window && !window.isDestroyed()) window.webContents.send('deskcue:error', error.message);
}
function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  if (state.settings.mode !== 'desktop') window.focus();
}
function setTrayAlert(count) {
  if (pendingAlertCount === count) return;
  pendingAlertCount = count;
  clearInterval(blinkTimer);
  tray.setToolTip(count ? `案头 · ${count} 项待闭环` : '案头 · 每日关注 / 本人推进 / 等待外部');
  tray.setImage(count ? alertIcon : normalIcon);
  if (count) {
    let alternate = true;
    blinkTimer = setInterval(() => { alternate = !alternate; tray.setImage(alternate ? alertIcon : normalIcon); }, 1400);
  }
}
function checkReminders() {
  clearTimeout(reminderTimer);
  if (!state || quitting) return;
  const now = new Date();
  const clean = purgeCanceled(state.tasks, now);
  if (clean.length !== state.tasks.length || maintenanceDay !== dateKey(now)) {
    try { commit({ ...state, tasks: clean }); maintenanceDay = dateKey(now); } catch (error) { report(error); }
  }
  let nextAt = now.getTime() + 60000;
  const due = [];
  let count = 0;
  for (const task of state.tasks) {
    const reminder = reminderState(task, now);
    if (reminder.active) {
      count++;
      const key = `${task.id}:${reminder.key}`;
      if (task.notifiedKey !== reminder.key && !notifiedThisRun.has(key)) due.push({ task, key, reminderKey: reminder.key });
    } else if (reminder.at && reminder.at > now.getTime()) nextAt = Math.min(nextAt, reminder.at);
  }
  if (due.length) {
    for (const item of due) notifiedThisRun.add(item.key);
    const updated = state.tasks.map(task => {
      const match = due.find(item => item.task.id === task.id);
      return match ? { ...task, notifiedKey: match.reminderKey } : task;
    });
    try { commit({ ...state, tasks: updated }); } catch (error) { report(error); }
    if (Notification.isSupported()) {
      const notification = new Notification({ title: due.length === 1 ? '案头 · 事项提醒' : `案头 · ${due.length} 项需要关注`,
        body: due.slice(0, 3).map(item => item.task.title).join('\n').slice(0, 500), silent: true, icon: iconPath });
      notification.on('click', showWindow);
      notification.on('failed', (_, error) => console.error('系统通知未送达：', error));
      notification.show();
    }
  }
  setTrayAlert(count);
  broadcast();
  reminderTimer = setTimeout(checkReminders, Math.max(1000, nextAt - Date.now()));
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
      const next = structuredClone(state);
      const now = new Date();
      const task = next.tasks.find(item => item.id === command.id);
      const requireTask = () => { if (!task) throw new Error('事项不存在，请刷新后重试'); };
      switch (command.type) {
        case 'save': {
          const previous = command.id ? task : null;
          if (command.id) requireTask();
          if (previous && previous.status !== 'active') throw new Error('请先恢复事项再编辑');
          const saved = validateTask(command.task, previous, now);
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
            if (task.category === 'daily' && task.startDate && dateKey(now) < task.startDate) throw new Error('事项尚未开始');
            completeTask(task, now);
          }
          break;
        case 'cancel': requireTask(); task.status = 'canceled'; task.canceledAt = now.toISOString(); break;
        case 'restore': requireTask(); task.status = 'active'; task.canceledAt = null; task.completedAt = null; task.notifiedKey = ''; break;
        case 'transfer': {
          requireTask();
          if (task.category !== 'waiting' || task.status !== 'active') throw new Error('仅可转移正在等待的事项');
          const reminder = reminderState(task, now);
          if (reminder.at) { task.reminderMode = 'absolute'; task.reminderAt = new Date(reminder.at).toISOString(); }
          task.category = 'action';
          break;
        }
        case 'priority':
          requireTask();
          if (![0, 1, 2].includes(command.priority)) throw new Error('优先级无效');
          task.priority = command.priority; break;
        case 'move': {
          requireTask();
          const peers = sortedTasks(next.tasks.filter(item => item.status === 'active' && item.category === task.category && item.priority === task.priority));
          const index = peers.findIndex(item => item.id === task.id);
          const other = peers[index + (command.direction === 'up' ? -1 : 1)];
          if (other) {
            const otherIndex = peers.indexOf(other);
            [peers[index], peers[otherIndex]] = [peers[otherIndex], peers[index]];
            peers.forEach((item, order) => { item.order = order; });
          }
          break;
        }
        case 'settings': {
          if (typeof command.compact === 'boolean') {
            if (command.compact && !state.settings.compact) next.settings.expandedHeight = window.getSize()[1];
            next.settings.compact = command.compact;
            window.setSize(window.getSize()[0], command.compact ? 190 : Math.max(420, next.settings.expandedHeight || 760));
          }
          if (command.mode !== undefined) {
            if (!['normal', 'top', 'desktop'].includes(command.mode)) throw new Error('显示模式无效');
            await applyMode(command.mode);
            next.settings.mode = command.mode;
          }
          break;
        }
        case 'open-data': await shell.openPath(dataDirectory); return { ok: true, state: snapshot() };
        case 'hide': window.hide(); return { ok: true, state: snapshot() };
        default: throw new Error('未知操作');
      }
      if (task) task.updatedAt = now.toISOString();
      commit(next); checkReminders();
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
    title: '案头 · DeskCue', icon: iconPath, frame: false, backgroundColor: '#f8f9f5', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.loadFile(path.join(__dirname, 'src', 'app.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
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
      store = new Storage(dataDirectory); state = store.load(); commit(state);
      normalIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
      const bitmap = Buffer.alloc(16 * 16 * 4);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ((x - 7.5) ** 2 + (y - 7.5) ** 2 < 48) { const i = (y * 16 + x) * 4; bitmap[i] = 55; bitmap[i + 1] = 130; bitmap[i + 2] = 225; bitmap[i + 3] = 255; }
      alertIcon = nativeImage.createFromBitmap(bitmap, { width: 16, height: 16 });
      tray = new Tray(normalIcon);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '显示案头', click: showWindow },
        { label: '新增事项', click: () => { showWindow(); window.webContents.send('deskcue:new'); } },
        { type: 'separator' }, { label: '打开数据目录', click: () => shell.openPath(dataDirectory) },
        { label: '退出案头', click: () => { quitting = true; app.quit(); } },
      ]));
      tray.on('click', showWindow); tray.on('double-click', showWindow);
      installHandlers(); createWindow(); checkReminders();
      powerMonitor.on('resume', checkReminders); powerMonitor.on('unlock-screen', checkReminders);
      app.on('activate', showWindow);
    } catch (error) {
      dialog.showErrorBox('案头无法启动', `无法读写数据目录：${dataDirectory}\n${error.message}\n请将程序放在可写文件夹，不要直接在压缩包内运行。`);
      quitting = true; app.quit();
    }
  });
}
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; clearTimeout(reminderTimer); clearTimeout(boundsTimer); clearInterval(blinkTimer); });
