window.runLocalOCR = async function(file, onProgress = () => {}) {
  onProgress('正在加载 PP-OCRv6 繁体中文模型…');
  const { createOCR } = await import('https://esm.sh/web-sdk-pp-ocrv6@0.2.0');
  const ocr = createOCR({ model: { det: 'small', rec: 'small' }, backend: 'auto', execution: 'worker', allowFallback: true, onProgress: event => onProgress(event.phase === 'download' ? `模型下载 ${Math.round((event.progress || 0) * 100)}%` : `正在${event.phase || '识别'}…`) });
  try { await ocr.load(); const result = await ocr.ocr(file); return result.lines || []; } finally { await ocr.dispose(); }
};

