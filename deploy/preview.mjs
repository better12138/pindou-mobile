// 本地预览：把两端按生产路径拼在同一个源上（/ = PC 端，/m/ = 移动端，/pricing.json 共用）。
// 用途：验证同源共享 localStorage、跨端跳转、兑换码只计一次。
// 运行：node deploy/preview.mjs [port]
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const mobileRoot = resolve(here, '..');
const pcRoot = resolve(mobileRoot, '..', '拼豆项目20261109', 'generated', 'dist');
const port = Number(process.argv[2] || 8099);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.binarypb': 'application/octet-stream',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = normalize(join(root, decoded));
  return target === root || target.startsWith(root + sep) ? target : null;
}

function sendFile(response, filePath) {
  const type = mime[extname(filePath).toLowerCase()] || 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer((request, response) => {
  const url = request.url || '/';

  if (url === '/pricing.json') {
    return sendFile(response, join(mobileRoot, 'pricing.json'));
  }

  if (url === '/m' || url.startsWith('/m/')) {
    const relative = url.slice(2).split('?')[0] || '/';
    const target = relative === '/' ? join(mobileRoot, 'index.html') : safeJoin(mobileRoot, relative);
    if (target && existsSync(target) && statSync(target).isFile()) return sendFile(response, target);
    return sendFile(response, join(mobileRoot, 'index.html'));
  }

  if (url.startsWith('/api/')) {
    response.writeHead(501, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'preview 不提供接口' }));
    return;
  }

  const target = url === '/' ? join(pcRoot, 'index.html') : safeJoin(pcRoot, url);
  if (target && existsSync(target) && statSync(target).isFile()) return sendFile(response, target);
  // PC 端是 hash 路由，未知路径回落到落地页
  return sendFile(response, join(pcRoot, 'index.html'));
});

server.listen(port, () => {
  console.log(`预览已启动：`);
  console.log(`  PC 端   http://localhost:${port}/`);
  console.log(`  移动端  http://localhost:${port}/m/`);
  console.log(`  价目    http://localhost:${port}/pricing.json`);
});
