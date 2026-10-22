/* Project Village RPG — PWA: đăng ký Service Worker, nút "⬇ Cài app", thông báo cập nhật.
   File RIÊNG để không đụng vào logic trong js/game.js.
   - Android/Chrome: dùng sự kiện beforeinstallprompt → nút "⬇ Cài app" trên màn hình bắt đầu.
   - iOS Safari: không có sự kiện trên → hiện dòng hướng dẫn Chia sẻ → Thêm vào Màn hình chính.
   - Cập nhật: SW mới ở trạng thái chờ → hiện thanh thông báo có nút "Làm mới";
     chỉ khi người chơi bấm mới gửi SKIP_WAITING và reload 1 lần (không reload giữa ván). */
(function () {
  'use strict';

  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) { /* môi trường không có matchMedia (vd harness) */ }
    return window.navigator.standalone === true; // iOS Safari
  }

  function isIOS() {
    var ua = window.navigator.userAgent || '';
    return /iphone|ipad|ipod/i.test(ua) ||
      (ua.indexOf('Macintosh') !== -1 && 'ontouchend' in document); // iPadOS giả dạng Mac
  }

  /* ---------- Nút Cài app + gợi ý iOS (chỉ trên màn hình bắt đầu) ---------- */
  var deferredPrompt = null;
  var installBtn = null;
  var iosHint = null;

  function buildInstallUI() {
    var startScreen = document.getElementById('start-screen');
    var anchor = document.getElementById('btn-start');
    if (!startScreen || !anchor || document.getElementById('btn-install')) return;

    installBtn = document.createElement('button');
    installBtn.id = 'btn-install';
    installBtn.textContent = '⬇ Cài app vào máy';
    installBtn.style.display = 'none';
    installBtn.addEventListener('click', function () {
      if (!deferredPrompt) return;
      var promptEvent = deferredPrompt;
      deferredPrompt = null;
      installBtn.style.display = 'none';
      promptEvent.prompt();
      if (promptEvent.userChoice && promptEvent.userChoice.then) {
        promptEvent.userChoice.then(function () { /* người chơi chọn hay hủy đều ẩn nút */ });
      }
    });
    anchor.parentNode.insertBefore(installBtn, anchor.nextSibling);

    iosHint = document.createElement('p');
    iosHint.id = 'ios-install-hint';
    iosHint.style.display = 'none';
    iosHint.textContent = '📲 Cài app: bấm nút Chia sẻ ⬆️ ở thanh Safari → chọn "Thêm vào Màn hình chính".';
    installBtn.parentNode.insertBefore(iosHint, installBtn.nextSibling);
  }

  function refreshInstallUI() {
    if (isStandalone()) {
      if (installBtn) installBtn.style.display = 'none';
      if (iosHint) iosHint.style.display = 'none';
      return;
    }
    if (deferredPrompt && installBtn) {
      installBtn.style.display = '';
      if (iosHint) iosHint.style.display = 'none';
    } else if (isIOS() && iosHint) {
      iosHint.style.display = '';
    }
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    refreshInstallUI();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    if (installBtn) installBtn.style.display = 'none';
    if (iosHint) iosHint.style.display = 'none';
  });

  /* ---------- Thanh thông báo có bản mới ---------- */
  var updateBar = null;
  var pendingWorker = null;

  function showUpdateBar(worker) {
    pendingWorker = worker || pendingWorker;
    if (!updateBar) {
      updateBar = document.createElement('div');
      updateBar.id = 'pwa-update-bar';
      var text = document.createElement('span');
      text.textContent = '✨ Đã có bản Village RPG mới!';
      var btn = document.createElement('button');
      btn.id = 'pwa-update-btn';
      btn.textContent = 'Làm mới';
      btn.addEventListener('click', function () {
        if (pendingWorker) pendingWorker.postMessage({ type: 'SKIP_WAITING' });
      });
      updateBar.appendChild(text);
      updateBar.appendChild(btn);
      document.body.appendChild(updateBar);
    }
    updateBar.style.display = 'flex';
  }

  /* ---------- Đăng ký Service Worker ---------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;

    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('sw.js').then(function (reg) {
      // Đã có bản mới đang chờ từ lần mở trước + trang đang do SW cũ điều khiển → báo ngay.
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateBar(reg.waiting);
      }
      reg.addEventListener('updatefound', function () {
        var newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', function () {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBar(newWorker);
          }
        });
      });
    }).catch(function (err) {
      console.error('[PWA] Đăng ký service worker thất bại:', err);
    });
  }

  function init() {
    buildInstallUI();
    refreshInstallUI();
    registerSW();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
