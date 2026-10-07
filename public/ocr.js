const NOISE = /^(上午|下午|昨天|今天|剛剛|刚刚|星期|週[一二三四五六日天])|\d{1,2}[:：]\d{2}|https?:|www\./u;
const CHAT = /已讀|已读|未讀|未读|通話|语音|語音|視訊|视频|照片|圖片|图片|貼圖|贴图|訊息|消息|發送|发送|收到|昨天|今天|剛剛|刚刚|請問|请问|謝謝|谢谢|好的|沒問題|没问题|了解|晚安|早安|方便|怎麼|怎么|在哪|在嗎|在吗|麻煩|麻烦|傳給|传给|文件|網址|网址|加好友|歡迎|欢迎|聯絡|联系/u;

function clean(value) {
  return String(value || '').normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^[\s·•:：|]+|[\s·•:：|]+$/g, '')
    .replace(/\s+(上午|下午)?\s*\d{1,2}[:：]\d{2}$/u, '')
    .replace(/\s{2,}/g, ' ').trim();
}
function lineBox(line) {
  const points = Array.isArray(line?.polygon) ? line.polygon : [];
  const xs = points.map(point => Number(point?.x)).filter(Number.isFinite);
  const ys = points.map(point => Number(point?.y)).filter(Number.isFinite);
  return xs.length && ys.length ? { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } : null;
}
function candidate(text, box, width, score) {
  const value = clean(text);
  const compact = value.replace(/\s/g, '');
  if (!box || !compact || compact.length > 24 || box.x0 > width * .94 || score < 10) return false;
  if (NOISE.test(compact) || CHAT.test(compact) || /https?:|www\./i.test(compact) || /[，。！？!?；;：:]/u.test(compact)) return false;
  const useful = (compact.match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
  return useful / Math.max(1, compact.length) >= .62 && /[\p{Script=Han}A-Za-z]/u.test(compact);
}
function filterLines(lines, width, height, offsetY = 0) {
  const raw = lines.map(line => {
    const box = lineBox(line);
    if (box) { box.y0 += offsetY; box.y1 += offsetY; }
    const score = Number(line?.recognitionScore ?? line?.score ?? 0);
    return { text: clean(line?.text), confidence: Math.max(0, Math.min(100, score <= 1 ? score * 100 : score)), bbox: box };
  }).filter(item => candidate(item.text, item.bbox, width, item.confidence) && item.bbox.y1 > item.bbox.y0);
  raw.sort((a, b) => ((a.bbox.y0 + a.bbox.y1) - (b.bbox.y0 + b.bbox.y1)) || a.bbox.x0 - b.bbox.x0);
  const bands = [];
  for (const item of raw) {
    const center = (item.bbox.y0 + item.bbox.y1) / 2;
    const h = item.bbox.y1 - item.bbox.y0;
    const band = bands.find(group => Math.abs(group.center - center) <= Math.min(group.height, h) * .45);
    if (band) { band.items.push(item); band.center = (band.center + center) / 2; band.height = Math.max(band.height, h); }
    else bands.push({ center, height: h, items: [item] });
  }
  const merged = [];
  for (const band of bands) {
    let row = null;
    for (const item of band.items.sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
      const gap = row ? item.bbox.x0 - row.bbox.x1 : Infinity;
      const rh = row ? row.bbox.y1 - row.bbox.y0 : 0;
      const ih = item.bbox.y1 - item.bbox.y0;
      if (row && gap >= 0 && gap <= Math.min(rh, ih) * .75 && row.text.length + item.text.length <= 24 && !CHAT.test(row.text) && !CHAT.test(item.text)) {
        row.text += /[A-Za-z]$/.test(row.text) && /^[A-Za-z]/.test(item.text) ? ' ' + item.text : item.text;
        row.confidence = Math.min(row.confidence, item.confidence);
        row.bbox.x1 = item.bbox.x1; row.bbox.y0 = Math.min(row.bbox.y0, item.bbox.y0); row.bbox.y1 = Math.max(row.bbox.y1, item.bbox.y1);
      } else { row = { ...item, bbox: { ...item.bbox } }; merged.push(row); }
    }
  }
  const valid = merged.filter(item => {
    const text = item.text.replace(/\s/g, '');
    return text.length >= 2 && !/^(VIP|NEW|官方帳號|官方账号)$/i.test(text) && candidate(text, item.bbox, width, item.confidence);
  });
  if (!valid.length) return [];
  const heights = valid.map(item => item.bbox.y1 - item.bbox.y0).sort((a, b) => a - b);
  const tolerance = Math.max(12, (heights[Math.floor(heights.length / 2)] || 16) * .8);
  const bestX = valid.map(item => item.bbox.x0).map(x => {
    const nearby = valid.filter(item => Math.abs(item.bbox.x0 - x) <= tolerance);
    const han = nearby.some(item => /^[\p{Script=Han}]{2,6}$/u.test(item.text.replace(/\s/g, '')));
    return { x, score: nearby.length * 10 + (han ? 1 : 0) };
  }).sort((a, b) => b.score - a.score)[0]?.x;
  const selected = Number.isFinite(bestX) ? valid.filter(item => Math.abs(item.bbox.x0 - bestX) <= tolerance || item.bbox.x0 < width * .18) : valid;
  const seen = new Set();
  return selected.sort((a, b) => a.bbox.y0 - b.bbox.y0).filter(item => {
    const key = item.text + '|' + Math.round(((item.bbox.y0 + item.bbox.y1) / 2) / 6);
    if (seen.has(key)) return false;
    seen.add(key);
    item.nameConfirmed = item.confidence >= 85;
    return true;
  }).slice(0, 30);
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || !width || !height) return reject(new Error('图片尺寸无效或浏览器不支持 Canvas'));
      context.drawImage(image, 0, 0, width, height); resolve({ canvas, width, height });
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败，请重新选择截图')); };
    image.src = url;
  });
}
function crop(source, x, y, width, height, output = 256) {
  const left = Math.max(0, x), top = Math.max(0, y), right = Math.min(source.width, x + width), bottom = Math.min(source.height, y + height);
  if (right <= left || bottom <= top) return null;
  const canvas = document.createElement('canvas'); canvas.width = output; canvas.height = Math.max(1, Math.round(output * (bottom - top) / (right - left)));
  const context = canvas.getContext('2d'); if (!context) return null;
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  context.drawImage(source.canvas, left, top, right - left, bottom - top, 0, 0, canvas.width, canvas.height);
  return canvas;
}
function usefulAvatar(canvas) {
  const context = canvas?.getContext('2d', { willReadFrequently: true }); if (!context) return false;
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0, sum2 = 0, count = 0;
  for (let index = 0; index < data.length; index += 16) {
    const value = .299 * data[index] + .587 * data[index + 1] + .114 * data[index + 2];
    sum += value; sum2 += value * value; count++;
  }
  const variance = sum2 / count - (sum / count) ** 2;
  return variance > 120;
}
function locateAvatar(source, box) {
  const textHeight = Math.max(8, box.y1 - box.y0);
  const size = Math.min(textHeight * 3.1, box.x0 - 8, source.height - 4);
  if (size < 24) return null;
  const centerX = box.x0 - size / 2 - 4;
  const centerY = Math.min(source.height - size / 2 - 1, Math.max(size / 2 + 1, (box.y0 + box.y1) / 2 + textHeight * .3));
  const avatar = crop(source, centerX - size / 2, centerY - size / 2, size, size);
  return avatar && usefulAvatar(avatar) ? { canvas: avatar, centerX, centerY, size } : null;
}
function nameImage(source, box) {
  const h = Math.max(8, box.y1 - box.y0);
  return crop(source, box.x0 - h * .2, box.y0 - h * .25, box.x1 - box.x0 + h * .4, h * 1.5, 240)?.toDataURL('image/png') || '';
}
function splitParts(source) {
  const maxHeight = 960, overlap = 120, parts = [];
  if (source.height <= maxHeight) return [{ canvas: source.canvas, y: 0 }];
  for (let y = 0; y < source.height; y += maxHeight - overlap) {
    const h = Math.min(maxHeight, source.height - y);
    const part = document.createElement('canvas'); part.width = source.width; part.height = h;
    part.getContext('2d').drawImage(source.canvas, 0, y, source.width, h, 0, 0, source.width, h);
    parts.push({ canvas: part, y }); if (y + h >= source.height) break;
  }
  return parts;
}
let pipelinePromise = null;
window.runLocalOCR = async function(file, onProgress = () => {}) {
  if (!file || !String(file.type || '').startsWith('image/')) throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  const { createOCR } = await import('/vendor/ocr/index.js');
  pipelinePromise ||= Promise.resolve(createOCR({
    model: { det: 'small', rec: 'small' }, backend: 'wasm', execution: 'main', allowFallback: false, wasmPaths: '/vendor/ort/',
    onProgress: event => {
      const percent = event?.progress === undefined ? '' : ' ' + Math.round(event.progress * 100) + '%';
      onProgress((event?.phase === 'download' ? '模型下载' : '正在' + (event?.phase || '识别') + '…') + percent);
    }
  })).then(async ocr => { onProgress('正在加载 PP-OCRv6 繁体中文模型…'); await ocr.load(); return ocr; }).catch(error => { pipelinePromise = null; throw new Error('OCR 模型加载失败：' + (error?.message || String(error))); });
  try {
    const source = await loadImage(file); const ocr = await pipelinePromise; const parts = splitParts(source); const all = [];
    for (let index = 0; index < parts.length; index++) {
      onProgress('正在识别截图 ' + (index + 1) + '/' + parts.length + '…');
      const result = await ocr.ocr(parts[index].canvas);
      all.push(...filterLines(result?.lines || [], source.width, source.height, parts[index].y));
    }
    const candidates = [];
    const seen = new Set();
    for (const item of all.sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
      const key = item.text + '|' + Math.round(((item.bbox.y0 + item.bbox.y1) / 2) / 8);
      if (!seen.has(key)) { seen.add(key); candidates.push(item); }
    }
    for (const item of candidates.slice(0, 3)) {
      if (item.confidence >= 85) continue;
      const h = Math.max(12, item.bbox.y1 - item.bbox.y0);
      const image = crop(source, item.bbox.x0 - h * .25, item.bbox.y0 - h * .6, item.bbox.x1 - item.bbox.x0 + h * .5, h * 2.2, 720);
      if (!image) continue;
      try {
        const retry = await ocr.ocr(image);
        const best = (retry?.lines || []).map(line => {
          const score = Number(line?.recognitionScore ?? line?.score ?? 0); return { text: clean(line?.text), confidence: score <= 1 ? score * 100 : score };
        }).filter(value => value.text && !CHAT.test(value.text)).sort((a, b) => b.confidence - a.confidence)[0];
        if (best && best.text && (best.confidence > item.confidence || Math.abs(best.text.length - item.text.length) <= 2)) {
          if (best.text !== item.text) item.reviewReason = '两次识别结果不一致（' + item.text + ' / ' + best.text + '），请对照原图确认';
          item.text = best.text; item.confidence = Math.max(item.confidence, best.confidence);
        }
      } catch {}
      item.nameConfirmed = item.confidence >= 85;
    }
    for (const item of candidates) {
      const avatar = locateAvatar(source, item.bbox);
      const avatarData = avatar?.canvas.toDataURL('image/png') || '';
      item.nameImage = nameImage(source, item.bbox); item.avatarData = avatarData; item.hasAvatar = !!avatarData;
      item.avatarReviewNeeded = !avatarData; item.nameConfirmed = item.confidence >= 85;
    }
    onProgress('识别完成');
    return candidates.map(item => ({
      id: crypto.randomUUID(), name: item.text, text: item.text, confidence: item.confidence, nameImage: item.nameImage,
      nameReviewReason: item.reviewReason || '', avatarData: item.avatarData, hasAvatar: item.hasAvatar,
      avatarReviewNeeded: item.avatarReviewNeeded, nameConfirmed: item.nameConfirmed, selected: true, bbox: item.bbox
    }));
  } catch (error) {
    pipelinePromise = null;
    throw new Error('OCR 识别失败：' + (error?.message || String(error)));
  }
};


