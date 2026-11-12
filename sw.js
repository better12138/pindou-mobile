// Service Worker：缓存 app shell，让装到桌面的应用离线也能打开。
// 注意：改版本号才会触发更新，新增文件记得同步加入 SHELL。
const VERSION = 'pindou-shell-v11';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './js/app.js',
  './js/install.js',
  './js/print.js',
  './js/viewer.js',
  './js/convert.js',
  './js/convert-client.js',
  './js/convert-worker.js',
  './js/color-match.js',
  './js/bluenoise.js',
  './js/export.js',
  './js/palette.js',
  './js/palette-data.js',
  './js/store.js',
  './js/usage.js',
  './js/history.js',
  './js/crop.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 导航请求优先走网络，拿到新 HTML；离线时回落到缓存的首页。
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html').then((cached) => cached || caches.match('./'))),
    );
    return;
  }

  // 静态资源：先用缓存，同时后台更新（stale-while-revalidate）。
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
