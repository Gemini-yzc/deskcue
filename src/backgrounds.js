const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class Backgrounds {
  constructor(dataDirectory) {
    this.directory = path.join(dataDirectory, 'backgrounds');
    fs.mkdirSync(this.directory, { recursive: true });
  }
  filePath(file) {
    if (typeof file !== 'string' || !/^[0-9a-f]{64}\.(png|jpg|webp)$/.test(file)) throw new Error('背景图片文件名无效');
    const resolved = path.resolve(this.directory, file);
    if (path.dirname(resolved) !== path.resolve(this.directory)) throw new Error('背景图片超出数据目录');
    return resolved;
  }
  async importFile(source, settings, { decode, confirmEviction, save }) {
    const size = fs.statSync(source).size;
    if (!size || size > 30 * 1024 * 1024) throw new Error('请选择不超过30MB的PNG、JPG或WebP图片');
    const bytes = fs.readFileSync(source);
    let extension;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) extension = 'jpg';
    else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') extension = 'webp';
    if (!extension || !decode(bytes)) throw new Error('图片无法读取，请使用有效的PNG、JPG或WebP');
    const id = crypto.createHash('sha256').update(bytes).digest('hex');
    const images = [...(settings.backgrounds || [])].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    const duplicate = images.find(image => image.id === id);
    if (duplicate && fs.existsSync(this.filePath(duplicate.file))) {
      await save({ ...settings, backgroundId: id });
      return { imported: false, duplicate: true };
    }
    const remaining = images.filter(image => image.id !== id);
    const oldest = remaining.length >= 3 ? remaining[0] : null;
    if (oldest && !(await confirmEviction(oldest))) return { canceled: true };
    const file = `${id}.${extension}`;
    const target = this.filePath(file);
    const existed = fs.existsSync(target);
    fs.writeFileSync(target, bytes, { flag: 'w' });
    const item = { id, file, name: path.basename(source), addedAt: new Date().toISOString() };
    const list = [...(oldest ? remaining.slice(1) : remaining), item];
    const garbage = [...new Set([...(settings.backgroundGarbage || []), ...(oldest ? [oldest.file] : [])])];
    try { await save({ ...settings, backgrounds: list, backgroundId: id, backgroundGarbage: garbage }); }
    catch (error) { if (!existed) fs.unlinkSync(target); throw error; }
    const pending = this.cleanup(garbage, list);
    if (pending.length !== garbage.length) await save({ ...settings, backgrounds: list, backgroundId: id, backgroundGarbage: pending });
    if (pending.length) throw new Error('新背景已保存，但旧图片文件被占用，暂未删除；释放占用后重新启动将自动重试');
    return { imported: true, evicted: oldest?.id || null };
  }
  cleanup(garbage, live) {
    return (garbage || []).filter(file => {
      if ((live || []).some(item => item.file === file)) return false;
      try { const target = this.filePath(file); if (fs.existsSync(target)) fs.unlinkSync(target); return false; } catch { return true; }
    });
  }
}
module.exports = { Backgrounds };
