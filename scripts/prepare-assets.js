import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('public/vendor', { recursive: true });
await cp('node_modules/web-sdk-pp-ocrv6/dist', 'public/vendor/ocr', { recursive: true });
await cp('node_modules/onnxruntime-web/dist', 'public/vendor/ort', { recursive: true });
const sdk = 'public/vendor/ocr/index.js';
const source = await readFile(sdk, 'utf8');
await writeFile(sdk, source.replaceAll('from "onnxruntime-web"', 'from "../ort/ort.all.bundle.min.mjs"'));
console.log('PP-OCRv6 SDK, worker and matching ONNX runtime prepared.');

