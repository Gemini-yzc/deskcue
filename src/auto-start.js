const fs = require('node:fs');
const path = require('node:path');

const description = 'DeskCue (org.deskcue.desktop)';

function createAutoStart({ startupDirectory, appData, executable, shell }) {
  const shortcut = path.join(startupDirectory, 'DeskCue - Auto Start.lnk');
  const marker = path.join(appData, 'DeskCue', 'auto-start-initialized');

  function readShortcut() {
    if (!fs.existsSync(shortcut)) return null;
    const details = shell.readShortcutLink(shortcut);
    if (details.description !== description) throw new Error('启动文件夹中已有同名快捷方式');
    return details;
  }

  function isEnabled() {
    const details = readShortcut();
    return details !== null && path.normalize(details.target).toLowerCase() === path.normalize(executable).toLowerCase();
  }

  function markInitialized() {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.closeSync(fs.openSync(marker, 'a'));
  }

  function writeShortcut() {
    if (!shell.writeShortcutLink(shortcut, { target: executable, cwd: path.dirname(executable), description })) {
      throw new Error('无法创建启动快捷方式');
    }
  }

  function initialize() {
    if (fs.existsSync(marker)) return;
    if (!readShortcut()) writeShortcut();
    markInitialized();
  }

  function setEnabled(enabled) {
    const existing = readShortcut();
    markInitialized();
    if (enabled) writeShortcut();
    else if (existing) fs.unlinkSync(shortcut);
  }

  return { initialize, isEnabled, setEnabled };
}

module.exports = { createAutoStart };
