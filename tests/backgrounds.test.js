const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Backgrounds } = require('../src/backgrounds');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskcue-background-test-'));
  t.after(() => { assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new Backgrounds(root);
  const files = [0, 1, 2, 3].map(index => {
    const file = path.join(root, `source-${index}.png`);
    fs.writeFileSync(file, Buffer.concat([fs.readFileSync(path.join(__dirname, '../build/icon.png')), Buffer.from([index])]));
    return file;
  });
  let settings = {};
  const options = { decode: () => true, confirmEviction: async () => true, save: value => { settings = value; } };
  return { store, files, options, get settings() { return settings; } };
}
test('导入图片复制到data子目录，第四张确认后删除最早副本，原文件保留', async t => {
  const env = setup(t);
  for (let i = 0; i < 3; i++) await env.store.importFile(env.files[i], env.settings, env.options);
  const first = env.settings.backgrounds[0]; let prompted = false;
  await env.store.importFile(env.files[3], env.settings, { ...env.options, confirmEviction: async image => { prompted = true; assert.equal(image.id, first.id); return true; } });
  assert.equal(prompted, true); assert.equal(env.settings.backgrounds.length, 3);
  assert.equal(fs.existsSync(env.store.filePath(first.file)), false);
  assert.equal(fs.existsSync(env.files[0]), true);
  assert.equal(fs.readdirSync(env.store.directory).length, 3);
});
test('取消第四张导入时不改列表、不复制新文件、不删除旧文件', async t => {
  const env = setup(t);
  for (let i = 0; i < 3; i++) await env.store.importFile(env.files[i], env.settings, env.options);
  const before = JSON.stringify(env.settings);
  const result = await env.store.importFile(env.files[3], env.settings, { ...env.options, confirmEviction: async () => false });
  assert.equal(result.canceled, true); assert.equal(JSON.stringify(env.settings), before); assert.equal(fs.readdirSync(env.store.directory).length, 3);
});
test('重复选择同一内容不占第四个名额，保存失败不删除旧图', async t => {
  const env = setup(t);
  for (let i = 0; i < 3; i++) await env.store.importFile(env.files[i], env.settings, env.options);
  const result = await env.store.importFile(env.files[0], env.settings, env.options);
  assert.equal(result.duplicate, true); assert.equal(env.settings.backgrounds.length, 3);
  const before = JSON.stringify(env.settings);
  await assert.rejects(() => env.store.importFile(env.files[3], env.settings, { ...env.options, save: () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(JSON.stringify(env.settings), before); assert.equal(fs.readdirSync(env.store.directory).length, 3);
});
test('拒绝伪图片和越界文件名', async t => {
  const env = setup(t);
  await assert.rejects(() => env.store.importFile(env.files[0], env.settings, { ...env.options, decode: () => false }), /无法读取/);
  assert.throws(() => env.store.filePath('../tasks.json'), /文件名/);
  assert.throws(() => env.store.filePath('C:\\example.png'), /文件名/);
});
