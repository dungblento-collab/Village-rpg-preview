/* Project Village RPG — Service Worker (PWA)
   QUY TẮC RÚT TỪ BÀI HỌC XƯƠNG MÁU (xem ~/AGENTS.md):
   - cache.addAll chỉ 1 file 404 là hỏng toàn bộ cài đặt → danh sách precache bên dưới
     đã được rà TỪNG URL trả 200 sau mỗi lần deploy; sửa danh sách này thì phải rà lại.
   - Sau MỌI lần sửa file này: chạy `node --check sw.js`.
   - Tăng CACHE_NAME mỗi đợt phát hành (village-rpg-v2, v3, ...) để bản cũ bị dọn sạch. */
'use strict';

var CACHE_NAME = 'village-rpg-v2';
var CDN_THREE = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.152.2/three.min.js';

// Nhóm LÕI: thiếu là game không chạy — cài một lượt.
var CORE_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/data.js',
  './js/core.js',
  './js/gltf-lite.js',
  './js/game.js',
  './js/pwa.js',
  './manifest.webmanifest'
];

// Nhóm PHỤ (ảnh + icon): nạp từng file độc lập, 1 file lỗi không giết cả bản.
var MEDIA_ASSETS = [
  './img/icon-192.png',
  './img/icon-512.webp',
  './img/icon-maskable-512.webp',
  './img/apple-touch-icon.png',
  './img/keyart.jpg',
  './img/panorama.jpg',
  './img/p-hero.jpg',
  './img/p-elder.jpg',
  './img/p-companion.jpg',
  './img/p-goblin.jpg',
  './img/p-boss1.jpg',
  './img/p-boss2.jpg'
];

// Nhóm MODEL 3D (Visual Pass): 23 file GLB — nạp từng file độc lập như nhóm ảnh,
// 1 file lỗi không giết cả bản cài đặt; game tự fallback hình hộp nếu thiếu model.
var MODEL_ASSETS = [
  './assets/models/player.glb',
  './assets/models/companion.glb',
  './assets/models/goblin.glb',
  './assets/models/goblin_archer.glb',
  './assets/models/boss_fog.glb',
  './assets/models/townhall.glb',
  './assets/models/house.glb',
  './assets/models/lumber.glb',
  './assets/models/farm.glb',
  './assets/models/warehouse.glb',
  './assets/models/barracks.glb',
  './assets/models/forge.glb',
  './assets/models/altar.glb',
  './assets/models/darkmine.glb',
  './assets/models/tree_01.glb',
  './assets/models/tree_02.glb',
  './assets/models/rock_01.glb',
  './assets/models/rock_02.glb',
  './assets/models/fence.glb',
  './assets/models/crate.glb',
  './assets/models/campfire.glb',
  './assets/models/bush.glb',
  './assets/models/path_stone.glb'
];

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var cache = await caches.open(CACHE_NAME);
    // Từng nhóm có try/catch riêng: lỗi nhóm nào ghi rõ nhóm đó, không nuốt lỗi lặng lẽ.
    try {
      await cache.addAll(CORE_ASSETS);
    } catch (err) {
      console.error('[SW] Precache LÕI thất bại:', err);
    }
    try {
      await Promise.allSettled(MEDIA_ASSETS.map(function (url) { return cache.add(url); }));
    } catch (err) {
      console.error('[SW] Precache PHỤ thất bại:', err);
    }
    try {
      await Promise.allSettled(MODEL_ASSETS.map(function (url) { return cache.add(url); }));
    } catch (err) {
      console.error('[SW] Precache MODEL thất bại:', err);
    }
    // Nạp sẵn thư viện Three.js từ CDN để lần mở offline đầu tiên đã có đủ.
    try {
      var cdnRes = await fetch(CDN_THREE, { mode: 'no-cors' });
      await cache.put(CDN_THREE, cdnRes);
    } catch (err) {
      console.error('[SW] Không nạp trước được three.min.js từ CDN:', err);
    }
    // KHÔNG tự skipWaiting ở đây: bản mới phải chờ người chơi bấm "Làm mới"
    // (xem listener 'message' bên dưới) để không reload giữa ván chơi.
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.map(function (key) {
      return key === CACHE_NAME ? Promise.resolve() : caches.delete(key);
    }));
    await self.clients.claim();
  })());
});

// Người chơi bấm "Làm mới" trong thông báo cập nhật → pwa.js gửi tin này → bản mới kích hoạt.
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // 1) Điều hướng / tài liệu HTML: NETWORK-FIRST — luôn ưu tiên bản mới nhất từ mạng,
  //    mạng lỗi mới rơi về cache (chống kẹt bản cũ).
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1) {
    event.respondWith((async function () {
      try {
        var fresh = await fetch(req);
        var cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (err) {
        var cached = await caches.match('./index.html', { ignoreSearch: true });
        return cached || caches.match('./', { ignoreSearch: true });
      }
    })());
    return;
  }

  // 2) Thư viện CDN (three.min.js): CACHE-FIRST — offline vẫn chơi được.
  if (url.origin !== self.location.origin) {
    event.respondWith((async function () {
      var hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        var res = await fetch(req, { mode: 'no-cors' });
        var cache = await caches.open(CACHE_NAME);
        cache.put(req, res.clone());
        return res;
      } catch (err) {
        return hit; // không có mạng + chưa có cache: để trình duyệt tự báo lỗi
      }
    })());
    return;
  }

  // 3) Tài nguyên tĩnh cùng origin: STALE-WHILE-REVALIDATE — trả cache ngay cho nhanh,
  //    đồng thời tải bản mới về nền cho lần mở sau.
  event.respondWith((async function () {
    var cache = await caches.open(CACHE_NAME);
    var hit = await cache.match(req, { ignoreSearch: true });
    var network = fetch(req).then(function (res) {
      if (res && (res.status === 200 || res.type === 'opaque')) {
        cache.put(req, res.clone());
      }
      return res;
    }).catch(function () { return null; });
    return hit || (await network) || Response.error();
  })());
});
