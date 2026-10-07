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
  if (!box || !compact || compact.length > 24 || box.x0 > width * .96 || box.x1 <= box.x0 || score < 10) return false;
  // Keep chat lines while we build rows.  The old implementation discarded
  // them too early, which meant a misread message (for example “今夭量能有
  // 增強”) could be promoted to the customer name.  nameLike() below makes
  // the final decision using the first line in each avatar row.
  if (NOISE.test(compact) || /https?:|www\./i.test(compact)) return false;
  const useful = (compact.match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
  return useful / Math.max(1, compact.length) >= .52 && /[\p{Script=Han}A-Za-z]/u.test(compact);
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
      if (row && gap >= 0 && gap <= Math.min(rh, ih) * .9 && row.text.length + item.text.length <= 24 && !/[，。！？!?；;：:]/u.test(row.text + item.text)) {
        row.text += /[A-Za-z]$/.test(row.text) && /^[A-Za-z]/.test(item.text) ? ' ' + item.text : item.text;
        row.confidence = Math.min(row.confidence, item.confidence);
        row.bbox.x1 = item.bbox.x1; row.bbox.y0 = Math.min(row.bbox.y0, item.bbox.y0); row.bbox.y1 = Math.max(row.bbox.y1, item.bbox.y1);
      } else { row = { ...item, bbox: { ...item.bbox } }; merged.push(row); }
    }
  }
  const valid = merged.filter(item => {
    const text = item.text.replace(/\s/g, '');
    return text.length >= 1 && !/^(VIP|NEW|官方帳號|官方账号)$/i.test(text) && candidate(text, item.bbox, width, item.confidence);
  });
  if (!valid.length) return [];
  const heights = valid.map(item => item.bbox.y1 - item.bbox.y0).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 16;
  const tolerance = Math.max(14, medianHeight * 1.45);

  // Name and message lines in WeChat are aligned to the same x coordinate.
  // Find that dominant column first so page headings or timestamps outside the
  // chat panel cannot become rows.
  const xClusters = [];
  for (const item of valid.filter(item => item.bbox.x0 >= width * .12)) {
    let cluster = xClusters.find(group => Math.abs(group.x - item.bbox.x0) <= tolerance);
    if (!cluster) { cluster = { x: item.bbox.x0, items: [] }; xClusters.push(cluster); }
    cluster.items.push(item); cluster.x = cluster.items.reduce((sum, value) => sum + value.bbox.x0, 0) / cluster.items.length;
  }
  const bestX = xClusters.sort((a, b) => {
    const rowsA = new Set(a.items.map(item => Math.round(item.bbox.y0 / Math.max(8, medianHeight))));
    const rowsB = new Set(b.items.map(item => Math.round(item.bbox.y0 / Math.max(8, medianHeight))));
    return (rowsB.size * 10 + b.items.length) - (rowsA.size * 10 + a.items.length);
  })[0]?.x;
  const column = Number.isFinite(bestX)
    ? valid.filter(item => Math.abs(item.bbox.x0 - bestX) <= tolerance * 1.8)
    : valid.filter(item => item.bbox.x0 >= width * .18);
  if (!column.length) return [];

  // Group neighbouring text lines into one chat row.  A customer name is the
  // top line of that row; the lower line is the message preview and must never
  // be emitted as a customer.
  const rows = [];
  for (const item of column.sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const h = item.bbox.y1 - item.bbox.y0;
    const center = (item.bbox.y0 + item.bbox.y1) / 2;
    const row = rows[rows.length - 1];
    const gap = row ? center - row.lastCenter : Infinity;
    const threshold = row ? Math.max(18, Math.max(row.height, h) * 2.8) : 0;
    if (row && gap <= threshold) {
      row.items.push(item); row.lastCenter = center; row.bottom = Math.max(row.bottom, item.bbox.y1); row.height = Math.max(row.height, h);
    } else rows.push({ items: [item], lastCenter: center, bottom: item.bbox.y1, height: h });
  }
  const nameLike = item => {
    const text = clean(item.text).replace(/\s/g, '');
    if (!text || text.length > 18 || NOISE.test(text) || CHAT.test(text)) return false;
    // Parenthesised labels such as “(珍珠)” are group headings in the source
    // chat list, not customer records (the legacy site intentionally skipped
    // them). Also reject implausibly long all-Chinese previews.
    if (/^[([{【（].*[)\]}】）]$/u.test(text) || (/^[\p{Script=Han}]+$/u.test(text) && text.length > 6)) return false;
    if (/[，。！？!?；;：:]/u.test(text) || /https?:|www\./i.test(text)) return false;
    if (/^(VIP|NEW|官方帳號|官方账号)$/i.test(text)) return false;
    const useful = (text.match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
    return useful / Math.max(1, text.length) >= .52 && /[\p{Script=Han}A-Za-z]/u.test(text);
  };
  const selected = [];
  for (const row of rows) {
    const sorted = row.items.slice().sort((a, b) => a.bbox.y0 - b.bbox.y0 || b.confidence - a.confidence);
    // Only inspect the first line. If OCR missed the name, skipping the row is
    // safer than importing the chat preview as a new customer.
    const first = sorted.find(item => item.bbox.x0 >= width * .12);
    if (!first || !nameLike(first)) continue;
    selected.push({ ...first, bbox: { ...first.bbox }, nameConfirmed: first.confidence >= 85 });
  }
  const seen = new Set();
  return selected.sort((a, b) => a.bbox.y0 - b.bbox.y0).filter(item => {
    const key = item.text + '|' + Math.round(((item.bbox.y0 + item.bbox.y1) / 2) / 6);
    if (seen.has(key)) return false;
    seen.add(key);
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
  const natural = output === null || output === undefined;
  const canvas = document.createElement('canvas');
  canvas.width = natural ? Math.max(1, Math.round(right - left)) : output;
  canvas.height = natural ? Math.max(1, Math.round(bottom - top)) : Math.max(1, Math.round(output * (bottom - top) / (right - left)));
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
/*
 * Locate the thumbnail from its circular boundary rather than from image
 * texture.  A texture-only search tends to select a person's face, sky, or a
 * message preview inside the avatar.  The old site used this boundary test;
 * keeping it here also means a low-contrast portrait is still cropped at the
 * correct position.
 */
function avatarBoundaryScore(image, centerX, centerY, size) {
  const { data, width, height } = image;
  if (size < 12 || centerX - size / 2 < 1 || centerY - size / 2 < 1 ||
      centerX + size / 2 >= width - 1 || centerY + size / 2 >= height - 1) return -Infinity;
  const pixel = (x, y) => {
    const px = Math.max(0, Math.min(width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(height - 1, Math.round(y)));
    const index = (py * width + px) * 4;
    return [data[index], data[index + 1], data[index + 2]];
  };
  const difference = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const innerOuterDiff = [], outerPixels = [];
  for (let index = 0; index < 24; index++) {
    const angle = index * Math.PI * 2 / 24;
    const inner = pixel(centerX + Math.cos(angle) * size * .41, centerY + Math.sin(angle) * size * .41);
    const outerRadius = size * .54 / Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)));
    const outer = pixel(centerX + Math.cos(angle) * outerRadius, centerY + Math.sin(angle) * outerRadius);
    outerPixels.push(outer);
    innerOuterDiff.push(difference(inner, outer) / 3);
  }
  // A small texture check prevents a plain background square from being
  // mistaken for an avatar while not deciding where the avatar is located.
  let texture = 0, textureSamples = 0, textureStep = size * .14;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 1; x++) {
    if (x * x + y * y > 5) continue;
    texture += difference(pixel(centerX + x * textureStep, centerY + y * textureStep),
      pixel(centerX + (x + 1) * textureStep, centerY + y * textureStep)) / 3;
    textureSamples++;
  }
  const mean = innerOuterDiff.reduce((sum, value) => sum + value, 0) / innerOuterDiff.length;
  const variance = innerOuterDiff.reduce((sum, value) => sum + (value - mean) ** 2, 0) / innerOuterDiff.length;
  const edgeFraction = innerOuterDiff.filter(value => value >= 13).length / innerOuterDiff.length;
  const medianOuter = [0, 1, 2].map(channel => outerPixels.map(value => value[channel]).sort((a, b) => a - b)[12]);
  const outerVariance = outerPixels.reduce((sum, value) => sum + difference(value, medianOuter) / 3, 0) / outerPixels.length;
  if (outerPixels.filter(value => difference(value, medianOuter) / 3 <= 12).length < 20) return -Infinity;
  for (const vertical of [-.24, .24]) {
    if (![-.22, 0, .22].some(horizontal => difference(pixel(centerX + size * horizontal, centerY + size * vertical), medianOuter) / 3 >= 15)) return -Infinity;
  }
  return mean * 1.25 - Math.sqrt(variance) * .2 + edgeFraction * 35 - outerVariance * 1.8 + texture / Math.max(1, textureSamples) * .08;
}

function locateAvatar(source, box, rowGap = 0) {
  const textHeight = Math.max(6, box.y1 - box.y0);
  const rightLimit = box.x0 - Math.max(2, textHeight * .15);
  const maxSize = Math.min(textHeight * 5.1, rightLimit - 2, source.height - 2);
  if (maxSize < 16 || !source?.canvas) return null;

  // Read one downscaled image for the search.  The selected coordinates remain
  // in source pixels so the returned crop keeps its natural square resolution.
  const scale = Math.min(1, 1600 / Math.max(source.width, source.height));
  const probe = document.createElement('canvas');
  probe.width = Math.max(1, Math.round(source.width * scale));
  probe.height = Math.max(1, Math.round(source.height * scale));
  const probeContext = probe.getContext('2d', { willReadFrequently: true });
  if (!probeContext) return null;
  probeContext.drawImage(source.canvas, 0, 0, probe.width, probe.height);
  const probeImage = { data: probeContext.getImageData(0, 0, probe.width, probe.height).data, width: probe.width, height: probe.height };
  const scoreAt = (centerX, centerY, size) => {
    const top = centerY - size / 2;
    if (centerX - size / 2 < 0 || centerX + size / 2 > rightLimit || top < 0 || centerY + size / 2 > source.height ||
        top > box.y0 + textHeight * .45 || centerY + size / 2 < box.y1 - textHeight * .2) return -Infinity;
    return avatarBoundaryScore(probeImage, centerX * scale, centerY * scale, size * scale);
  };

  const initial = Math.max(16, Math.min(textHeight * 3, maxSize));
  let best = { centerX: Math.max(initial / 2, rightLimit - initial * .65), centerY: (box.y0 + box.y1) / 2 + textHeight, size: initial, score: -Infinity };
  const sizes = [1.6, 2, 2.4, 2.8, 3.2, 3.6, 4, 4.4, 4.8, 5.1].map(multiplier => Math.min(maxSize, textHeight * multiplier));
  for (const size of [...new Set(sizes)]) {
    if (size < 16) continue;
    const step = Math.max(1 / scale, size * .08);
    const minX = Math.max(size / 2 + 1, rightLimit - size * 1.8);
    const maxX = rightLimit - size / 2;
    const minY = Math.max(size / 2 + 1, (box.y0 + box.y1) / 2 - textHeight * .16);
    const maxY = Math.min(source.height - size / 2 - 1, (box.y0 + box.y1) / 2 + textHeight * .65);
    for (let centerX = minX; centerX <= maxX; centerX += step) for (let centerY = minY; centerY <= maxY; centerY += step) {
      const score = scoreAt(centerX, centerY, size);
      if (score > best.score) best = { centerX, centerY, size, score };
    }
  }
  const rough = best;
  for (const sizeScale of [.94, 1, 1.06]) for (const xOffset of [-.04, 0, .04]) for (const yOffset of [-.04, 0, .04]) {
    const size = rough.size * sizeScale;
    const centerX = rough.centerX + rough.size * xOffset;
    const centerY = rough.centerY + rough.size * yOffset;
    const score = scoreAt(centerX, centerY, size);
    if (score > best.score) best = { centerX, centerY, size, score };
  }
  if (best.score < 38) return null;
  const canvas = crop(source, best.centerX - best.size / 2, best.centerY - best.size / 2, best.size, best.size, null);
  return canvas ? { ...best, canvas, reliable: true } : null;
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
    for (let index = 0; index < candidates.length; index++) {
      const item = candidates[index];
      const height = Math.max(8, item.bbox.y1 - item.bbox.y0);
      const gaps = [
        candidates[index + 1] ? candidates[index + 1].bbox.y0 - item.bbox.y0 : 0,
        candidates[index - 1] ? item.bbox.y0 - candidates[index - 1].bbox.y0 : 0
      ].filter(gap => gap >= height * 2.1 && gap <= 260);
      const rowGap = gaps.length ? Math.min(...gaps) : 0;
      const avatar = locateAvatar(source, item.bbox, rowGap);
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


