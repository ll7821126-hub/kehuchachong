import { cp, mkdir } from 'node:fs/promises';
await mkdir('public/vendor', { recursive: true });
await cp('node_modules/web-sdk-pp-ocrv6/dist', 'public/vendor/ocr', { recursive: true });
await cp('node_modules/onnxruntime-web/dist', 'public/vendor/ort', { recursive: true });
console.log('PP-OCRv6 SDK, worker and matching ONNX runtime prepared.');

