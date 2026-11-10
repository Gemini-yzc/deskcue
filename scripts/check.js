const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const files = ['main.js', 'preload.js'];
for (const directory of ['src', 'scripts', 'tests']) {
  for (const name of fs.readdirSync(path.join(root, directory))) if (name.endsWith('.js')) files.push(path.join(directory, name));
}
for (const file of files) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
console.log(`Syntax OK: ${files.length} JavaScript files`);
