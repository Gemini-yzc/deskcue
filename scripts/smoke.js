// Developer-only smoke check: launches an isolated instance and inspects its own local page over CDP.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const executable = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'node_modules/electron/dist/electron.exe');
const packaged = Boolean(process.argv[2]);
const label = packaged ? 'packaged' : 'source';
const portableDefault = process.argv.includes('--portable-default');
const base = path.join(root, 'work', `smoke-${label}-${Date.now()}`);
const directory = portableDefault ? path.join(base, 'data') : base;
fs.mkdirSync(directory, { recursive: true });
const launchExecutable = portableDefault ? path.join(base, 'DeskCue.exe') : executable;
if (portableDefault) fs.copyFileSync(executable, launchExecutable);
const { validateTask } = require('../src/domain');
const now = new Date();
const yesterday = new Date(now.getTime() - 86400000);
const initial = [
  validateTask({ title: '检查上线后的异常日志', category: 'daily', priority: 0, reminderMode: 'relative', dailyTime: '00:00', description: '每日确认，次日恢复' }),
  validateTask({ title: '完成方案中的成本测算', category: 'action', priority: 0, reminderMode: 'absolute', reminderAt: yesterday.toISOString(), dueAt: new Date(now.getTime() + 86400000).toISOString(), description: '核对人力投入与执行周期' }),
  validateTask({ title: '等待供应商返回报价', category: 'waiting', priority: 1, reminderMode: 'off', waitingFor: '供应商对接人' }),
];
fs.writeFileSync(path.join(directory, 'tasks.json'), JSON.stringify({ version: 1, tasks: initial, settings: { mode: 'normal', compact: false } }));
const port = 19300 + Math.floor(Math.random() * 500);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let child;
let ws;
let sequence = 0;
const requests = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    requests.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function launch() {
  const log = fs.openSync(path.join(directory, 'process.log'), 'a');
  const args = [...(!packaged ? [root] : []), ...(!portableDefault ? [`--data-dir=${directory}`] : []), `--remote-debugging-port=${port}`];
  child = spawn(launchExecutable, args, { env, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let target;
  for (let tries = 0; tries < 120; tries++) {
    try { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = targets.find(item => item.type === 'page' && item.url.endsWith('/src/app.html')); if (target) break; } catch {}
    await sleep(500);
  }
  assert.ok(target, `Application page missing. Logs: ${directory}`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data); const request = requests.get(message.id);
    if (request) { requests.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  });
}
function stop() {
  if (ws) { ws.close(); ws = null; }
  if (child?.pid) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  child = null;
}
async function run() {
  await launch();
  for (let tries = 0; tries < 30; tries++) { if (await evaluate('!!document.querySelector(".task")')) break; await sleep(200); }
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".group-head")).map(el=>el.textContent.match(/每日关注|本人推进|等待外部/)[0])'), ['每日关注', '本人推进', '等待外部']);
  assert.equal(await evaluate('document.querySelectorAll(".reminding").length'), 2);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(directory, 'panel.png'), Buffer.from(shot.data, 'base64'));

  // Exercise the actual editor form and save IPC, rather than only writing test data.
  await evaluate('document.querySelector("#add").click()');
  await evaluate(`document.querySelector('[name=title]').value='界面保存与重启验证'; document.querySelector('[name=category]').value='action'; document.querySelector('[name=category]').dispatchEvent(new Event('change')); document.querySelector('[name=reminderMode]').value='off'; document.querySelector('[name=reminderMode]').dispatchEvent(new Event('change')); document.querySelector('#task-form').requestSubmit()`);
  for (let tries = 0; tries < 30; tries++) { if (!(await evaluate('document.querySelector("#editor").open'))) break; await sleep(200); }
  assert.equal(await evaluate('document.querySelector("#editor").open'), false);
  let disk = JSON.parse(fs.readFileSync(path.join(directory, 'tasks.json'), 'utf8'));
  assert.equal(disk.tasks.some(task => task.title === '界面保存与重启验证'), true);
  assert.ok(disk.tasks[0].notifiedKey);
  const daily = disk.tasks.find(task => task.category === 'daily');
  const waiting = disk.tasks.find(task => task.category === 'waiting');
  let result = await evaluate(`window.deskcue.command(${JSON.stringify({ type: 'complete', id: daily.id })})`);
  assert.equal(result.ok, true); assert.equal(result.state.tasks.find(task => task.id === daily.id).status, 'active');
  result = await evaluate(`window.deskcue.command(${JSON.stringify({ type: 'transfer', id: waiting.id })})`);
  assert.equal(result.ok, true); assert.equal(result.state.tasks.find(task => task.id === waiting.id).category, 'action');
  result = await evaluate(`window.deskcue.command(${JSON.stringify({ type: 'cancel', id: waiting.id })})`);
  assert.equal(result.ok, true); assert.ok(result.state.tasks.find(task => task.id === waiting.id).canceledAt);
  result = await evaluate(`window.deskcue.command(${JSON.stringify({ type: 'restore', id: waiting.id })})`);
  assert.equal(result.ok, true);
  result = await evaluate('window.deskcue.command({type:"settings",compact:true})'); assert.equal(result.ok, true);
  await sleep(300); assert.equal(await evaluate('innerHeight < 250'), true);
  result = await evaluate('window.deskcue.command({type:"settings",compact:false})'); assert.equal(result.ok, true);
  await cdp('Page.reload'); await sleep(800);
  const read = await evaluate('window.deskcue.read()');
  assert.equal(read.tasks.length, 4); assert.equal(read.dataDirectory.toLowerCase(), directory.toLowerCase());
  for (const mode of ['top', 'desktop', 'normal']) {
    const result = await evaluate(`window.deskcue.command({type:'settings',mode:'${mode}'})`);
    assert.equal(result.ok, true, result.error); assert.equal(result.state.settings.mode, mode);
  }
  const beforeRestart = await evaluate('window.deskcue.read()');
  stop(); await sleep(800); await launch(); await sleep(600);
  const afterRestart = await evaluate('window.deskcue.read()');
  assert.deepEqual(afterRestart.tasks, beforeRestart.tasks);
  console.log(JSON.stringify({ ok: true, executable: launchExecutable, directory, screenshot: path.join(directory, 'panel.png'), checks: ['group-order', 'continuous-reminder', 'editor-save', 'daily-closure', 'transfer', 'cancel-restore', 'compact-window', 'reload-persistence', 'three-window-modes', 'process-restart-persistence', ...(portableDefault ? ['exe-adjacent-data'] : [])] }, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(stop);
