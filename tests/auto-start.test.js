const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createAutoStart } = require('../src/auto-start');

test('registers on first launch, remembers opt-out, and can register a moved portable EXE', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskcue-auto-start-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, '便携版', 'DeskCue.exe');
  const options = {
    startupDirectory: directory,
    appData: directory,
    executable,
    shell: {
      readShortcutLink: file => JSON.parse(fs.readFileSync(file, 'utf8')),
      writeShortcutLink(file, details) {
        fs.writeFileSync(file, JSON.stringify(details));
        return true;
      },
    },
  };
  const launch = (overrides = {}) => createAutoStart({ ...options, ...overrides });
  const autoStart = launch();
  assert.equal(autoStart.isEnabled(), false);
  autoStart.initialize();
  assert.equal(autoStart.isEnabled(), true);
  const shortcut = path.join(directory, 'DeskCue - Auto Start.lnk');
  assert.equal(options.shell.readShortcutLink(shortcut).target, executable);
  assert.equal(options.shell.readShortcutLink(shortcut).cwd, path.dirname(executable));

  autoStart.setEnabled(false);
  const reopened = launch();
  reopened.initialize();
  assert.equal(reopened.isEnabled(), false);
  reopened.setEnabled(true);
  const moved = launch({ executable: path.join(directory, 'DeskCue-new.exe') });
  moved.initialize();
  assert.equal(moved.isEnabled(), false);
  moved.setEnabled(true);
  assert.equal(moved.isEnabled(), true);

  fs.writeFileSync(shortcut, JSON.stringify({ description: 'Unrelated shortcut' }));
  assert.throws(() => moved.setEnabled(false), /同名快捷方式/);
  assert.equal(options.shell.readShortcutLink(shortcut).description, 'Unrelated shortcut');
});
