import sharp from 'sharp';
import { createHash } from 'node:crypto';
export const statuses = ['跟进中', '已成交', '暂停跟进', '无效客户'];
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function text(value, label, max, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max) fail(`${label}格式不正确或超过 ${max} 字`);
  const result = value.trim(); if (required && !result) fail(`${label}不能为空`); return result;
}
export function normalize(name) { return name.normalize('NFKC').replace(/\s+/gu, '').toLowerCase(); }
export function password(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) fail('密码需为 10–128 位');
  return value;
}
export function account(body) {
  const username = text(body.username, '账号', 40, true).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(username)) fail('账号需为 3–40 位字母、数字、下划线或横线');
  return { name: text(body.name, '姓名', 80, true), username };
}
export async function image(data) {
  if (!data) return { bytes: null, hash: null, dhash: null };
  if (typeof data !== 'string' || data.length > 4 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) fail('头像需为 PNG、JPEG 或 WebP，且小于 3 MB');
  const raw = Buffer.from(data.split(',')[1], 'base64');
  let bytes, pixels;
  try {
    const info = await sharp(raw, { limitInputPixels: 16000000 }).metadata();
    if (!['png', 'jpeg', 'webp'].includes(info.format) || (info.pages || 1) > 1) fail('不支持此头像格式');
    bytes = await sharp(raw, { limitInputPixels: 16000000 }).rotate().resize(256, 256, { fit: 'cover' }).png().toBuffer();
    pixels = await sharp(bytes).resize(9, 8).greyscale().raw().toBuffer();
  } catch { fail('头像图片损坏、过大或无法解码'); }
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | BigInt(pixels[y * 9 + x] > pixels[y * 9 + x + 1]);
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex'), dhash: bits.toString(16).padStart(16, '0') };
}
export function distance(a, b) {
  if (!a || !b) return Infinity; let n = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), count = 0;
  while (n) { n &= n - 1n; count++; } return count;
}
export async function customer(body) {
  const name = text(body.name, '客户姓名', 120, true), status = body.status || '跟进中';
  if (!statuses.includes(status)) fail('无效跟进状态');
  return { name, normalized_name: normalize(name), source: text(body.source, '来源', 200), note: text(body.note, '备注', 4000), status, ...(await image(body.avatar)) };
}

