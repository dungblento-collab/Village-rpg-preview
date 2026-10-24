/* game.js — Project Village RPG (Three.js): gameplay/3D tại đây; toán tài nguyên/trang bị/kỹ năng ở core.js; định nghĩa ở data.js. */
(function () {
  'use strict';
  var D = window.VRPG_DATA, C = window.VRPG;
  if (!window.THREE) {
    document.getElementById('fatal').classList.remove('hidden');
    document.getElementById('fatal').textContent = 'Không tải được thư viện Three.js từ CDN. Hãy kiểm tra kết nối mạng rồi tải lại trang.';
    document.getElementById('start-screen').style.display = 'none';
    return;
  }

  /* ============ Bẫy lỗi toàn cục (đăng ký SỚM) ============
     Lỗi init trước khi vào game phải HIỆN lên #fatal thay vì chết lặng khiến nút Vào game không phản hồi.
     Sau khi đã vào game (started) thì bỏ qua để một lỗi nhỏ không phá phiên chơi. */
  function showFatal(msg) {
    var f = document.getElementById('fatal');
    if (!f) return;
    f.classList.remove('hidden');
    f.textContent = msg;
  }
  window.addEventListener('error', function (e) {
    if (started) return;
    showFatal('⚠️ Game gặp lỗi khi khởi tạo: ' + (e.message || 'lỗi không rõ') + ' — Hãy tải lại trang; nếu vẫn lỗi, thử trình duyệt khác hoặc bật tăng tốc phần cứng trong cài đặt trình duyệt.');
  });

  /* ================= SaveSystem ================= */
  var SaveSystem = {
    load: function () {
      try {
        var raw = localStorage.getItem(C.SAVE_KEY);
        if (raw) return C.deserialize(raw);
      } catch (e) { console.warn('Save hỏng, tạo mới:', e); }
      return C.defaultState();
    },
    save: function () {
      try {
        state.player.x = Math.round(player.group.position.x * 10) / 10;
        state.player.z = Math.round(player.group.position.z * 10) / 10;
        localStorage.setItem(C.SAVE_KEY, C.serialize(state));
      } catch (e) { console.warn('Không lưu được:', e); }
    },
    wipe: function () { localStorage.removeItem(C.SAVE_KEY); }
  };

  var state = SaveSystem.load();
  var hadSave = !!localStorage.getItem(C.SAVE_KEY);

  /* ================= Settings (đợt mở rộng): key RIÊNG, không lẫn save =================
     Lần đầu (chưa có settings): di trú lựa chọn cũ từ flags trong save (fxShake/fxFlash/
     fxParticles/aimbotOn) để người chơi cũ không mất tùy chỉnh. áp dụng thật ở applySettings(). */
  var settings = C.loadSettings(localStorage);
  if (!localStorage.getItem(C.SETTINGS_KEY)) {
    settings.shake = state.flags.fxShake !== false;
    settings.flash = state.flags.fxFlash !== false;
    settings.envFx = state.flags.fxParticles !== false;
    settings.particles = state.flags.fxParticles !== false;
    settings.aimbot = !!state.flags.aimbotOn;
    C.saveSettings(localStorage, settings);
  }
  function persistSettings() { C.saveSettings(localStorage, settings); }

  /* ================= Trạng thái phiên chơi (không lưu) ================= */
  var player = { hp: 0, energy: 0, group: null, yaw: 0, lastCombatAt: -99, cooldowns: {}, dead: false };
  var enemies = [], companions = [], projectiles = [], enemyProjectiles = [], telegraphs = [];
  var trees = [], rocks = [], bushes = [], buildingMeshes = [];
  var markedTarget = null, started = false, gameTime = 0;

/* Aimbot (🎯/V, flags.aimbotOn, mặc định TẮT): khóa quái gần nhất (ưu tiên T), đạn đón đầu + dẫn hướng nhẹ, cận chiến lướt vào tầm; không tự ra đòn. */
  var AIM_RANGE = 32;          // tầm khóa mục tiêu của aimbot
  var AIM_SCAN_EVERY = 0.25;   // chu kỳ quét mục tiêu + đo vận tốc quái (giây) — không quét mỗi frame
  var HOMING_TURN = 2.2;       // tốc độ lái cong tối đa của đạn dẫn hướng (rad/giây)
  var aimTarget = null;        // mục tiêu aimbot đang khóa (khi chết/quá tầm sẽ tự nhả ở lần quét sau)
  var aimScanT = 0, aimLastScanAt = -1;
  var aimRing = null;          // 1 mesh vòng ngắm duy nhất, tái dùng cho mọi mục tiêu
  function aimbotOn() { return !!state.flags.aimbotOn; }
  function aimDistTo(e) { return dist2d(player.group.position.x, player.group.position.z, e.group.position.x, e.group.position.z); }
  function ensureAimRing() {
    if (aimRing) return;
    aimRing = new THREE.Mesh(
      new THREE.RingGeometry(1.02, 1.28, 36),
      new THREE.MeshBasicMaterial({ color: 0xff5252, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
    );
    aimRing.rotation.x = -Math.PI / 2;
    aimRing.position.y = 0.15;
    aimRing.visible = false;
    scene.add(aimRing);
  }
  function updateAimbot(dt) {
    if (!aimbotOn()) { aimTarget = null; if (aimRing) aimRing.visible = false; return; }
    aimScanT -= dt;
    if (aimScanT <= 0) {
      aimScanT = AIM_SCAN_EVERY;
      var scanDt = (aimLastScanAt >= 0) ? (gameTime - aimLastScanAt) : 0;
      if (!(scanDt > 0.01) || scanDt > 1) scanDt = AIM_SCAN_EVERY;
      aimLastScanAt = gameTime;
      // Đo vận tốc quái từ độ dời vị trí giữa 2 lần quét (lưu _aimPx/_aimPz trên object quái).
      // Vị trí quét trước lưu NGAY trên object quái (_aimPx/_aimPz) — không dựa vào id của engine.
      enemies.forEach(function (e) {
        var p = e.group.position;
        if (e._aimPx !== undefined && e.alive) { e._vx = (p.x - e._aimPx) / scanDt; e._vz = (p.z - e._aimPz) / scanDt; }
        else { e._vx = 0; e._vz = 0; }
        e._aimPx = p.x; e._aimPz = p.z;
      });
      // Ưu tiên markedTarget (T) còn sống & trong tầm; không thì quái gần nhất trong tầm.
      var cand = null;
      if (markedTarget && markedTarget.alive && aimDistTo(markedTarget) <= AIM_RANGE) cand = markedTarget;
      if (!cand) {
        var bd = AIM_RANGE;
        enemies.forEach(function (e) {
          if (!e.alive) return;
          var d = aimDistTo(e);
          if (d <= bd) { bd = d; cand = e; }
        });
      }
      aimTarget = cand;
    }
    if (aimTarget && !aimTarget.alive) aimTarget = null;
    // Vòng ngắm bám chân mục tiêu (nhịp phóng nhẹ cho dễ thấy)
    if (aimTarget) {
      ensureAimRing();
      aimRing.visible = true;
      aimRing.position.x = aimTarget.group.position.x;
      aimRing.position.z = aimTarget.group.position.z;
      var pulse = (aimTarget.def.scale || 1) * (1 + 0.07 * Math.sin(gameTime * 6));
      aimRing.scale.set(pulse, pulse, 1);
      aimRing.rotation.z += dt * 1.2;
    } else if (aimRing) aimRing.visible = false;
  }
  // Điểm ngắm đón đầu cho mục tiêu hiện tại (toán ở core.aimPoint)
  function aimSolution(projSpeed) {
    if (!aimbotOn() || !aimTarget || !aimTarget.alive) return null;
    var p = player.group.position, tp = aimTarget.group.position;
    var pt = C.aimPoint({ x: p.x, z: p.z }, { x: tp.x, z: tp.z },
      { x: aimTarget._vx || 0, z: aimTarget._vz || 0 }, projSpeed);
    return { target: aimTarget, point: pt };
  }
  function faceAimPoint(point) {
    var p = player.group.position;
    var d = C.aimDir({ x: p.x, z: p.z }, point);
    if (d.dx !== 0 || d.dz !== 0) { player.yaw = Math.atan2(d.dx, d.dz); player.group.rotation.y = player.yaw; }
  }
  // Cận chiến: ngoài tầm đánh nhưng trong tầm nới (+2.2) -> lướt thẳng tới mép tầm rồi ra đòn.
  // Đi thẳng + collide() như di chuyển thường: gặp vật cản thì bị đẩy ra, KHÔNG xuyên tường.
  function aimMeleeStep(hitRange) {
    if (!aimbotOn() || !aimTarget || !aimTarget.alive) return;
    var p = player.group.position, tp = aimTarget.group.position;
    var d = dist2d(p.x, p.z, tp.x, tp.z);
    if (d > hitRange && d <= hitRange + 2.2) {
      var step = d - (hitRange - 0.2);
      p.x += (tp.x - p.x) / d * step;
      p.z += (tp.z - p.z) / d * step;
      collide(p, 0.55);
    }
  }
  function paintAimBtn() { var b = $('btn-aim'); if (b) b.classList.toggle('aim-on', aimbotOn()); }
  function setAimbot(on) {
    state.flags.aimbotOn = !!on;
    settings.aimbot = !!on; persistSettings(); // đồng bộ 2 chiều với panel Cài đặt
    if (!on) aimTarget = null;
    paintAimBtn();
    SaveSystem.save();
    toast(on ? '🎯 Aimbot: BẬT — tự khóa quái gần nhất, đạn đón đầu + dẫn hướng nhẹ.' : '🎯 Aimbot: TẮT');
  }
  var keys = {}, camYaw = 0.6, camPitch = 0.42, camDist = settings.camDistDefault; // khoảng cách vào game lấy từ Cài đặt (18/28/40); trong ván vẫn zoom tự do 5–40
  // Biên zoom dùng chung cho lăn chuột + pinch cảm ứng (tối đa 40 theo yêu cầu của Bui)
  var CAM_DIST_MIN = 5, CAM_DIST_MAX = 40;
  function clampCamDist(d) { return Math.max(CAM_DIST_MIN, Math.min(CAM_DIST_MAX, d)); }
  var buildMode = { active: false, type: null, rot: 0, ghost: null, valid: false, x: 0, z: 0 };
  var prodTimers = {}; // building index -> accumulated seconds
  /* ---- Game Feel (Mục 1): hit-stop / trauma shake / flash / particle pool ---- */
  var hitStopT = 0;                 // giây (thời gian THẬT) còn đóng băng logic
  var trauma = 0, shakeTime = 0;    // trauma 0..1, shake = trauma^2 (theo game_feel skill)
  var flashList = [];               // {mats:[{m,e}], t} đang chớp trắng
  var healFloatAcc = 0, lastHealFloat = -9; // gộp số nổi hồi máu, tối đa 1 dòng / 0.35s
  var camFocus = null;              // điểm nhìn đã làm mượt (deadzone mềm + look-ahead)
  var playerLookAhead = { x: 0, z: 0 };
  var occlDist = 99, frameNo = 0;   // khoảng cách camera sau occlusion giản lược
  var savedCam = null;              // góc camera trước khi vào build mode
  /* ---- Event làng (Mục 5): RUNTIME ONLY, không lưu save ---- */
  var activeEvent = null, eventClock = 0, nextEventAt = 150, beastsAlive = 0;
  function fxOn(flag) { // đợt mở rộng: nguồn sự thật là Settings (key riêng); flags cũ chỉ còn là di trú lần đầu
    if (flag === 'fxShake') return settings.shake;
    if (flag === 'fxFlash') return settings.flash;
    if (flag === 'fxParticles') return settings.envFx; // sao + đom đóm = nhóm "Hiệu ứng môi trường"
    return state.flags[flag] !== false;
  }
  function addTrauma(x) { if (fxOn('fxShake')) trauma = Math.min(1, trauma + x); }
  function hitStop(sec) { if (settings.hitStop) hitStopT = Math.max(hitStopT, sec); } // toggle Hit-stop trong Cài đặt

  /* $ helper — PHẢI định nghĩa SỚM ở đây: các hàm chạy ngay lúc init (vd log() do spawnBoss()
     gọi ở phần EnemyAI) đã dùng $; trước đây $ chỉ được gán ở cuối file (mục UIController)
     nên init chết với "TypeError: $ is not a function" trước khi kịp gắn nút Vào game. */
  var $ = function (id) { return document.getElementById(id); };

  /* Gắn nút Vào game SỚM (trước toàn bộ khởi tạo 3D bên dưới): dù init 3D lỗi về sau,
     nút vẫn có handler và bẫy lỗi toàn cục sẽ hiện nguyên nhân lên #fatal.
     toast/updateHUD là function declaration (đã hoisted) nên gọi an toàn. */
  $('btn-guide').onclick = function () { $('guide-box').classList.toggle('hidden'); };
  $('btn-start').onclick = function () {
    $('start-screen').style.display = 'none';
    started = true;
    if (state.flags.bossKilled === undefined) state.flags.bossKilled = false;
    toast('🌿 Chào mừng đến làng! Làm theo nhiệm vụ ở góc phải. WASD để đi, E để chặt cây.');
    showTut('move');
    updateHUD();
    tryMobileLandscape();
  };

/* Điện thoại: thử khóa màn hình ngang (cần fullscreen, iOS Safari không hỗ trợ — bọc try/catch; không khóa được thì hiện #rotate-hint). */
  var rotateHintDismissed = false;
  function isTouchSmallScreen() {
    try { return ('ontouchstart' in window) && Math.min(screen.width || 9999, screen.height || 9999) <= 520; }
    catch (e) { return false; }
  }
  function refreshRotateHint() {
    var hint = $('rotate-hint');
    if (!hint) return;
    var show = started && !rotateHintDismissed && isTouchSmallScreen() && innerHeight > innerWidth;
    hint.classList.toggle('hidden', !show);
  }
  function tryMobileLandscape() {
    if (!isTouchSmallScreen()) { refreshRotateHint(); return; }
    try {
      var el = document.documentElement;
      if (el.requestFullscreen) {
        var fp = el.requestFullscreen();
        if (fp && typeof fp.catch === 'function') fp.catch(function () {});
      }
      if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.lock === 'function') {
        var lp = screen.orientation.lock('landscape');
        if (lp && typeof lp.catch === 'function') lp.catch(function () {});
      }
    } catch (e) { /* iOS Safari / trình duyệt không hỗ trợ: bỏ qua, lớp gợi ý sẽ lo phần còn lại */ }
    refreshRotateHint();
  }
  addEventListener('resize', refreshRotateHint);
  addEventListener('orientationchange', refreshRotateHint);
  var rotateDismissBtn = $('rotate-dismiss');
  if (rotateDismissBtn) rotateDismissBtn.onclick = function () { rotateHintDismissed = true; refreshRotateHint(); };

  /* ================= Three.js cơ bản ================= */
  var container = document.getElementById('game-container');
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5d6);
  scene.fog = new THREE.Fog(0x87b5d6, 55, 140); // far 140 (trước 110): ở zoom tối đa 40, điểm giữa map cách camera >110 sẽ bị sương phủ kín
  var camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 300);
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (e) {
    showFatal('⚠️ Trình duyệt không tạo được WebGL nên game 3D không thể khởi động. Hãy thử trình duyệt khác (Chrome/Edge/Safari bản mới) hoặc bật tăng tốc phần cứng (Hardware Acceleration) trong cài đặt trình duyệt, rồi tải lại trang.');
    return;
  }
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, settings.quality === 'low' ? 1 : (settings.quality === 'med' ? 1.5 : 2))); // trần pixelRatio theo Chất lượng trong Cài đặt
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  var sun = new THREE.DirectionalLight(0xfff2d9, 1.05);
  sun.position.set(30, 45, 20);
  sun.castShadow = true;
  sun.shadow.camera.left = -45; sun.shadow.camera.right = 45;
  sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45;
  // Visual Pass: shadow map 2048 trên desktop; thiết bị cảm ứng/mobile hạ còn 1024 cho nhẹ GPU.
  var IS_TOUCH_DEV = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
  sun.shadow.mapSize.set(IS_TOUCH_DEV ? 1024 : 2048, IS_TOUCH_DEV ? 1024 : 2048);
  scene.add(sun);
  var ambLight = new THREE.AmbientLight(0xbfd9ea, 0.55);
  scene.add(ambLight);
  var hemiLight = new THREE.HemisphereLight(0xcfe8ff, 0x3d6b35, 0.35);
  scene.add(hemiLight);
  // Đèn mặt trăng (chu kỳ ngày–đêm): DirectionalLight phụ KHÔNG đổ bóng nên rất rẻ;
  // cường độ 0 vào ban ngày, chỉ bật lên khi đêm xuống (xem updateDayNight).
  var moonLight = new THREE.DirectionalLight(0x8fb4ff, 0);
  moonLight.position.set(-40, 60, -30);
  scene.add(moonLight);

  /* Lớp ảnh AI — panorama: vòng trụ ảnh 2D bao quanh thế giới làm nền trời/núi xa.
     Là nền tĩnh trang trí: không va chạm, không tương tác, tắt fog để không bị sương làm trắng. */
  try {
    var panoTex = new THREE.TextureLoader().load('img/panorama.jpg');
    panoTex.wrapS = THREE.RepeatWrapping;
    panoTex.repeat.x = 3;
    var panoMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(135, 135, 55, 48, 1, true),
      new THREE.MeshBasicMaterial({ map: panoTex, side: THREE.BackSide, fog: false })
    );
    panoMesh.position.y = 18;
    panoMesh.renderOrder = -10;
    scene.add(panoMesh);
  } catch (e) { console.warn('Không tạo được panorama:', e); }

  function box(w, h, d, color, x, y, z) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: color }));
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  /* ================= Visual Pass: model GLB (js/gltf-lite.js) =================
     Game vẫn khởi động ngay bằng hình hộp cũ; model GLB nạp BẤT ĐỒNG BỘ theo từng loại,
     tải xong mới hoán đổi vào group (applyModelSwap). Lỗi tải 1 loại -> giữ hình hộp của
     loại đó + console.warn, game không dừng. Mỗi loại chỉ fetch 1 lần thành template;
     instance sau dùng .clone(true) — DÙNG CHUNG geometry; material chỉ clone riêng cho
     nhân vật (flash trúng đòn không lan sang cá thể khác) và khi tint (đá Hắc Kim).
     Scale = hệ số đưa model gốc về đúng kích thước gameplay đang dùng: nhân vật cao 2.19
     như humanoid hộp; địch cao 1.6 x def.scale như cầu hộp cũ; công trình theo chiều
     cao/footprint của hình hộp cũ. Collision, tầm đánh, vị trí HP bar KHÔNG đổi. */
  var MODEL_DEFS = {
    player:    { scale: 1.25, char: true, hide: ['scabbard', 'scabbard_tip', 'guard', 'hilt', 'pommel'] }, // cao 1.75 -> 2.19; ẩn kiếm trang trí ở hông (đã có swordMesh vung thật, tránh 2 kiếm)
    companion: { scale: 1.33, char: true },   // 1.65 -> 2.19
    goblin:        { scale: 1.6 / 1.10, char: true },  // nhân thêm def.scale khi gắn (xem spawnEnemy)
    goblin_archer: { scale: 1.6 / 1.15, char: true },
    boss_fog:      { scale: 1.6 / 3.90, char: true },  // Boss 2: def.scale 2.6 -> hệ số thực 1.067, cao 4.16 như cầu hộp cũ
    townhall:  { scale: 0.85 },  // thân rộng 8.0 x 0.85 = 6.8 = đúng đường kính va chạm cố định 2 x 3.4
    house:     { scale: 0.95 }, lumber: { scale: 0.75 }, farm: { scale: 0.69 },
    warehouse: { scale: 0.78 }, barracks: { scale: 0.92 }, forge: { scale: 1.00 },
    altar:     { scale: 1.30, spin: ['crystal_top', 'crystal_bot'] },
    darkmine:  { scale: 1.00 },
    market:    { scale: 0.90 },   // model rộng 4.81 -> 4.33 ~ size 4
    windmill:  { scale: 1.00, hierarchy: true, blades: 'blades' }, // Rig 2 khớp: node 'blades' pivot tại tâm quạt — game xoay theo thời gian
    shrine:    { scale: 1.00 },   // rộng 3.42 ~ đường kính va chạm 3.6 của size 3
    tavern:    { scale: 0.85 },   // rộng 5.07 -> 4.31 ~ size 4
    library:   { scale: 0.95 },   // rộng 4.58 -> 4.35 ~ size 4
    watchtower:{ scale: 1.00 },   // cao 6.30, đế rộng 3.34 ~ size 3
    tree_01:   { scale: 1.20 }, tree_02: { scale: 1.35 },
    rock_01:   { scale: 1.30 }, rock_02: { scale: 1.10 }, bush: { scale: 1.35 },
    fence:     { scale: 1.00 }, crate: { scale: 1.00 }, campfire: { scale: 1.30 },
    path_stone: { scale: 1.10 }
  };
  var modelTemplates = {}, modelWaiters = {}, modelState = {};
  var campfireLight = null; // đèn lửa trại trang trí (nhấp nháy trong updateDayNight)
  function loadModel(key) {
    if (modelState[key]) return;
    modelState[key] = 'loading';
    if (typeof GLTF_LITE === 'undefined' || typeof fetch === 'undefined') { modelState[key] = 'failed'; return; }
    fetch('assets/models/' + key + '.glb').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      var mdef = MODEL_DEFS[key];
      // Nhân vật + cối xay gió: dựng theo CÂY NODE (hierarchy) để xoay từng khớp/node
      // (khớp nhân vật cho animator; node 'blades' của cối cho hiệu ứng quạt xoay);
      // model tĩnh: giữ nguyên đường phẳng cũ.
      modelTemplates[key] = GLTF_LITE.buildGroup(THREE, GLTF_LITE.parseGLB(buf), { hierarchy: !!(mdef && (mdef.char || mdef.hierarchy)) });
      modelState[key] = 'ready';
      var ws = modelWaiters[key] || []; modelWaiters[key] = [];
      ws.forEach(function (w) { applyModelSwap(w.group, key, w.opts); });
    }).catch(function (err) {
      modelState[key] = 'failed';
      console.warn('[VillageRPG] Không nạp được model ' + key + '.glb — giữ hình hộp cho loại này.', err);
    });
  }
  function attachModel(group, key, opts) {
    if (modelState[key] === 'failed') return;
    if (modelTemplates[key]) { applyModelSwap(group, key, opts || {}); return; }
    (modelWaiters[key] = modelWaiters[key] || []).push({ group: group, opts: opts || {} });
    loadModel(key);
  }
  function ghostifyGroup(g) { // ép trong suốt cho ghost xây dựng (clone vật liệu để không đụng template dùng chung)
    g.traverse(function (o) {
      if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.55; o.castShadow = false; }
    });
  }
  function applyModelSwap(group, key, opts) {
    var def = MODEL_DEFS[key], tpl = modelTemplates[key];
    if (!def || !tpl || !group) return;
    var inst = tpl.clone(true); // clone Group: dùng chung geometry gốc
    if (def.char || opts.tint) { // nhân vật + đá tint: clone vật liệu riêng theo instance
      var cache = {};
      inst.traverse(function (o) {
        if (!o.isMesh) return;
        if (!cache[o.material.uuid]) {
          var c = o.material.clone();
          if (opts.tint) c.color.multiply(new THREE.Color(opts.tint));
          cache[o.material.uuid] = c;
        }
        o.material = cache[o.material.uuid];
      });
    }
    if (def.hide) inst.traverse(function (o) { if (o.isMesh && def.hide.indexOf(o.name) !== -1) o.visible = false; });
    var root = new THREE.Group(); root.name = 'glb:' + key;
    root.scale.setScalar(opts.scale != null ? opts.scale : def.scale);
    root.add(inst);
    // Gỡ thân hộp cũ: chỉ gỡ Mesh con trực tiếp — giữ Group con (thanh HP), PointLight
    // (lò rèn/đài kỹ năng), dải cấp tierBand và vật opts.keep chỉ định (kiếm vung người chơi).
    var keep = opts.keep || [], removed = [];
    group.children.slice().forEach(function (ch) {
      if (ch.isMesh && keep.indexOf(ch) === -1 && ch !== group.userData.tierBand) { group.remove(ch); removed.push(ch); }
    });
    if (group.userData.spin && removed.indexOf(group.userData.spin) !== -1) group.userData.spin = null;
    group.add(root);
    group.userData.modelRoot = root;
    if (def.spin) { // Đài kỹ năng: gom mảnh tinh thể của model vào 1 group để giữ hiệu ứng xoay vốn có
      var found = [];
      def.spin.forEach(function (nm) { inst.traverse(function (o) { if (o.isMesh && o.name === nm) found.push(o); }); });
      if (found.length) {
        var spinG = new THREE.Group(); root.add(spinG);
        found.forEach(function (p) { spinG.attach(p); });
        group.userData.spin = spinG;
      }
    }
    // Cối xay gió: đăng ký node cánh quạt của instance này để vòng lặp xoay theo thời gian.
    // Nếu đang có cánh DỰ PHÒNG (hình hộp) thì gỡ — tránh 2 bộ cánh chồng nhau sau hoán đổi.
    if (def.blades) {
      var bladeNode = null;
      inst.traverse(function (o) { if (o.name === def.blades && !bladeNode) bladeNode = o; });
      if (group.userData.bladesNode && group.userData.bladesNode.userData.fromFallback) {
        group.remove(group.userData.bladesNode);
        group.userData.bladesNode = null;
      }
      if (bladeNode) group.userData.bladesNode = bladeNode;
    }
    // Đợt animation: gắn bản đồ node khớp cho instance này (clone(true) KHÔNG mang
    // userData.parts của template nên phải tra lại trên chính instance đã clone).
    if (def.char && typeof GLTF_LITE.collectParts === 'function') {
      var prts = GLTF_LITE.collectParts(inst);
      if (Object.keys(prts).length) {
        group.userData.parts = prts;
        group.userData.animSpecies = ANIM_SPECIES[key] || 'humanoid';
      }
    }
    modelSwapCount++;
    if (opts.ghost) ghostifyGroup(group);
    if (opts.onSwap) opts.onSwap(root);
  }
  // Phơi bày cho harness kiểm chứng (chỉ đọc): trạng thái nạp từng loại model + số lượt đã hoán đổi.
  var modelSwapCount = 0;
  window.__VRPG_MODELS = { state: function () { return modelState; }, defs: MODEL_DEFS, swaps: function () { return modelSwapCount; } };

  /* ================= Animation rối khớp nhân vật (đợt chuyển động) =================
     Toán pose thuần ở core.poseHumanoid; tầng này chỉ: gắn animator cho entity có
     group.userData.parts (model khớp đã hoán đổi), suy trạng thái từ gameplay THẬT
     (pha bước TÍCH LŨY THEO QUÃNG ĐƯỜNG đã đi — sải 2.4 đơn vị cho 1 vòng 2π, khớp
     chiều cao model ~2.19; đòn đánh/trúng đòn là trigger ghi mốc gameTime), rồi ghi
     góc vào từng node khớp mỗi tick. Entity không có parts (trưởng làng/beast/boss 1,
     hoặc model chưa nạp/lỗi -> đang là hộp) thì bỏ qua — hành vi cũ nguyên vẹn.
     ĐỒNG BỘ KIẾM: swordMesh GIỮ NGUYÊN cơ chế vung cũ (rotation.z = -1.6 trong
     ~130ms); đòn chém của pose được chỉnh trùng pha — đỉnh vung ở 45% x 0.35s ≈
     0.157s, gần như cùng thời điểm kiếm đạt cực trị — nên mắt đọc tay + kiếm là MỘT
     chuyển động. Không gắn kiếm thật vào arm_r: kiếm phải nằm trong hệ tọa độ group
     (hiện cả khi model chưa nạp xong) và logic tầm/va chạm không hề đọc vị trí kiếm. */
  var ANIM_SPECIES = { player: 'humanoid', companion: 'humanoid', goblin: 'goblin', goblin_archer: 'archer', boss_fog: 'fog' };
  function ensureAnim(ent) {
    if (!ent.anim) ent.anim = { phase: 0, attackAt: -10, hitAt: -10, lx: null, lz: null };
    return ent.anim;
  }
  function triggerAnim(ent, what) {
    if (!ent || !ent.group || !ent.group.userData.parts) return;
    var a = ensureAnim(ent);
    if (what === 'attack') a.attackAt = gameTime;
    else if (what === 'hit') a.hitAt = gameTime;
  }
  function updateEntityAnim(ent, dt, maxSpeed) {
    if (!ent || !ent.group || ent.alive === false || ent.dead) return; // player dùng cờ 'dead', quái/đồng đội dùng 'alive'
    var parts = ent.group.userData.parts;
    if (!parts) return; // chưa có model khớp -> không animator (đứng yên như cũ)
    var a = ensureAnim(ent), pos = ent.group.position;
    if (a.lx === null) { a.lx = pos.x; a.lz = pos.z; }
    var dx = pos.x - a.lx, dz = pos.z - a.lz;
    var dist = Math.sqrt(dx * dx + dz * dz);
    a.lx = pos.x; a.lz = pos.z;
    var moving = dist > 0.0005;
    if (moving) a.phase += dist / 2.4 * Math.PI * 2; // pha bước theo QUÃNG ĐƯỜNG, không theo đồng hồ
    var speed01 = maxSpeed > 0 && dt > 0 ? Math.min(1, (dist / dt) / maxSpeed) : 0;
    var pose = C.poseHumanoid({
      species: ent.group.userData.animSpecies || 'humanoid',
      state: moving ? 'walk' : 'idle',
      t: gameTime, phase: a.phase,
      speed01: moving ? Math.max(0.25, speed01) : 0,
      attackT: a.attackAt > -5 ? gameTime - a.attackAt : -1,
      hitT: a.hitAt > -5 ? gameTime - a.hitAt : -1
    });
    for (var nm in pose.parts) {
      var node = parts[nm]; if (!node) continue;
      var r = pose.parts[nm];
      node.rotation.set(r.x, r.y, r.z);
    }
    var root = ent.group.userData.modelRoot;
    pos.y = pose.bob * (root ? root.scale.x : 1); // bob tính theo đơn vị model -> đổi về đơn vị thế giới
    ent.animDebug = pose.parts; // harness đọc số góc THẬT đang áp lên khớp
  }
  // Phơi bày cho harness kiểm chứng (chỉ đọc): bản đồ part + góc đang áp của 1 entity.
  window.__VRPG_ANIM = {
    partsOf: function (ent) { return ent && ent.group ? (ent.group.userData.parts || null) : null; },
    debugOf: function (ent) { return ent ? (ent.animDebug || null) : null; },
    entities: function () { return { player: player, enemies: enemies, companions: companions }; }
  };
  // Chọn biến thể tất định theo vị trí (hash tọa độ — cùng 1 vị trí luôn ra cùng model, không random theo lần tải).
  function variantFor(x, z) { return Math.abs(Math.round(x) * 31 + Math.round(z) * 57) % 2; }
  function makeHpBar(w) {
    var g = new THREE.Group();
    var bg = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.18), new THREE.MeshBasicMaterial({ color: 0x222222, side: THREE.DoubleSide }));
    var fg = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.14), new THREE.MeshBasicMaterial({ color: 0x66bb6a, side: THREE.DoubleSide }));
    fg.position.z = 0.01;
    g.add(bg); g.add(fg); g.userData.fg = fg; g.userData.w = w;
    return g;
  }
  function setHpBar(bar, frac) {
    var fg = bar.userData.fg, w = bar.userData.w;
    frac = Math.max(0, Math.min(1, frac));
    fg.scale.x = Math.max(0.001, frac);
    fg.position.x = -w * (1 - frac) / 2;
  }

  /* ================= Texture thủ tục (Mục 6): vẽ bằng Canvas, không tải asset ngoài ================= */
  function makeCanvasTexture(size, painter, rx, ry) {
    var cv = document.createElement('canvas'); cv.width = cv.height = size;
    var ctx2d = cv.getContext('2d');
    if (ctx2d) painter(ctx2d, size); // không có canvas 2d -> dùng texture trơn, TUYỆT ĐỐI không để chết init
    var tx = new THREE.CanvasTexture(cv);
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.repeat.set(rx, ry);
    return tx;
  }
  function fleckPainter(base, flecks, n) {
    return function (ctx, sz) {
      ctx.fillStyle = base; ctx.fillRect(0, 0, sz, sz);
      for (var i = 0; i < n; i++) {
        ctx.fillStyle = flecks[i % flecks.length];
        ctx.globalAlpha = 0.2 + ((i * 13) % 40) / 100;
        var r = 2 + ((i * 37) % 7);
        ctx.fillRect((i * 53) % sz, (i * 97) % sz, r, r);
      }
      ctx.globalAlpha = 1;
    };
  }
  var grassTex = makeCanvasTexture(256, fleckPainter('#69a856', ['#5c9648', '#77b564', '#4e8a3e'], 900), 10, 7); // canvas 256x256
  var dirtTex = makeCanvasTexture(256, fleckPainter('#4a4a58', ['#3c3c48', '#585864', '#2f2f3a'], 700), 3, 8);   // canvas 256x256
  var roofTex = makeCanvasTexture(128, function (ctx, sz) { // canvas 128x128: vân ngói
    ctx.fillStyle = '#b71c1c'; ctx.fillRect(0, 0, sz, sz);
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    for (var y = 0; y < sz; y += 16) ctx.fillRect(0, y, sz, 3);
    for (var x = 0; x < sz; x += 16) ctx.fillRect(x, 0, 3, sz);
  }, 1, 1);

  /* ================= Dựng thế giới ================= */
  var ground = new THREE.Mesh(new THREE.PlaneGeometry(130, 90), new THREE.MeshLambertMaterial({ color: 0xffffff, map: grassTex }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  scene.add(ground);
  // Khu nguy hiểm phía Đông: nền tối + sương
  var dangerGround = new THREE.Mesh(new THREE.PlaneGeometry(34, 90), new THREE.MeshLambertMaterial({ color: 0xffffff, map: dirtTex }));
  dangerGround.rotation.x = -Math.PI / 2; dangerGround.position.set(45, 0.02, 0); dangerGround.receiveShadow = true;
  scene.add(dangerGround);
  // Đường mòn từ làng sang khu nguy hiểm
  var path = new THREE.Mesh(new THREE.PlaneGeometry(70, 4), new THREE.MeshLambertMaterial({ color: 0xc2a878 }));
  path.rotation.x = -Math.PI / 2; path.position.set(10, 0.03, 0); path.receiveShadow = true;
  scene.add(path);
  // Cột mốc đỏ báo khu nguy hiểm
  var markerPost = box(0.5, 4, 0.5, 0xc62828, 30, 2, -3); scene.add(markerPost);
  // Sương cục bộ Khu Sương Mù: 10 mặt phẳng sương tĩnh rẻ tiền (giới hạn cứng) + 1 đèn lạnh
  var mistPlanes = [];
  (function () {
    var mistMat = new THREE.MeshBasicMaterial({ color: 0xaec6da, transparent: true, opacity: 0.10, depthWrite: false, side: THREE.DoubleSide });
    for (var mi = 0; mi < 10; mi++) {
      var mp = new THREE.Mesh(new THREE.PlaneGeometry(9, 3.2), mistMat);
      mp.position.set(34 + mi * 2.6, 1.7, ((mi * 37) % 52) - 26);
      mp.rotation.y = mi * 0.7;
      scene.add(mp); mistPlanes.push(mp);
    }
    var mistLight = new THREE.PointLight(0x7fa8d0, 0.8, 42); mistLight.position.set(45, 6, 0); scene.add(mistLight);
  })();
  var markerPost2 = box(0.5, 4, 0.5, 0xc62828, 30, 2, 3); scene.add(markerPost2);

  function seededRand(seed) { var s = seed; return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
  var rand = seededRand(12345);
  function scatterPos(minX, maxX, minZ, maxZ, avoid) {
    for (var tries = 0; tries < 30; tries++) {
      var x = minX + rand() * (maxX - minX), z = minZ + rand() * (maxZ - minZ);
      var ok = true;
      for (var i = 0; i < avoid.length; i++) { var dx = x - avoid[i].x, dz = z - avoid[i].z; if (dx * dx + dz * dz < 16) { ok = false; break; } }
      if (ok && Math.abs(z) > 3.4) return { x: x, z: z }; // tránh đường mòn
    }
    return { x: minX, z: minZ + 8 };
  }
  var avoidPts = [{ x: 0, z: 0 }, { x: -6, z: 6 }, { x: 4, z: 4 }];
  function makeTree(x, z) {
    var g = new THREE.Group(); g.position.set(x, 0, z);
    var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 2.2, 6), new THREE.MeshLambertMaterial({ color: 0x795548 }));
    trunk.position.y = 1.1; trunk.castShadow = true; g.add(trunk);
    var fol = new THREE.Mesh(new THREE.SphereGeometry(1.7, 8, 6), new THREE.MeshLambertMaterial({ color: 0x2e7d32 }));
    fol.position.y = 3.4; fol.castShadow = true; g.add(fol);
    var fol2 = new THREE.Mesh(new THREE.SphereGeometry(1.15, 8, 6), new THREE.MeshLambertMaterial({ color: 0x388e3c }));
    fol2.position.set(0.7, 4.3, 0.3); g.add(fol2);
    scene.add(g);
    attachModel(g, variantFor(x, z) ? 'tree_02' : 'tree_01'); // biến thể tất định theo vị trí
    trees.push({ group: g, x: x, z: z, charges: 5, respawnAt: 0 });
  }
  function makeRock(x, z, dark) {
    var g = new THREE.Group(); g.position.set(x, 0, z);
    var r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.9), new THREE.MeshLambertMaterial({ color: dark ? 0x3d348b : 0x80868b }));
    r.position.y = 0.6; r.castShadow = true; g.add(r);
    scene.add(g);
    attachModel(g, variantFor(x + 13.7, z - 7.3) ? 'rock_02' : 'rock_01', dark ? { tint: 0x8a7fd6 } : {}); // đá Hắc Kim: tint tím tối như hộp cũ
    rocks.push({ group: g, x: x, z: z, charges: 4, respawnAt: 0, dark: !!dark });
  }
  function makeBush(x, z) {
    var g = new THREE.Group(); g.position.set(x, 0, z);
    var b = new THREE.Mesh(new THREE.SphereGeometry(0.8, 7, 6), new THREE.MeshLambertMaterial({ color: 0x558b2f }));
    b.position.y = 0.6; b.castShadow = true; g.add(b);
    for (var i = 0; i < 4; i++) {
      var berry = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 5), new THREE.MeshLambertMaterial({ color: 0xd32f2f }));
      berry.position.set((rand() - 0.5) * 1.1, 0.7 + rand() * 0.5, (rand() - 0.5) * 1.1); g.add(berry);
    }
    scene.add(g);
    attachModel(g, 'bush');
    bushes.push({ group: g, x: x, z: z, charges: 3, respawnAt: 0 });
  }
  for (var i = 0; i < 34; i++) { var p = scatterPos(-42, 24, -32, 32, avoidPts); avoidPts.push(p); makeTree(p.x, p.z); }
  for (i = 0; i < 10; i++) { p = scatterPos(-40, 20, -30, 30, avoidPts); avoidPts.push(p); makeRock(p.x, p.z, false); }
  for (i = 0; i < 5; i++) { p = scatterPos(36, 55, -28, 28, avoidPts); makeRock(p.x, p.z, true); }
  for (i = 0; i < 9; i++) { p = scatterPos(-40, 22, -30, 30, avoidPts); avoidPts.push(p); makeBush(p.x, p.z); }

  /* Trang trí GLB tất định quanh làng (chỉ thêm hình — KHÔNG va chạm, KHÔNG gameplay):
     thùng gỗ cạnh Nhà chính, bếp lửa trại trên bãi cỏ trống, hàng rào dọc 2 bên đường mòn,
     đá lát đoạn đường trước Nhà chính. Tọa độ tránh: tâm Nhà chính (|x|<5), điểm hồi sinh
     người chơi (-6, 6), Trưởng làng (4, 4.5) và dải đường đi chính (đá lát nằm phẳng trên đường). */
  function addDecor(key, x, z, opts) {
    opts = opts || {};
    var g = new THREE.Group();
    g.position.set(x, opts.y || 0, z);
    if (opts.rotY) g.rotation.y = opts.rotY;
    scene.add(g);
    attachModel(g, key, opts);
    return g;
  }
  addDecor('crate', 5.6, 3.4, { rotY: 0.4 });
  addDecor('crate', 5.55, 3.35, { rotY: 1.1, y: 0.95, scale: 0.72 }); // thùng xếp chồng lên thùng dưới
  addDecor('crate', -5.4, 3.0, { rotY: 0.9 });
  var campfireG = addDecor('campfire', -4.8, -4.6, {});
  campfireLight = new THREE.PointLight(0xff8c42, 1.1, 10); campfireLight.position.set(0, 1.0, 0); campfireG.add(campfireLight);
  for (var dfi = 0; dfi < 6; dfi++) addDecor('fence', -20 + dfi * 2, -2.7, {}); // rào phía bắc đường: x -20..-8
  for (var dfj = 0; dfj < 6; dfj++) addDecor('fence', 12 + dfj * 2, 2.7, {});   // rào phía nam đường: x 12..24
  [-16, -14, -12, -10, -8, -6, 8, 10, 12, 14, 16, 18].forEach(function (sx) {
    addDecor('path_stone', sx, 0, { y: 0.045, rotY: (Math.abs(sx * 13) % 10 - 5) * 0.03 }); // lát đường, xoay lệch nhẹ tất định
  });

  /* ================= LÀM LẠI MAP (đợt mở rộng) — CHỈ lớp trình bày =================
     KHUNG GAMEPLAY GIỮ NGUYÊN TUYỆT ĐỐI: cây/đá/bụi/spawn/va chạm/đường cũ không đụng vào
     (rải rác mới dùng seed RIÊNG 20261023 — không làm lệch dãy rand() của node gameplay).
     Bố cục 3 tầng: tiền cảnh rải rác (InstancedMesh), trung cảnh điểm nhấn (quảng trường,
     HỒ NƯỚC, cầu, cổng, cột đèn), hậu cảnh (vòng núi 2 lớp + hàng cây rìa + mây trôi).
     Màu: toàn bộ từ palette art-bible; các tông suy ra của đợt này khai báo ngay tại đây:
       WATER_DAY #7E97B5 (từ INDIGO #546A8A nâng sáng) · WATER_NIGHT #2E3A52 (INDIGO hạ tối)
       POND_DEEP #3D4A66 (INDIGO sẫm — đáy hồ) · CLOUD_DAY #F5EFE3 (từ EARTH #C89B6C nâng sáng)
       CLOUD_NIGHT #5E6484 (trộn INDIGO + FOG) · MTN_GROUND #4A3F6B (từ FOG_DEEP #5E4F8A hạ tối)
       DIRT_PATH #B98D5F (EARTH hạ sáng) · PETAL_WHITE #EDE4D0 (EARTH nâng sáng gần trắng ấm) */
  var POND_DAY_C = new THREE.Color(0x7e97b5), POND_NIGHT_C = new THREE.Color(0x2e3a52);
  var CLOUD_DAY_C = new THREE.Color(0xf5efe3), CLOUD_NIGHT_C = new THREE.Color(0x5e6484);
  var POND_POS = { x: -13, z: 24, r: 4.6 };
  var PLAZA_POS = { x: -4.8, z: -4.6, r: 5.6 };
  var pondWaterMat = null, cloudMat = null;
  var cloudsArr = [], bannerMesh = null, decorT = 0;

  // Gộp nhiều hình học đơn giản thành 1 BufferGeometry (1 draw call) — pháp tuyến phẳng theo mặt.
  function mergeGeoms(items) {
    var posArr = [];
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), eu = new THREE.Euler(), pv = new THREE.Vector3();
    items.forEach(function (it) {
      var g = it.geo.index ? it.geo.toNonIndexed() : it.geo;
      var p = g.attributes.position;
      eu.set(it.rx || 0, it.ry || 0, it.rz || 0); q.setFromEuler(eu);
      m4.compose(new THREE.Vector3(it.x || 0, it.y || 0, it.z || 0), q,
        new THREE.Vector3(it.sx != null ? it.sx : (it.s || 1), it.sy != null ? it.sy : (it.s || 1), it.sz != null ? it.sz : (it.s || 1)));
      for (var vi = 0; vi < p.count; vi++) { pv.fromBufferAttribute(p, vi).applyMatrix4(m4); posArr.push(pv.x, pv.y, pv.z); }
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    out.computeVertexNormals();
    return out;
  }
  function lambert(color, opts) { return new THREE.MeshLambertMaterial(Object.assign({ color: color }, opts || {})); }

  var decorRand = seededRand(20261023);
  var pendingLampPosts = []; // điểm đèn cột đường — khối map chạy TRƯỚC mục ngày–đêm nên chỉ đăng ký, syncLanterns tạo sau
  function decorClear(x, z) {
    if (Math.hypot(x - POND_POS.x, z - POND_POS.z) < POND_POS.r + 1.2) return false;
    if (Math.hypot(x - PLAZA_POS.x, z - PLAZA_POS.z) < PLAZA_POS.r + 0.4) return false;
    if (Math.hypot(x, z) < 5.8) return false;                                  // Nhà chính
    if (Math.abs(z) < 3.1 && x > -27 && x < 47) return false;                 // đường chính đông–tây
    if (Math.abs(x + 2) < 2.4 && z > -2 && z < 40) return false;              // đường nam ra cổng
    if (z > 33.5) return false;                                               // dải suối nam
    if (Math.hypot(x + 6, z - 6) < 2.6) return false;                         // điểm spawn người chơi
    if (Math.hypot(x - 4, z - 4.5) < 2.2) return false;                       // Trưởng làng
    for (var i = 0; i < trees.length; i++) if (Math.hypot(x - trees[i].x, z - trees[i].z) < 1.5) return false;
    for (var j = 0; j < rocks.length; j++) if (Math.hypot(x - rocks[j].x, z - rocks[j].z) < 1.5) return false;
    return true;
  }
  function decorSpot(minX, maxX, minZ, maxZ) {
    for (var t = 0; t < 24; t++) {
      var x = minX + decorRand() * (maxX - minX), z = minZ + decorRand() * (maxZ - minZ);
      if (decorClear(x, z)) return { x: x, z: z };
    }
    return null;
  }
  function scatterInstanced(geo, mat, spots, colors) {
    var im = new THREE.InstancedMesh(geo, mat, spots.length);
    var M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), V = new THREE.Vector3(), SC = new THREE.Vector3();
    spots.forEach(function (sp, i) {
      E.set(sp.rx || 0, sp.ry || 0, sp.rz || 0); Q.setFromEuler(E);
      var s = sp.s || 1;
      SC.set(s * (sp.sx || 1), s * (sp.sy || 1), s * (sp.sz || 1));
      V.set(sp.x, sp.y || 0, sp.z);
      M.compose(V, Q, SC);
      im.setMatrixAt(i, M);
      if (colors) im.setColorAt(i, colors[i % colors.length]);
    });
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.frustumCulled = false; // instance rải khắp map — tắt culling theo hình học gốc để không bị cắt oan
    im.receiveShadow = true;
    scene.add(im);
    return im;
  }
  function collectSpots(n, eastShare) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var east = decorRand() < (eastShare || 0);
      var sp = east ? decorSpot(31, 56, -30, 30) : decorSpot(-44, 28, -34, 34);
      if (sp) out.push(sp);
    }
    return out;
  }

  /* ----- TIỀN CẢNH: hoa / cỏ / đá cuội / nấm ----- */
  (function scatterForeground() {
    var spots = collectSpots(220, 0.06);
    // Thân hoa (1 draw) + đầu hoa 5 màu palette (5 draw)
    var stemGeo = new THREE.CylinderGeometry(0.025, 0.04, 0.36, 5); stemGeo.translate(0, 0.18, 0);
    scatterInstanced(stemGeo, lambert(0x4e7a3a), spots.map(function (sp) { return { x: sp.x, z: sp.z, s: 0.8 + decorRand() * 0.5 }; }));
    var headGeo = new THREE.IcosahedronGeometry(0.12, 0); headGeo.translate(0, 0.42, 0);
    var petalCols = [0xd9a441, 0xc96f3b, 0xc0452f, 0x8e7fb8, 0xede4d0].map(function (h) { return new THREE.Color(h); });
    var byColor = [[], [], [], [], []];
    spots.forEach(function (sp, i) { byColor[i % 5].push({ x: sp.x, z: sp.z, s: 0.8 + (i % 7) * 0.06 }); });
    byColor.forEach(function (grp, gi) { if (grp.length) scatterInstanced(headGeo, lambert(0xffffff), grp, [petalCols[gi]]); });
    // Bụi cỏ (1 draw, màu instance xen LEAF/MOSS)
    var grassGeo = new THREE.ConeGeometry(0.17, 0.55, 4); grassGeo.translate(0, 0.26, 0);
    var grassCols = [new THREE.Color(0x7fa653), new THREE.Color(0x4e7a3a), new THREE.Color(0x69a856)];
    scatterInstanced(grassGeo, lambert(0xffffff), collectSpots(380, 0.15).map(function (sp) {
      return { x: sp.x, z: sp.z, ry: decorRand() * 3.14, s: 0.7 + decorRand() * 0.9, sy: 0.8 + decorRand() * 0.7 };
    }), grassCols);
    // Đá cuội (1 draw) + hàng đá dọc bờ suối nam
    var pebGeo = new THREE.DodecahedronGeometry(0.16);
    var pebSpots = collectSpots(110, 0.1).map(function (sp) { return { x: sp.x, z: sp.z, ry: decorRand() * 3, s: 0.6 + decorRand(), sy: 0.55 }; });
    for (var bi2 = 0; bi2 < 24; bi2++) pebSpots.push({ x: -17 + bi2 * 1.6 + decorRand() * 0.5, y: 0.05, z: (bi2 % 2 ? 39.9 : 35.3) + decorRand() * 0.4, s: 0.9 + decorRand() * 0.8, sy: 0.6 });
    scatterInstanced(pebGeo, lambert(0xffffff), pebSpots, [new THREE.Color(0x9a8b78), new THREE.Color(0x776a58)]);
    // Nấm dưới gốc cây (2 draw: thân + mũ, mũ xen TERRA/DANGER)
    var mushSpots = [];
    var vTrees = trees.filter(function (t) { return t.x <= 26; });
    for (var mi3 = 0; mi3 < 30 && vTrees.length; mi3++) {
      var bt = vTrees[Math.floor(decorRand() * vTrees.length)];
      var ang = decorRand() * Math.PI * 2, rr = 0.95 + decorRand() * 0.6;
      mushSpots.push({ x: bt.x + Math.cos(ang) * rr, z: bt.z + Math.sin(ang) * rr, s: 0.8 + decorRand() * 0.7 });
    }
    var mStemGeo = new THREE.CylinderGeometry(0.05, 0.085, 0.22, 6); mStemGeo.translate(0, 0.11, 0);
    scatterInstanced(mStemGeo, lambert(0xc89b6c), mushSpots);
    var mCapGeo = new THREE.ConeGeometry(0.19, 0.16, 7); mCapGeo.translate(0, 0.27, 0);
    scatterInstanced(mCapGeo, lambert(0xffffff), mushSpots, [new THREE.Color(0xc96f3b), new THREE.Color(0xc0452f)]);
  })();

  /* ----- Lớp nhuộm đất theo vùng + lối mòn đất nhánh (gộp 1 draw) ----- */
  (function groundTintsAndPaths() {
    var warm = new THREE.Mesh(new THREE.CircleGeometry(31, 26), lambert(0xc89b6c, { transparent: true, opacity: 0.16, depthWrite: false }));
    warm.geometry.rotateX(-Math.PI / 2); warm.position.set(-8, 0.012, 0); warm.receiveShadow = true; scene.add(warm);
    var cold = new THREE.Mesh(new THREE.CircleGeometry(25, 26), lambert(0x8e7fb8, { transparent: true, opacity: 0.20, depthWrite: false }));
    cold.geometry.rotateX(-Math.PI / 2); cold.position.set(46, 0.026, 0); cold.receiveShadow = true; scene.add(cold); // tâm 46/r25: chỉ phủ khu sương + dải chuyển tiếp x>=21, không nhuộm tím làng
    function pathItem(x1, z1, x2, z2, w) {
      var len = Math.hypot(x2 - x1, z2 - z1);
      var g = new THREE.PlaneGeometry(w, len); g.rotateX(-Math.PI / 2);
      return { geo: g, x: (x1 + x2) / 2, y: 0.021, z: (z1 + z2) / 2, ry: Math.atan2(x2 - x1, z2 - z1) };
    }
    var paths = new THREE.Mesh(mergeGeoms([
      pathItem(-6, 5, -4.9, -3.5, 2.2),     // spawn -> quảng trường
      pathItem(-2, 0.5, -2, 29, 2.6),       // quảng trường -> cổng nam
      pathItem(-7.5, -1, -12, 19.5, 2.0),   // quảng trường -> hồ
      pathItem(-9, -4.6, -24, -6, 1.8),     // quảng trường -> rìa tây
      pathItem(2, 0.8, 12, 10, 1.7)         // Nhà chính -> đông-bắc (nối đường chính)
    ]), lambert(0xb98d5f, { transparent: true, opacity: 0.55, depthWrite: false }));
    paths.name = 'dirt-paths'; paths.receiveShadow = true; scene.add(paths);
  })();

  /* ----- TRUNG CẢNH: quảng trường + cột cờ ----- */
  (function plazaAndFlag() {
    var disc = new THREE.Mesh(new THREE.CylinderGeometry(PLAZA_POS.r, PLAZA_POS.r + 0.25, 0.09, 26), lambert(0x9a8b78));
    disc.position.set(PLAZA_POS.x, 0.045, PLAZA_POS.z); disc.name = 'plaza'; disc.receiveShadow = true; scene.add(disc);
    var ring = new THREE.Mesh(new THREE.TorusGeometry(4.35, 0.075, 6, 36), lambert(0x776a58));
    ring.geometry.rotateX(Math.PI / 2); ring.position.set(PLAZA_POS.x, 0.1, PLAZA_POS.z); scene.add(ring);
    var inner = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.09, 6, 20), lambert(0xc89b6c));
    inner.geometry.rotateX(Math.PI / 2); inner.position.set(PLAZA_POS.x, 0.1, PLAZA_POS.z); scene.add(inner);
    // Cột cờ ở rìa quảng trường phía Nhà chính — biểu ngữ ĐỎ phấp phới trong updateDecor
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 5.6, 8), lambert(0x5c3a21));
    pole.position.set(-1.2, 2.8, -8.8); pole.name = 'flagpole'; pole.castShadow = true; scene.add(pole);
    var finial = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), lambert(0xd9a441));
    finial.position.set(-1.2, 5.7, -8.8); scene.add(finial);
    var bGeo = new THREE.PlaneGeometry(1.55, 0.95); bGeo.translate(0.8, 0, 0); // mép trái dính vào cột
    bannerMesh = new THREE.Mesh(bGeo, new THREE.MeshLambertMaterial({ color: 0xc0452f, side: THREE.DoubleSide }));
    bannerMesh.position.set(-1.2, 5.05, -8.8); bannerMesh.name = 'banner'; scene.add(bannerMesh);
    var stripe = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 0.2), new THREE.MeshLambertMaterial({ color: 0xd9a441, side: THREE.DoubleSide }));
    stripe.position.set(0.8, -0.3, 0.01); bannerMesh.add(stripe);
  })();

  /* ----- TRUNG CẢNH: HỒ NƯỚC (điểm nhấn chính) + suối nam + cầu ----- */
  (function pondStreamBridge() {
    pondWaterMat = new THREE.MeshStandardMaterial({ color: POND_DAY_C.clone(), transparent: true, opacity: 0.78, roughness: 0.25, metalness: 0.05 });
    var deep = new THREE.Mesh(new THREE.CircleGeometry(POND_POS.r + 0.35, 26), lambert(0x3d4a66));
    deep.geometry.rotateX(-Math.PI / 2); deep.position.set(POND_POS.x, 0.04, POND_POS.z); scene.add(deep);
    var water = new THREE.Mesh(new THREE.CircleGeometry(POND_POS.r, 26), pondWaterMat);
    water.geometry.rotateX(-Math.PI / 2); water.position.set(POND_POS.x, 0.07, POND_POS.z); water.name = 'pond-water'; scene.add(water);
    var shore = new THREE.Mesh(new THREE.RingGeometry(POND_POS.r - 0.3, POND_POS.r + 0.55, 26), lambert(0xc89b6c));
    shore.geometry.rotateX(-Math.PI / 2); shore.position.set(POND_POS.x, 0.05, POND_POS.z); shore.receiveShadow = true; scene.add(shore);
    // Viền đá quanh hồ (instanced) + sậy (instanced, xen MOSS/LEAF)
    var rimSpots = [], reedSpots = [];
    for (var i = 0; i < 15; i++) {
      var a = i / 15 * Math.PI * 2 + decorRand() * 0.2;
      rimSpots.push({ x: POND_POS.x + Math.cos(a) * (POND_POS.r + 0.45), y: 0.08, z: POND_POS.z + Math.sin(a) * (POND_POS.r + 0.45), ry: decorRand() * 3, s: 0.8 + decorRand() * 0.7, sy: 0.6 });
    }
    scatterInstanced(new THREE.DodecahedronGeometry(0.42), lambert(0xffffff), rimSpots, [new THREE.Color(0x9a8b78), new THREE.Color(0x776a58)]);
    for (var j = 0; j < 18; j++) {
      var a2 = decorRand() * Math.PI * 2, r2 = POND_POS.r - 0.15 + decorRand() * 0.5;
      reedSpots.push({ x: POND_POS.x + Math.cos(a2) * r2, z: POND_POS.z + Math.sin(a2) * r2, rz: (decorRand() - 0.5) * 0.22, rx: (decorRand() - 0.5) * 0.22, s: 0.8 + decorRand() * 0.5 });
    }
    var reedGeo = new THREE.CylinderGeometry(0.03, 0.055, 1.15, 5); reedGeo.translate(0, 0.55, 0);
    scatterInstanced(reedGeo, lambert(0xffffff), reedSpots, [new THREE.Color(0x4e7a3a), new THREE.Color(0x7fa653)]);
    // Lá sen: 3 mảng tròn gộp 1 draw
    var lilyItems = [];
    [[-1.6, -0.8], [1.2, 1.4], [0.4, -2.0]].forEach(function (off) {
      var lg = new THREE.CircleGeometry(0.44, 9); lg.rotateX(-Math.PI / 2);
      lilyItems.push({ geo: lg, x: POND_POS.x + off[0], y: 0.095, z: POND_POS.z + off[1] });
    });
    var lilies = new THREE.Mesh(mergeGeoms(lilyItems), lambert(0x7fa653)); scene.add(lilies);
    // Suối trang trí rìa nam — CÙNG vật liệu nước với hồ (nhuộm ngày–đêm đồng bộ)
    var stream = new THREE.Mesh(new THREE.PlaneGeometry(38, 3.6), pondWaterMat);
    stream.geometry.rotateX(-Math.PI / 2); stream.position.set(2, 0.05, 37.6); stream.name = 'stream-water'; scene.add(stream);
    // Cầu gỗ bắc qua suối tại đường nam (x = -2): ván cong nhẹ + lan can — gộp 2 draw theo 2 tông gỗ
    var plankItems = [], railItems = [];
    for (var pi = 0; pi < 6; pi++) {
      var pz = 35.55 + pi * 0.84;
      plankItems.push({ geo: new THREE.BoxGeometry(2.7, 0.09, 0.68), x: -2, y: 0.14 + Math.sin(pi / 5 * Math.PI) * 0.07, z: pz });
    }
    [-3.25, -0.75].forEach(function (rx2) {
      railItems.push({ geo: new THREE.BoxGeometry(0.09, 0.09, 4.9), x: rx2, y: 0.78, z: 37.6 });
      [35.7, 37.6, 39.5].forEach(function (pz2) { railItems.push({ geo: new THREE.BoxGeometry(0.11, 0.85, 0.11), x: rx2, y: 0.4, z: pz2 }); });
    });
    var bridge = new THREE.Mesh(mergeGeoms(plankItems), lambert(0x8a5a33)); bridge.name = 'bridge'; bridge.castShadow = true; scene.add(bridge);
    var rails = new THREE.Mesh(mergeGeoms(railItems), lambert(0x5c3a21)); scene.add(rails);
  })();

  /* ----- TRUNG CẢNH: cổng làng phía nam + cột đèn lồng dọc đường chính ----- */
  (function gateAndLampPosts() {
    var woodItems = [
      { geo: new THREE.BoxGeometry(0.38, 4.3, 0.38), x: -4.3, y: 2.15, z: 30 },
      { geo: new THREE.BoxGeometry(0.38, 4.3, 0.38), x: 0.3, y: 2.15, z: 30 },
      { geo: new THREE.BoxGeometry(5.6, 0.42, 0.5), x: -2, y: 4.15, z: 30 },
      { geo: new THREE.BoxGeometry(5.9, 0.09, 1.45), x: -2, y: 4.62, z: 29.65, rx: 0.5 },
      { geo: new THREE.BoxGeometry(5.9, 0.09, 1.45), x: -2, y: 4.62, z: 30.35, rx: -0.5 }
    ];
    var gate = new THREE.Mesh(mergeGeoms(woodItems), lambert(0x8a5a33)); gate.name = 'gate'; gate.castShadow = true; scene.add(gate);
    var sign = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.62, 0.07), lambert(0xd9a441));
    sign.position.set(-2, 3.55, 30.3); scene.add(sign);
    var gateLampMat = lambert(0xd9a441, { emissive: 0x85500d });
    var gl = new THREE.Mesh(mergeGeoms([
      { geo: new THREE.BoxGeometry(0.22, 0.3, 0.22), x: -3.95, y: 3.05, z: 30 },
      { geo: new THREE.BoxGeometry(0.22, 0.3, 0.22), x: -0.05, y: 3.05, z: 30 }
    ]), gateLampMat); scene.add(gl);
    // 4 cột đèn dọc đường chính: thân gộp 1 draw; đầu đèn dùng lại hệ lantern sẵn có
    // (sprite + bóng + pool 4 PointLight dùng chung — KHÔNG tăng số đèn thật).
    var postItems = [], headItems = [];
    [[-18, 2.9], [-8, -2.9], [16, -2.9], [24, 2.9]].forEach(function (lp) {
      var side = lp[1] > 0 ? 1 : -1;
      postItems.push({ geo: new THREE.CylinderGeometry(0.07, 0.1, 2.6, 7), x: lp[0], y: 1.3, z: lp[1] });
      postItems.push({ geo: new THREE.BoxGeometry(0.08, 0.08, 0.75), x: lp[0], y: 2.52, z: lp[1] - side * 0.3 });
      headItems.push({ geo: new THREE.BoxGeometry(0.3, 0.36, 0.3), x: lp[0], y: 2.3, z: lp[1] - side * 0.62 });
      pendingLampPosts.push([lp[0], lp[1] - side * 0.62, 2.3]); // syncLanterns (mục ngày–đêm, chạy sau) sẽ tạo lantern thật từ danh sách chờ này
    });
    var posts = new THREE.Mesh(mergeGeoms(postItems), lambert(0x5c3a21)); posts.name = 'lamp-posts'; posts.castShadow = true; scene.add(posts);
    var heads = new THREE.Mesh(mergeGeoms(headItems), gateLampMat); scene.add(heads);
  })();

  /* ----- HẬU CẢNH: nền đất xa + vòng núi 2 lớp + hàng cây rìa + mây trôi ----- */
  (function backdrop() {
    var disc = new THREE.Mesh(new THREE.CircleGeometry(165, 32), lambert(0x4a3f6b));
    disc.geometry.rotateX(-Math.PI / 2); disc.position.y = -0.06; disc.name = 'backdrop'; scene.add(disc);
    var coneGeo = new THREE.ConeGeometry(1, 1, 5); coneGeo.translate(0, 0.5, 0); // đáy tại y=0 của instance
    var farSpots = [], nearSpots = [];
    for (var i = 0; i < 16; i++) {
      var a = i / 16 * Math.PI * 2 + decorRand() * 0.3, r = 108 + decorRand() * 18;
      farSpots.push({ x: Math.cos(a) * r, y: -1.5, z: Math.sin(a) * r * 0.78, ry: decorRand() * 3, sx: 17 + decorRand() * 14, sy: 15 + decorRand() * 13, sz: 15 + decorRand() * 10 });
    }
    var far = scatterInstanced(coneGeo, lambert(0xffffff), farSpots, [new THREE.Color(0x8e7fb8), new THREE.Color(0x7a68ac)]);
    far.name = 'mountains-far'; far.receiveShadow = false;
    for (var j = 0; j < 11; j++) {
      var a2 = j / 11 * Math.PI * 2 + 0.35 + decorRand() * 0.3, r2 = 90 + decorRand() * 12;
      nearSpots.push({ x: Math.cos(a2) * r2, y: -1, z: Math.sin(a2) * r2 * 0.78, ry: decorRand() * 3, sx: 13 + decorRand() * 9, sy: 9 + decorRand() * 7, sz: 12 + decorRand() * 8 });
    }
    var near = scatterInstanced(coneGeo, lambert(0xffffff), nearSpots, [new THREE.Color(0x7a68ac), new THREE.Color(0x5e4f8a)]);
    near.name = 'mountains-near'; near.receiveShadow = false;
    // Hàng cây tối bao rìa map (silhouette thông: nón cao, 1 draw)
    var pineGeo = new THREE.ConeGeometry(1.5, 4.6, 6); pineGeo.translate(0, 2.3, 0);
    var pineSpots = [];
    for (var px = -62; px <= 62; px += 4.6) {
      pineSpots.push({ x: px + decorRand() * 1.6, z: 38.5 + decorRand() * 3.5, ry: decorRand() * 3, s: 0.85 + decorRand() * 0.6 });
      pineSpots.push({ x: px + decorRand() * 1.6, z: -38.5 - decorRand() * 3.5, ry: decorRand() * 3, s: 0.85 + decorRand() * 0.6 });
    }
    for (var pz = -33; pz <= 33; pz += 5.2) {
      pineSpots.push({ x: 59 + decorRand() * 3.5, z: pz + decorRand() * 1.6, ry: decorRand() * 3, s: 0.85 + decorRand() * 0.6 });
      pineSpots.push({ x: -59 - decorRand() * 3.5, z: pz + decorRand() * 1.6, ry: decorRand() * 3, s: 0.85 + decorRand() * 0.6 });
    }
    var pines = scatterInstanced(pineGeo, lambert(0xffffff), pineSpots, [new THREE.Color(0x3e5c2e), new THREE.Color(0x4e7a3a)]);
    pines.name = 'treeline'; pines.receiveShadow = false;
    // Mây khối low-poly: mỗi đám = vài khối cầu dẹt gộp 1 mesh, trôi thật trong updateDecor
    cloudMat = new THREE.MeshLambertMaterial({ color: CLOUD_DAY_C.clone(), transparent: true, opacity: 0.92, fog: false });
    for (var ci2 = 0; ci2 < 6; ci2++) {
      var items = [];
      var nBlob = 3 + Math.floor(decorRand() * 2);
      for (var b2 = 0; b2 < nBlob; b2++) {
        items.push({ geo: new THREE.SphereGeometry(1, 7, 6), x: b2 * 1.7 - nBlob * 0.8 + decorRand() * 0.5, y: (decorRand() - 0.5) * 0.4, z: (decorRand() - 0.5) * 1.2, sx: 1.9 + decorRand() * 1.4, sy: 0.75 + decorRand() * 0.35, sz: 1.3 + decorRand() * 0.7 });
      }
      var cm = new THREE.Mesh(mergeGeoms(items), cloudMat);
      cm.position.set(-95 + ci2 * 34 + decorRand() * 12, 25 + decorRand() * 8, -55 + decorRand() * 85);
      cm.name = 'cloud';
      scene.add(cm);
      cloudsArr.push({ mesh: cm, speed: 0.3 + decorRand() * 0.4 });
    }
  })();

  // Trang trí ĐỘNG của map mới + cánh cối xay gió — chạy theo thời gian thật trong vòng lặp.
  function updateDecor(realDt) {
    decorT += realDt;
    for (var i = 0; i < buildingMeshes.length; i++) {
      var b = buildingMeshes[i];
      if (b && b.mesh.userData.bladesNode) b.mesh.userData.bladesNode.rotation.z -= realDt * 1.35; // ~77°/giây, đều
    }
    if (bannerMesh) { bannerMesh.rotation.y = Math.sin(decorT * 2.1) * 0.28; bannerMesh.rotation.x = Math.sin(decorT * 2.9) * 0.05; }
    for (var ci = 0; ci < cloudsArr.length; ci++) {
      var cl = cloudsArr[ci];
      cl.mesh.position.x += cl.speed * realDt;
      if (cl.mesh.position.x > 140) cl.mesh.position.x = -140;
    }
  }
  // Phơi bày cho harness kiểm chứng (chỉ đọc): mây trôi + bộ màu nhuộm ngày–đêm của hồ/mây.
  window.__VRPG_MAP = {
    cloudsX: function () { return cloudsArr.map(function (c) { return Math.round(c.mesh.position.x * 100) / 100; }); },
    tints: function (n) {
      var c1 = new THREE.Color(), c2 = new THREE.Color();
      return { pond: '#' + c1.lerpColors(POND_DAY_C, POND_NIGHT_C, n).getHexString(), cloud: '#' + c2.lerpColors(CLOUD_DAY_C, CLOUD_NIGHT_C, n).getHexString() };
    },
    live: function () {
      return { pond: pondWaterMat ? '#' + pondWaterMat.color.getHexString() : null, cloud: cloudMat ? '#' + cloudMat.color.getHexString() : null };
    }
  };

  /* ================= BuildingSystem: mô hình 3D ================= */
  // Vật liệu cửa sổ Nhà chính DÙNG CHUNG: ban ngày tối, đêm emissive vàng ấm (updateDayNight lerp).
  var townWinMat = new THREE.MeshLambertMaterial({ color: 0x2b2b33, emissive: 0x000000 });
  function makeBuildingMesh(type) {
    var def = D.BUILDINGS[type];
    var g = new THREE.Group();
    var s = def.size;
    g.add(box(s, 0.4, s, 0x9e9e9e, 0, 0.2, 0)); // nền
    if (type === 'townhall') {
      g.add(box(5, 3.2, 4.4, 0x8b5a2b, 0, 2, 0));
      var roof = new THREE.Mesh(new THREE.ConeGeometry(4.2, 2, 4), new THREE.MeshLambertMaterial({ color: 0xffffff, map: roofTex }));
      roof.position.y = 4.6; roof.rotation.y = Math.PI / 4; roof.castShadow = true; g.add(roof);
      g.add(box(0.18, 3, 0.18, 0x5d4037, 0, 6.4, 0));
      g.add(box(1.4, 0.8, 0.06, 0xffca28, 0.75, 7.4, 0)); // cờ vàng
      // 2 ô cửa sổ mặt trước (z+): dùng townWinMat để đêm phát sáng
      var win1 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.9, 0.06), townWinMat);
      win1.position.set(-1.3, 2.3, 2.23); g.add(win1);
      var win2 = win1.clone(); win2.position.x = 1.3; g.add(win2);
    } else if (type === 'house') {
      g.add(box(2.8, 2, 2.6, def.color, 0, 1.4, 0));
      var r2 = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.4, 4), new THREE.MeshLambertMaterial({ color: 0xa1887f }));
      r2.position.y = 3.1; r2.rotation.y = Math.PI / 4; r2.castShadow = true; g.add(r2);
    } else if (type === 'lumber') {
      g.add(box(2.6, 1.6, 2.2, def.color, 0, 1.2, 0));
      for (var li = 0; li < 3; li++) { var log = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 2.2, 6), new THREE.MeshLambertMaterial({ color: 0x8d6e63 })); log.rotation.z = Math.PI / 2; log.position.set(0, 0.5 + li * 0.55, 1.6); g.add(log); }
    } else if (type === 'farm') {
      g.add(box(3.4, 0.25, 3.4, 0x795548, 0, 0.5, 0));
      for (var fx = -1; fx <= 1; fx++) for (var fz = -1; fz <= 1; fz++) { var crop = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.9, 5), new THREE.MeshLambertMaterial({ color: 0x9ccc65 })); crop.position.set(fx * 1.1, 1, fz * 1.1); g.add(crop); }
    } else if (type === 'warehouse') {
      g.add(box(3.2, 2.4, 3, def.color, 0, 1.6, 0));
      g.add(box(3.6, 0.3, 3.4, 0x5d4037, 0, 2.95, 0));
      g.add(box(0.9, 0.9, 0.9, 0xd7ccc8, 1.6, 0.85, 1.2));
    } else if (type === 'barracks') {
      g.add(box(3.6, 2.2, 3, def.color, 0, 1.5, 0));
      var r3 = new THREE.Mesh(new THREE.ConeGeometry(3, 1.3, 4), new THREE.MeshLambertMaterial({ color: 0x4e342e }));
      r3.position.y = 3.2; r3.rotation.y = Math.PI / 4; g.add(r3);
      g.add(box(0.15, 2.6, 0.15, 0x37474f, -2, 1.7, 1.8));
      g.add(box(1.1, 0.65, 0.05, 0x1565c0, -1.45, 2.7, 1.8)); // cờ xanh
    } else if (type === 'forge') {
      g.add(box(2.8, 1.8, 2.6, def.color, 0, 1.3, 0));
      var chim = box(0.6, 2.2, 0.6, 0x455a64, 0.9, 3, -0.7); g.add(chim);
      var fire = new THREE.Mesh(new THREE.SphereGeometry(0.4, 7, 6), new THREE.MeshBasicMaterial({ color: 0xff7043 }));
      fire.position.set(0, 0.9, 1.6); g.add(fire);
      var pl = new THREE.PointLight(0xff7043, 0.9, 8); pl.position.set(0, 1.4, 1.6); g.add(pl);
    } else if (type === 'altar') {
      g.add(box(2.6, 0.8, 2.6, def.color, 0, 0.8, 0));
      var crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.8), new THREE.MeshLambertMaterial({ color: 0xce93d8, emissive: 0x4a148c }));
      crystal.position.y = 2.6; crystal.castShadow = true; g.add(crystal); g.userData.spin = crystal;
      var pl2 = new THREE.PointLight(0xba68c8, 0.8, 9); pl2.position.y = 2.6; g.add(pl2);
    } else if (type === 'darkmine') {
      g.add(box(3, 1.4, 2.6, def.color, 0, 1.1, 0));
      var dk = new THREE.Mesh(new THREE.OctahedronGeometry(0.65), new THREE.MeshLambertMaterial({ color: 0x1a1a2e, emissive: 0x311b92 }));
      dk.position.set(0, 2.4, 0); g.add(dk); g.userData.spin = dk;
      g.add(box(0.25, 2.4, 0.25, 0x263238, -1.2, 1.6, -1));
      g.add(box(0.25, 2.4, 0.25, 0x263238, 1.2, 1.6, -1));
    } else if (type === 'market') { // dự phòng: sạp + mái sọc 2 tông + quầy + đống hàng
      [[-1.8, -1.3], [1.8, -1.3], [-1.8, 1.3], [1.8, 1.3]].forEach(function (pp) { g.add(box(0.16, 2.5, 0.16, 0x5c3a21, pp[0], 1.45, pp[1])); });
      for (var mi2 = 0; mi2 < 4; mi2++) { var slat = box(4.3, 0.09, 0.85, mi2 % 2 ? 0xc89b6c : 0xc96f3b, 0, 2.85, -1.25 + mi2 * 0.83); slat.rotation.x = 0.12; g.add(slat); }
      g.add(box(3.4, 0.85, 0.8, def.color, 0, 0.85, 1.0));
      [[-1.2, 0xc96f3b], [-0.4, 0xd9a441], [0.4, 0x7fa653], [1.2, 0xc0452f]].forEach(function (gd) {
        var pile = new THREE.Mesh(new THREE.SphereGeometry(0.3, 7, 6), new THREE.MeshLambertMaterial({ color: gd[1] }));
        pile.position.set(gd[0], 1.45, 1.0); pile.scale.y = 0.65; g.add(pile);
      });
    } else if (type === 'windmill') { // dự phòng: tháp cụt + nóc + bộ cánh trong Group riêng (xoay được như model thật)
      var tw = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.95, 3.3, 8), new THREE.MeshLambertMaterial({ color: def.color }));
      tw.position.y = 2.05; tw.castShadow = true; g.add(tw);
      var cap = new THREE.Mesh(new THREE.ConeGeometry(0.95, 0.8, 8), new THREE.MeshLambertMaterial({ color: 0xc96f3b }));
      cap.position.y = 4.1; g.add(cap);
      var bladesG = new THREE.Group(); bladesG.position.set(0, 3.35, 0.8); bladesG.userData.fromFallback = true;
      for (var bi = 0; bi < 4; bi++) {
        var arm = box(0.13, 1.6, 0.05, 0x8a5a33, 0, 0, 0);
        var holder = new THREE.Group(); holder.rotation.z = Math.PI / 4 + bi * Math.PI / 2;
        arm.position.y = 0.8;
        var sail = box(0.55, 1.05, 0.03, 0xc89b6c, 0.3, 0.85, 0);
        holder.add(arm); holder.add(sail); bladesG.add(holder);
      }
      g.add(bladesG); g.userData.bladesNode = bladesG;
    } else if (type === 'shrine') { // dự phòng: bệ đá + cột + mái nón + chuông + tinh thể
      g.add(box(2.9, 0.3, 2.9, 0x9a8b78, 0, 0.35, 0));
      [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]].forEach(function (pp) { g.add(box(0.16, 1.4, 0.16, 0x5c3a21, pp[0], 1.2, pp[1])); });
      var srf = new THREE.Mesh(new THREE.ConeGeometry(2.2, 0.9, 4), new THREE.MeshLambertMaterial({ color: 0xc96f3b }));
      srf.position.y = 2.35; srf.rotation.y = Math.PI / 4; g.add(srf);
      g.add(box(0.3, 0.35, 0.3, 0xd9a441, 0, 1.65, 0)); // chuông
      var cry = new THREE.Mesh(new THREE.OctahedronGeometry(0.32), new THREE.MeshLambertMaterial({ color: 0x8e7fb8, emissive: 0x51438a }));
      cry.position.y = 1.05; g.add(cry); g.userData.spin = cry;
    } else if (type === 'tavern') { // dự phòng: nhà + mái + biển + bàn tròn
      g.add(box(3.4, 2.0, 2.8, def.color, 0, 1.4, 0));
      var trf = new THREE.Mesh(new THREE.ConeGeometry(3.1, 1.4, 4), new THREE.MeshLambertMaterial({ color: 0xc96f3b }));
      trf.position.y = 3.1; trf.rotation.y = Math.PI / 4; g.add(trf);
      g.add(box(0.9, 0.55, 0.07, 0xd9a441, 1.6, 2.1, 1.45)); // biển hiệu
      var tt = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.09, 10), new THREE.MeshLambertMaterial({ color: 0x8a5a33 }));
      tt.position.set(-1.1, 0.85, 2.0); g.add(tt);
      g.add(box(0.14, 0.8, 0.14, 0x5c3a21, -1.1, 0.4, 2.0));
    } else if (type === 'library') { // dự phòng: nhà + mái chàm + cửa sổ kệ sách
      g.add(box(3.3, 2.1, 2.7, def.color, 0, 1.45, 0));
      var lrf = new THREE.Mesh(new THREE.ConeGeometry(3.0, 1.3, 4), new THREE.MeshLambertMaterial({ color: 0x546a8a }));
      lrf.position.y = 3.15; lrf.rotation.y = Math.PI / 4; g.add(lrf);
      g.add(box(1.7, 1.15, 0.07, 0x7a4a2b, -0.5, 1.5, 1.36)); // khung cửa sổ kệ sách
      [0xc0452f, 0x546a8a, 0xd9a441, 0x8e7fb8, 0x7fa653].forEach(function (bc, bix) { g.add(box(0.2, 0.55, 0.05, bc, -1.15 + bix * 0.33, 1.42, 1.41)); });
      g.add(box(0.85, 0.45, 0.07, 0xd9a441, 1.25, 2.0, 1.36)); // biển hiệu
    } else if (type === 'watchtower') { // dự phòng: 4 chân chéo + sàn + chòi + đèn
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (pp) {
        var leg = box(0.2, 4.4, 0.2, 0x5c3a21, pp[0] * 1.05, 2.2, pp[1] * 1.05);
        leg.rotation.z = -pp[0] * 0.16; leg.rotation.x = pp[1] * 0.16; g.add(leg);
      });
      g.add(box(2.6, 0.18, 2.6, 0x8a5a33, 0, 4.45, 0));
      g.add(box(1.7, 1.05, 1.7, def.color, -0.25, 5.05, -0.25));
      var wrf = new THREE.Mesh(new THREE.ConeGeometry(1.9, 0.8, 4), new THREE.MeshLambertMaterial({ color: 0xc96f3b }));
      wrf.position.set(-0.25, 5.95, -0.25); wrf.rotation.y = Math.PI / 4; g.add(wrf);
      var lampB = box(0.26, 0.32, 0.26, 0xd9a441, 1.15, 5.15, 1.15); lampB.material.emissive = new THREE.Color(0x85500d); g.add(lampB);
    }
    return g;
  }
  // Khác biệt hình ảnh theo cấp: thân cao dần + dải viền bạc (cấp 2) / vàng (cấp 3)
  function applyLevelVisual(mesh, type, level) {
    mesh.scale.y = 1 + (level - 1) * 0.18;
    if (mesh.userData.tierBand) { mesh.remove(mesh.userData.tierBand); mesh.userData.tierBand = null; }
    if (level >= 2) {
      var def = D.BUILDINGS[type];
      var band = box(def.size + 0.35, 0.28, def.size + 0.35, level >= 3 ? 0xffca28 : 0xb0bec5, 0, 3.1, 0);
      band.castShadow = false;
      mesh.add(band); mesh.userData.tierBand = band;
    }
  }
  function addBuildingMesh(b, idx) {
    var mesh = makeBuildingMesh(b.type);
    mesh.position.set(b.x, 0, b.z);
    mesh.rotation.y = b.rot || 0;
    applyLevelVisual(mesh, b.type, C.buildingLevel(b));
    scene.add(mesh);
    attachModel(mesh, b.type); // xây mới + nạp từ save đều qua đây -> đều được hoán đổi model
    buildingMeshes[idx] = { mesh: mesh, type: b.type, x: b.x, z: b.z, def: D.BUILDINGS[b.type] };
    return mesh;
  }
  // Nhà chính cố định
  var townhallMesh = makeBuildingMesh('townhall'); townhallMesh.position.set(0, 0, 0); scene.add(townhallMesh);
  attachModel(townhallMesh, 'townhall');
  state.buildings.forEach(function (b, idx) { addBuildingMesh(b, idx); });

/* Chu kỳ NGÀY–ĐÊM (runtime, không lưu save): 1 chu kỳ 360s (ngày ~210s, đêm ~150s); dayTime tích lũy bằng realDt, khởi tạo 30s = buổi sáng. */
  var DAY_CYCLE = 360;
  var dayTime = 30;
  var lanternGlow = 0;              // độ sáng đèn lồng hiện tại (ramp mượt khi chập tối)
  var nightToastShown = false;      // toast thơ mộng chỉ 1 lần/phiên
  var dnHudTimer = 0, dnIconCur = '', dnLightTimer = 0, ffTime = 0;
  // Bảng mốc pha: t | trời+sương | nắng (cường độ/màu) | ambient | hemisphere | hệ số đêm 0..1
  var DAY_KEYS = [
    { t: 0.000, sky: 0x9fc7e8, sun: 1.00, sunC: 0xffe3b3, amb: 0.50, hemi: 0.35, night: 0.00 }, // sáng sớm vàng ấm
    { t: 0.250, sky: 0x87b5d6, sun: 1.15, sunC: 0xffffff, amb: 0.55, hemi: 0.35, night: 0.00 }, // trưa trắng
    { t: 0.460, sky: 0x8fb8dd, sun: 1.02, sunC: 0xfff2d9, amb: 0.52, hemi: 0.34, night: 0.00 }, // chiều
    { t: 0.583, sky: 0xe8906a, sun: 0.55, sunC: 0xff8c42, amb: 0.38, hemi: 0.26, night: 0.15 }, // hoàng hôn cam
    { t: 0.660, sky: 0x1b2a4a, sun: 0.06, sunC: 0xff8c42, amb: 0.22, hemi: 0.12, night: 1.00 }, // đêm xuống
    { t: 0.850, sky: 0x101a33, sun: 0.04, sunC: 0xff8c42, amb: 0.20, hemi: 0.11, night: 1.00 }, // đêm sâu
    { t: 0.950, sky: 0x5a6f9e, sun: 0.30, sunC: 0xffd9a0, amb: 0.35, hemi: 0.22, night: 0.35 }  // rạng đông
  ];
  DAY_KEYS.forEach(function (k) { k.skyC = new THREE.Color(k.sky); k.sunCC = new THREE.Color(k.sunC); });
  var _dnSky = new THREE.Color(), _dnSun = new THREE.Color();
  var _dnOut = { sky: _dnSky, sunColor: _dnSun, sun: 0, amb: 0, hemi: 0, night: 0 };
  function dayPhaseAt(t) { // nội suy tuyến tính giữa 2 mốc (đoạn cuối nối vòng về mốc 0 tại t=1)
    var ks = DAY_KEYS, i = 0;
    for (var j = 0; j < ks.length; j++) { if (t >= ks[j].t) i = j; }
    var a = ks[i], b = ks[(i + 1) % ks.length];
    var t1 = (i === ks.length - 1) ? 1 : b.t;
    var f = t1 > a.t ? Math.min(1, Math.max(0, (t - a.t) / (t1 - a.t))) : 0;
    _dnSky.lerpColors(a.skyC, b.skyC, f);
    _dnSun.lerpColors(a.sunCC, b.sunCC, f);
    _dnOut.sun = a.sun + (b.sun - a.sun) * f;
    _dnOut.amb = a.amb + (b.amb - a.amb) * f;
    _dnOut.hemi = a.hemi + (b.hemi - a.hemi) * f;
    _dnOut.night = a.night + (b.night - a.night) * f;
    return _dnOut;
  }
  // Texture phát sáng radial cho sprite đèn lồng/quầng trăng (không có canvas 2D thì null)
  function makeGlowTexture() {
    try {
      var cv = document.createElement('canvas'); cv.width = cv.height = 64;
      var cx = cv.getContext('2d'); if (!cx) return null;
      var gr = cx.createRadialGradient(32, 32, 2, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.35, 'rgba(255,255,255,.55)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      cx.fillStyle = gr; cx.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(cv);
    } catch (e) { return null; }
  }
  var glowTex = makeGlowTexture();
  // --- Mặt trăng + quầng sáng ---
  var moonMat = new THREE.MeshBasicMaterial({ color: 0xe9efff, transparent: true, opacity: 0, fog: false });
  var moonMesh = new THREE.Mesh(new THREE.CircleGeometry(6, 24), moonMat);
  moonMesh.position.set(-80, 72, -95); moonMesh.lookAt(0, 10, 0); scene.add(moonMesh);
  var moonGlowMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xafc4ff, transparent: true, opacity: 0, depthWrite: false, fog: false });
  var moonGlow = new THREE.Sprite(moonGlowMat);
  moonGlow.scale.set(38, 38, 1); moonGlow.position.copy(moonMesh.position); scene.add(moonGlow);
  // --- Sao: ~300 điểm trên vòm, opacity theo độ tối (ngày ẩn / đêm hiện) ---
  var starPos = new Float32Array(300 * 3);
  for (var si = 0; si < 300; si++) {
    var th = (si * 2.39996) % (Math.PI * 2);                 // phân bố đều theo góc vàng, tất định
    var ph = Math.acos(1 - ((si * 37) % 100) / 100 * 0.85);  // từ đỉnh trời xuống ~58° so với đỉnh
    var sr = 118;
    starPos[si * 3] = sr * Math.sin(ph) * Math.cos(th);
    starPos[si * 3 + 1] = sr * Math.cos(ph) * 0.72 + 10;
    starPos[si * 3 + 2] = sr * Math.sin(ph) * Math.sin(th);
  }
  var starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  var starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
  var stars = new THREE.Points(starGeo, starMat); stars.visible = false; scene.add(stars);
  // --- Đèn lồng: sprite phát sáng (additive) + bóng đèn nhỏ tại Nhà chính & mọi công trình đã xây ---
  var lanternGlowMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xffc46b, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  var BULB_OFF = new THREE.Color(0x554422), BULB_ON = new THREE.Color(0xffd9a0);
  var lanternBulbMat = new THREE.MeshBasicMaterial({ color: 0x554422 });
  var lanterns = [], lanternSyncInit = false;
  function makeLantern(x, z, y) {
    var grp = new THREE.Group(); grp.position.set(x, y, z);
    var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), lanternBulbMat); grp.add(bulb);
    var spr = new THREE.Sprite(lanternGlowMat); spr.scale.set(2.6, 2.6, 1); grp.add(spr);
    scene.add(grp);
    lanterns.push({ x: x, z: z, y: y });
  }
  function syncLanterns() { // chạy lúc khởi tạo + định kỳ: công trình xây mới sẽ tự có đèn
    if (!lanternSyncInit) { lanternSyncInit = true; var ts = D.BUILDINGS.townhall.size || 4; makeLantern(ts / 2 + 0.6, ts / 2 + 0.6, 3.2); }
    if (typeof pendingLampPosts !== 'undefined' && pendingLampPosts.length) { // cột đèn đường của map mới (đăng ký từ khối map)
      pendingLampPosts.forEach(function (lp) { makeLantern(lp[0], lp[1], lp[2]); });
      pendingLampPosts = [];
    }
    buildingMeshes.forEach(function (b) {
      if (b && !b.__lantern) { b.__lantern = true; var s = (b.def && b.def.size) || 3; makeLantern(b.x + s / 2 + 0.6, b.z + s / 2 + 0.6, 3.0); }
    });
  }
  syncLanterns();
  // Pool 4 PointLight thật, gán động cho 4 đèn lồng gần player nhất.
  var lanternLights = [];
  for (var li2 = 0; li2 < 4; li2++) { var lpl = new THREE.PointLight(0xffb45e, 0, 13); scene.add(lpl); lanternLights.push(lpl); }
  // --- Đom đóm: ~60 hạt bay quanh cây gần làng, chỉ sống về đêm ---
  var FIREFLY_N = 60;
  var fireflyBase = [], fireflyPhase = [];
  var ffPos = new Float32Array(FIREFLY_N * 3);
  var villageTrees = trees.filter(function (tr) { return tr.x <= 26; });
  for (var fi = 0; fi < FIREFLY_N; fi++) {
    var bt = villageTrees.length ? villageTrees[fi % villageTrees.length] : { x: -8, z: 6 };
    var bang = rand() * Math.PI * 2, brad = 1.5 + rand() * 3;
    fireflyBase.push({ x: bt.x + Math.cos(bang) * brad, y: 0.8 + rand() * 1.5, z: bt.z + Math.sin(bang) * brad });
    fireflyPhase.push(rand() * Math.PI * 2);
  }
  var ffGeo = new THREE.BufferGeometry();
  ffGeo.setAttribute('position', new THREE.Float32BufferAttribute(ffPos, 3));
  var ffMat = new THREE.PointsMaterial({ color: 0xc6ff6b, size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  var fireflies = new THREE.Points(ffGeo, ffMat); fireflies.visible = false; scene.add(fireflies);
  // Mắt quái: vàng ban ngày -> đỏ phát sáng ban đêm
  var EYE_DAY = new THREE.Color(0xffeb3b), EYE_NIGHT = new THREE.Color(0xff2020);
  var WIN_OFF = new THREE.Color(0x000000), WIN_ON = new THREE.Color(0xd98a2b);
  function dnIconFor(t) {
    if (t < 0.14) return '🌅';
    if (t < 0.44) return '☀️';
    if (t < 0.60) return '🌇';
    if (t < 0.93) return '🌙';
    return '🌅';
  }
  function updateDayNight(realDt) {
    if (started) dayTime += realDt * settings.daySpeed; // tốc độ chu kỳ ngày–đêm (Cài đặt: 0.5x/1x/2x) — chỉ nhân đồng hồ thế giới, không đụng save
    var t = (dayTime % DAY_CYCLE) / DAY_CYCLE;
    var ph = dayPhaseAt(t);
    var n = ph.night;
    // Bầu trời + sương mù cùng màu (nền panorama vòng trụ sẽ tự tối đi theo n ở dưới)
    scene.background.copy(ph.sky);
    if (scene.fog && scene.fog.color) scene.fog.color.copy(ph.sky);
    // Mặt trời: cường độ/màu theo mốc + chạy theo cung trên trời (lặn hẳn sau hoàng hôn)
    sun.intensity = ph.sun;
    sun.color.copy(ph.sunColor);
    var ang = Math.PI * Math.min(1.18, t / 0.583);
    sun.position.set(-Math.cos(ang) * 55, Math.sin(ang) * 52 + 3, 24);
    ambLight.intensity = ph.amb;
    hemiLight.intensity = ph.hemi;
    // Đêm: trăng + đèn trăng lạnh + sao (sao/đom đóm chịu toggle "Hạt hiệu ứng" fxParticles)
    moonLight.intensity = 0.30 * n;
    moonMat.opacity = n;
    moonGlowMat.opacity = 0.5 * n;
    starMat.opacity = fxOn('fxParticles') ? 0.9 * n : 0;
    stars.visible = starMat.opacity > 0.01;
    if (typeof panoMesh !== 'undefined' && panoMesh && panoMesh.material) {
      panoMesh.material.color.setRGB(1 - 0.75 * n, 1 - 0.70 * n, 1 - 0.50 * n); // vòng trụ tối xanh theo đêm
    }
    // Đèn lồng: thắp khi hệ số đêm > 0.2, độ sáng ramp mượt.
    var target = n <= 0.2 ? 0 : Math.min(1, (n - 0.2) / 0.5);
    lanternGlow += (target - lanternGlow) * Math.min(1, realDt * 1.6);
    if (Math.abs(target - lanternGlow) < 0.002) lanternGlow = target;
    lanternGlowMat.opacity = 0.85 * lanternGlow * (0.92 + 0.08 * Math.sin(dayTime * 9)); // nhấp nháy rất nhẹ
    lanternBulbMat.color.lerpColors(BULB_OFF, BULB_ON, lanternGlow);
    townWinMat.emissive.lerpColors(WIN_OFF, WIN_ON, lanternGlow); // cửa sổ Nhà chính sáng vàng về đêm
    dnLightTimer += realDt;
    if (dnLightTimer > 1) { dnLightTimer = 0; syncLanterns(); } // công trình xây mới tự có đèn sau tối đa 1s
    // Gán pool 4 PointLight cho 4 đèn lồng gần player nhất
    var pp = player.group.position;
    var sorted = lanterns.slice().sort(function (a, b) {
      var da = (a.x - pp.x) * (a.x - pp.x) + (a.z - pp.z) * (a.z - pp.z);
      var db = (b.x - pp.x) * (b.x - pp.x) + (b.z - pp.z) * (b.z - pp.z);
      return da - db;
    });
    for (var li3 = 0; li3 < lanternLights.length; li3++) {
      var L = lanternLights[li3], s = sorted[li3];
      if (s && lanternGlow > 0.02) { L.position.set(s.x, s.y, s.z); L.intensity = 1.15 * lanternGlow; }
      else L.intensity = 0;
    }
    if (campfireLight) campfireLight.intensity = 1.05 + Math.sin(dayTime * 11) * 0.16 + Math.sin(dayTime * 23.7) * 0.1; // lửa trại trang trí nhấp nháy
    // Map mới: mặt hồ + mây nhuộm theo hệ số đêm (cùng hằng số lerp mà __VRPG_MAP.tints công bố)
    if (pondWaterMat) pondWaterMat.color.lerpColors(POND_DAY_C, POND_NIGHT_C, n);
    if (cloudMat) cloudMat.color.lerpColors(CLOUD_DAY_C, CLOUD_NIGHT_C, n);
    // Đom đóm: chỉ khi đêm đủ tối + toggle hạt đang bật; bay lượn sin rẻ tiền quanh gốc cây
    var ffOn = n > 0.45 && fxOn('fxParticles');
    fireflies.visible = !!ffOn;
    if (ffOn) {
      ffTime += realDt;
      ffMat.opacity = Math.min(0.95, (n - 0.45) / 0.25);
      var arr = ffGeo.attributes.position.array;
      for (var fj = 0; fj < FIREFLY_N; fj++) {
        var fb = fireflyBase[fj], fp2 = fireflyPhase[fj];
        arr[fj * 3] = fb.x + Math.sin(ffTime * 0.6 + fp2) * 1.3;
        arr[fj * 3 + 1] = fb.y + Math.sin(ffTime * 0.9 + fp2 * 1.7) * 0.45;
        arr[fj * 3 + 2] = fb.z + Math.cos(ffTime * 0.5 + fp2 * 0.6) * 1.3;
      }
      ffGeo.attributes.position.needsUpdate = true;
    }
    // Mắt quái phát sáng đỏ dần theo đêm
    for (var ei = 0; ei < enemyEyeMats.length; ei++) enemyEyeMats[ei].color.lerpColors(EYE_DAY, EYE_NIGHT, n);
    // Khoảnh khắc bất ngờ: hoàng hôn -> đêm LẦN ĐẦU mỗi phiên, chỉ toast 1 lần
    if (started && !nightToastShown && t >= 0.64 && t < 0.9) {
      nightToastShown = true;
      toast('🌙 Đêm xuống — làng thắp đèn, đom đóm về quanh rừng…');
    }
    // HUD đồng hồ thế giới (cập nhật ~5 lần/giây cho nhẹ DOM)
    dnHudTimer += realDt;
    if (dnHudTimer > 0.2) {
      dnHudTimer = 0;
      var icon = dnIconFor(t);
      if (icon !== dnIconCur) { dnIconCur = icon; var icEl = $('dn-icon'); if (icEl) icEl.textContent = icon; }
      var flEl = $('dn-fill'); if (flEl) flEl.style.width = Math.round(t * 100) + '%';
    }
  }
  // Phơi bày cho harness kiểm chứng (chỉ đọc): tính pha + trạng thái runtime của chu kỳ
  window.__VRPG_DAYNIGHT = { phaseAt: dayPhaseAt, keys: DAY_KEYS, cycle: DAY_CYCLE,
    state: function () { return { dayTime: dayTime, lanternGlow: lanternGlow, lanterns: lanterns.length, poolLights: lanternLights.length }; } };
  // Phơi bày cho harness kiểm chứng (chỉ đọc): vị trí node gameplay + thống kê cảnh
  // (số đối tượng render được ~ draw call, tổng tris gồm cả InstancedMesh x số instance).
  window.__VRPG_WORLD = {
    scene: function () { return scene; },
    nodes: function () {
      return {
        trees: trees.map(function (t) { return [t.x, t.z]; }),
        rocks: rocks.map(function (r) { return [r.x, r.z, r.dark ? 1 : 0]; }),
        bushes: bushes.map(function (b) { return [b.x, b.z]; })
      };
    },
    stats: function () {
      var calls = 0, tris = 0;
      scene.traverse(function (o) {
        if (o.isMesh) {
          calls++;
          var g = o.geometry;
          if (g) {
            var n = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
            tris += (n / 3) * (o.isInstancedMesh ? (o.count || 1) : 1);
          }
        } else if (o.isPoints || o.isSprite) calls++;
      });
      return { calls: calls, tris: Math.round(tris) };
    }
  };

  /* ================= Flash trắng khi bị đánh (Mục 1) ================= */
  function flashEntity(group) {
    if (!fxOn('fxFlash') || !group) return;
    var mats = [];
    group.traverse(function (o) {
      if (o.isMesh && o.material && o.material.emissive && !o.material.userData.__flashing) {
        o.material.userData.__flashing = true;
        mats.push({ m: o.material, e: o.material.emissive.getHex() });
        o.material.emissive.setHex(0xffffff);
      }
    });
    if (mats.length) flashList.push({ mats: mats, t: 0.09 });
  }
  function updateFlashes(dt) {
    for (var i = flashList.length - 1; i >= 0; i--) {
      var f = flashList[i]; f.t -= dt;
      if (f.t <= 0) {
        f.mats.forEach(function (it) { it.m.emissive.setHex(it.e); it.m.userData.__flashing = false; });
        flashList.splice(i, 1);
      }
    }
  }

  /* ================= NPC Trưởng làng ================= */
  function makeHumanoid(bodyColor, headColor) {
    var g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.44, 1.05, 8), new THREE.MeshLambertMaterial({ color: bodyColor }));
    body.position.y = 0.95; body.castShadow = true; g.add(body);
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), new THREE.MeshLambertMaterial({ color: headColor || 0xf1c27d }));
    head.position.y = 1.85; head.castShadow = true; g.add(head);
    return g;
  }
  var elder = { group: makeHumanoid(0x6d4c41), x: 4, z: 4.5, name: 'Trưởng làng' };
  elder.group.position.set(elder.x, 0, elder.z);
  scene.add(elder.group);

  /* ================= PlayerController ================= */
  player.group = makeHumanoid(0x1565c0);
  var swordMesh = box(0.09, 1.0, 0.2, 0xcfd8dc, 0.55, 1.15, 0.15); player.group.add(swordMesh);
  player.group.position.set(state.player.x || -6, 0, state.player.z || 6);
  scene.add(player.group);
  attachModel(player.group, 'player', { keep: [swordMesh] }); // giữ kiếm vung thật; kiếm trang trí của model đã ẩn trong MODEL_DEFS

  function levelBonus() { var l = state.player.level - 1; return { maxHp: l * 12, maxEnergy: l * 3, str: l * 2, int: l * 2, agi: l * 2, armor: 0, resist: 0 }; }
  function getStats() {
    var s = C.computeStats(C.equippedIds(state));
    var b = levelBonus();
    for (var k in b) s[k] = (s[k] || 0) + b[k];
    return s;
  }
  function xpNeed() { return 80 * state.player.level; }
  player.hp = getStats().maxHp; player.energy = getStats().maxEnergy;

  camFocus = new THREE.Vector3(state.player.x || -6, 0, state.player.z || 6);
  function effCamDist() {
    var d = buildMode.active ? Math.max(camDist, 14) : camDist; // build mode: nhìn bao quát
    return Math.min(d, occlDist);
  }
  function effCamPitch() { return buildMode.active ? Math.max(camPitch, 0.95) : camPitch; }
  var occlRay = new THREE.Raycaster();
  function updateOcclusion() {
    // Giản lược: chỉ xét Nhà chính + công trình đã xây (không xét cây/đá), chạy mỗi 6 frame.
    try { updateOcclusionInner(); } catch (e) { occlDist = 99; } // occlusion lỗi -> camera dùng khoảng cách thường, không bao giờ để chết vòng lặp
  }
  function updateOcclusionInner() {
    var p = player.group.position;
    var origin = new THREE.Vector3(p.x, p.y + 1.6, p.z);
    var pitch = effCamPitch(), dist = buildMode.active ? Math.max(camDist, 14) : camDist;
    var dir = new THREE.Vector3(-Math.sin(camYaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(camYaw) * Math.cos(pitch));
    occlRay.set(origin, dir.normalize(), 0.1, dist);
    var meshes = [townhallMesh];
    buildingMeshes.forEach(function (b) { if (b) meshes.push(b.mesh); });
    var hits = occlRay.intersectObjects(meshes, true);
    occlDist = hits.length ? Math.max(3.5, hits[0].distance - 0.7) : 99;
  }
  var CameraController = {
    update: function (dt) {
      var p = player.group.position;
      // Deadzone mềm: camera bám điểm nhìn + look-ahead bằng lerp chậm
      var wantX = p.x + playerLookAhead.x, wantZ = p.z + playerLookAhead.z;
      var k = 1 - Math.pow(0.001, dt);
      camFocus.x += (wantX - camFocus.x) * k;
      camFocus.z += (wantZ - camFocus.z) * k;
      var dist = effCamDist(), pitch = effCamPitch();
      var tx = camFocus.x - Math.sin(camYaw) * Math.cos(pitch) * dist;
      var tz = camFocus.z - Math.cos(camYaw) * Math.cos(pitch) * dist;
      var ty = p.y + 1.7 + Math.sin(pitch) * dist;
      camera.position.lerp(new THREE.Vector3(tx, Math.max(1.2, ty), tz), 1 - Math.pow(0.0001, dt));
      // Trauma shake: chỉ dời CAMERA (không đụng vật lý/va chạm), tự tắt khi trauma về 0
      if (trauma > 0.01 && fxOn('fxShake')) {
        shakeTime += dt * 30;
        var sh = trauma * trauma;
        camera.position.x += 0.38 * sh * Math.sin(shakeTime * 1.7);
        camera.position.y += 0.26 * sh * Math.sin(shakeTime * 2.3);
        trauma = Math.max(0, trauma - 1.4 * dt);
      }
      camera.lookAt(camFocus.x, p.y + 1.6, camFocus.z);
    }
  };

  function dist2d(ax, az, bx, bz) { var dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); }
  function clampWorld(v) { return Math.max(-58, Math.min(58, v[0])), v; }
  function collide(pos, radius) {
    // va chạm đơn giản: đẩy ra khỏi nhà chính, công trình, cây, đá
    var solids = [{ x: 0, z: 0, r: 3.4 }];
    buildingMeshes.forEach(function (b) { if (b) solids.push({ x: b.x, z: b.z, r: b.def.size / 2 + 0.3 }); });
    trees.forEach(function (t) { if (t.charges > 0) solids.push({ x: t.x, z: t.z, r: 0.8 }); });
    rocks.forEach(function (r) { if (r.charges > 0) solids.push({ x: r.x, z: r.z, r: 1 }); });
    solids.forEach(function (s) {
      var d = dist2d(pos.x, pos.z, s.x, s.z), min = s.r + radius;
      if (d > 0.001 && d < min) { var push = (min - d); pos.x += (pos.x - s.x) / d * push; pos.z += (pos.z - s.z) / d * push; }
    });
    pos.x = Math.max(-60, Math.min(60, pos.x));
    pos.z = Math.max(-40, Math.min(40, pos.z));
  }

  var touchMove = { x: 0, z: 0, active: false };
  function updatePlayer(dt) {
    if (player.dead) return;
    var mx = 0, mz = 0;
    if (keys['KeyW'] || keys['ArrowUp']) mz += 1; if (keys['KeyS'] || keys['ArrowDown']) mz -= 1;
    if (keys['KeyA'] || keys['ArrowLeft']) mx -= 1; if (keys['KeyD'] || keys['ArrowRight']) mx += 1;
    if (touchMove.active) { mx += touchMove.x; mz += touchMove.z; }
    var len = Math.sqrt(mx * mx + mz * mz);
    var speed = (keys['ShiftLeft'] || keys['ShiftRight']) ? 9 : 5.4;
    if (len > 0.01) {
      mx /= Math.max(1, len); mz /= Math.max(1, len);
      // hướng theo camera: forward = (sin, cos) cùng dấu với view direction
      var fx = Math.sin(camYaw), fz = Math.cos(camYaw);
      var rx = -fz, rz = fx;
      var wx = fx * mz + rx * mx, wz = fz * mz + rz * mx;
      player.group.position.x += wx * speed * dt;
      player.group.position.z += wz * speed * dt;
      player.yaw = Math.atan2(wx, wz);
      player.group.rotation.y = player.yaw;
      // Look-ahead: điểm nhìn lệch tối đa ~2.2 đơn vị theo hướng di chuyển, mượt dần
      var laK = Math.min(1, dt * 4);
      playerLookAhead.x += ((wx / speed) * 2.2 - playerLookAhead.x) * laK;
      playerLookAhead.z += ((wz / speed) * 2.2 - playerLookAhead.z) * laK;
      collide(player.group.position, 0.55);
      // Bob nhẹ khi đi — CHỈ khi chưa có model khớp; đã có khớp thì pose tự nhún
      // (updateEntityAnim ghi position.y ở cuối hàm này) để tránh nhún kép.
      if (!player.group.userData.parts) player.group.position.y = Math.abs(Math.sin(gameTime * 9)) * 0.06;
    } else {
      if (!player.group.userData.parts) player.group.position.y = 0;
      playerLookAhead.x *= Math.max(0, 1 - dt * 4); playerLookAhead.z *= Math.max(0, 1 - dt * 4); // đứng yên -> look-ahead tan dần
    }
    // Hồi năng lượng + máu ngoài giao tranh
    var st = getStats();
    player.energy = Math.min(st.maxEnergy, player.energy + 5 * dt);
    if (gameTime - player.lastCombatAt > 5) player.hp = Math.min(st.maxHp, player.hp + 2.5 * dt);
    // Quán ăn: đứng trong bán kính quán gần nhất -> hồi HP + EN dần (số liệu ở core.tavernRegenAt)
    var trg = C.tavernRegenAt(state, player.group.position.x, player.group.position.z);
    if (trg) {
      player.hp = Math.min(st.maxHp, player.hp + trg.hpPerSec * dt);
      player.energy = Math.min(st.maxEnergy, player.energy + trg.enPerSec * dt);
    }
    // Vào khu nguy hiểm lần đầu
    if (!state.flags.enteredDanger && player.group.position.x > 31) {
      state.flags.enteredDanger = true; log('⚠️ Bạn đã vào Khu Sương Mù!'); checkQuests(); SaveSystem.save();
    }
    updateEntityAnim(player, dt, 9); // khớp nhân vật (no-op khi chưa có model)
  }

  /* ================= Particle POOL (Mục 6, theo performance_optimization) =================
     Pool cố định 40 hạt, tái dùng mesh; tắt bằng toggle fxParticles trong panel ❓. */
  var PARTICLE_POOL_MAX = 40;
  var particlePool = [], particlesActive = [];
  var particleGeo = new THREE.SphereGeometry(0.09, 6, 5);
  function spawnParticle(pos, color, vel, life, scale) {
    if (!settings.particles) return; // hạt chiến đấu — toggle riêng trong Cài đặt (không còn gộp với sao/đom đóm)
    var pt = particlePool.pop();
    if (!pt) {
      if (particlesActive.length >= PARTICLE_POOL_MAX) return; // pool đầy -> bỏ hạt mới, không cấp phát thêm
      pt = { mesh: new THREE.Mesh(particleGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true })) };
    }
    pt.mesh.material.color.setHex(color);
    pt.mesh.material.opacity = 0.9;
    pt.mesh.scale.setScalar(scale || 1);
    pt.mesh.position.set(pos.x, pos.y !== undefined ? pos.y : 1.2, pos.z);
    pt.vel = vel; pt.life = life; pt.maxLife = life;
    scene.add(pt.mesh);
    particlesActive.push(pt);
  }
  function burstParticles(pos, color, n, speed, life, scale) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, b = Math.random() - 0.3;
      spawnParticle(pos, color, new THREE.Vector3(Math.cos(a) * speed * Math.random(), b * speed, Math.sin(a) * speed * Math.random()), life * (0.6 + Math.random() * 0.7), scale);
    }
  }
  function updateParticles(dt) {
    for (var i = particlesActive.length - 1; i >= 0; i--) {
      var pt = particlesActive[i];
      pt.life -= dt;
      if (pt.life <= 0) { scene.remove(pt.mesh); particlesActive.splice(i, 1); particlePool.push(pt); continue; }
      pt.mesh.position.x += pt.vel.x * dt; pt.mesh.position.y += pt.vel.y * dt; pt.mesh.position.z += pt.vel.z * dt;
      pt.vel.y -= 2.5 * dt;
      pt.mesh.material.opacity = 0.9 * (pt.life / pt.maxLife);
    }
  }

  /* ================= EnemyAI ================= */
  var enemyEyeMats = []; // vật liệu mắt của mọi quái đã spawn — updateDayNight lerp vàng (ngày) -> đỏ (đêm)
  function makeEnemyMesh(def) {
    var g = new THREE.Group();
    var s = def.scale;
    var body = new THREE.Mesh(new THREE.SphereGeometry(0.75 * s, 10, 8), new THREE.MeshLambertMaterial({ color: def.color }));
    body.position.y = 0.85 * s; body.castShadow = true; g.add(body);
    var eye = new THREE.Mesh(new THREE.SphereGeometry(0.13 * s, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffeb3b }));
    enemyEyeMats.push(eye.material); // eye2 clone dùng chung material này nên chỉ cần đăng ký 1 lần
    eye.position.set(0.3 * s, 1.05 * s, 0.55 * s); g.add(eye);
    var eye2 = eye.clone(); eye2.position.x = -0.3 * s; g.add(eye2);
    if (def.kind === 'ranged') { var bow = box(0.08, 1.1 * s, 0.08, 0x4e342e, 0.8 * s, 1 * s, 0.3); g.add(bow); }
    if (def.kind === 'boss') {
      var horn = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.9, 5), new THREE.MeshLambertMaterial({ color: 0x212121 }));
      horn.position.set(0.5, 1.95 * s / 1.4, 0); horn.rotation.z = -0.4; g.add(horn);
      var horn2 = horn.clone(); horn2.position.x = -0.5; horn2.rotation.z = 0.4; g.add(horn2);
    }
    var bar = makeHpBar(1.7 * s); bar.position.y = 1.95 * s; g.add(bar);
    g.userData.bar = bar;
    return g;
  }
  function spawnEnemy(typeId, x, z) {
    var def = D.ENEMIES[typeId];
    var g = makeEnemyMesh(def);
    g.position.set(x, 0, z);
    scene.add(g);
    var e = { type: typeId, def: def, group: g, hp: def.hp, maxHp: def.hp, x: x, z: z, atkCd: 0, telegraphCd: 4, alive: true, marked: false };
    enemies.push(e);
    // Boss 1 (boss) và thú sự kiện (beast) KHÔNG có model riêng -> giữ nguyên hình hộp/cầu hiện tại.
    if (typeId === 'goblin') attachModel(g, 'goblin', { scale: MODEL_DEFS.goblin.scale * def.scale });
    else if (typeId === 'archer') attachModel(g, 'goblin_archer', { scale: MODEL_DEFS.goblin_archer.scale * def.scale });
    else if (typeId === 'boss2') attachModel(g, 'boss_fog', { scale: MODEL_DEFS.boss_fog.scale * def.scale });
    return e;
  }
  function spawnWave() {
    spawnEnemy('goblin', 40, -8); spawnEnemy('goblin', 43, 6); spawnEnemy('goblin', 38, 14);
    spawnEnemy('archer', 46, -14); spawnEnemy('archer', 48, 10);
    spawnEnemy('goblin', 50, -2);
  }
  var bossRef = null, boss2Ref = null;
  function spawnBoss() {
    if (state.flags.bossKilled) return;
    bossRef = spawnEnemy('boss', 54, 0);
    log('👹 Chúa Tể Sương Mù đang chờ ở cuối khu nguy hiểm!');
  }
  function spawnBoss2() {
    if (state.flags.boss2Killed || boss2Ref) return;
    boss2Ref = spawnEnemy('boss2', 56, -8);
    log('❄️ SƯƠNG VƯƠNG đã xuất hiện ở cuối Khu Sương Mù — mạnh hơn Chúa Tể, né vòng đỏ nhanh hơn!');
  }
  spawnWave(); spawnBoss();
  loadModel('companion'); loadModel('boss_fog'); // nạp trước 2 loại xuất hiện muộn (chiêu mộ / Boss 2) để tới lúc spawn đã có model
  if (state.flags.bossKilled && !state.flags.boss2Killed) spawnBoss2(); // save cũ đã hạ boss 1 -> boss 2 chờ sẵn

  // Tổng hiệu ứng đá trên MỌI kỹ năng (aura/phản đòn lấy giá trị lớn nhất)
  function gemModTotal(keyName) {
    var best = 0;
    for (var sid in state.socketed) {
      var m = C.applyGems(sid, state.socketed[sid] || []);
      if (m[keyName]) best = Math.max(best, m[keyName]);
    }
    return best;
  }
  function damageEnemy(e, amount, opts) {
    if (!e.alive) return;
    opts = opts || {};
    e.hp -= amount;
    player.lastCombatAt = gameTime;
    markedTarget = e;
    setHpBar(e.group.userData.bar, e.hp / e.maxHp);
    flashEntity(e.group);                                   // Mục 1: chớp trắng
    triggerAnim(e, 'hit');
    addTrauma(opts.crit ? 0.22 : 0.1);                      // Mục 1: rung nhẹ khi đánh trúng
    if (opts.crit) hitStop(0.08);                           // Mục 1: hit-stop 80ms khi chí mạng
    if (opts.lifesteal) {
      var healed = amount * opts.lifesteal;
      player.hp = Math.min(getStats().maxHp, player.hp + healed);
      healFloatAcc += healed;                               // gộp số nổi hồi máu (hiện tối đa 1 dòng/0.35s ở vòng lặp)
    }
    if (opts.energyOnHit) player.energy = Math.min(getStats().maxEnergy, player.energy + opts.energyOnHit); // Đá Hồi Năng Lượng
    spawnFloatText(e.group.position, Math.round(amount) + (opts.crit ? '!' : ''), opts.crit ? '#ffd54f' : '#ffffff');
    if (e.hp <= 0) killEnemy(e);
  }
  function randomInRange(r) { return r[0] + Math.floor(Math.random() * (r[1] - r[0] + 1)); }
  function killEnemy(e) {
    e.alive = false;
    hitStop(e.def.kind === 'boss' ? 0.12 : 0.1);            // Mục 1: hit-stop khi hạ gục (boss 120ms)
    addTrauma(e.def.kind === 'boss' ? 0.5 : 0.3);
    burstParticles(e.group.position, 0xffab40, e.def.kind === 'boss' ? 16 : 8, 3, 0.5, 1.2);
    scene.remove(e.group);
    if (markedTarget === e) markedTarget = null;
    state.stats.monstersKilled++;
    var gainXp = C.xpGainFor(state, e.def.xp); // điểm cộng XP DUY NHẤT — đi qua hệ số Nhà học (core)
    state.player.xp += gainXp;
    var drops = {};
    for (var k in e.def.drops) drops[k] = randomInRange(e.def.drops[k]);
    C.add(state.resources, drops);
    if (drops.food) state.stats.foodGained += drops.food;
    var dropTxt = Object.keys(drops).filter(function (k) { return drops[k] > 0; }).map(function (k) { return '+' + drops[k] + ' ' + D.RESOURCE_NAMES[k]; }).join(', ');
    log('💀 Hạ ' + e.def.name + ' +' + gainXp + ' XP' + (dropTxt ? ' · ' + dropTxt : ''));
    // Rơi trang bị
    var dropChance = (e.type === 'boss' || e.type === 'boss2') ? 1 : (e.type === 'archer' ? 0.25 : 0.16);
    if (Math.random() < dropChance) {
      var itemId = e.type === 'boss' ? 'dark_amulet' : C.rollLoot(Math.random, state); // quay loot qua trọng số Đền thờ (core)
      if (state.inventory.indexOf(itemId) === -1 && C.countItemEverywhere(state, itemId) === 0 || e.type !== 'boss') {
        state.inventory.push(itemId);
        toast('🎁 Rơi trang bị: ' + D.ITEMS[itemId].name + ' (' + D.RARITY_NAMES[D.ITEMS[itemId].rarity] + ')');
      }
    }
    if (e.type === 'boss') {
      state.flags.bossKilled = true; bossRef = null;
      toast('🏆 ĐÃ HẠ BOSS! Về gặp Trưởng làng để mở khóa Đài kỹ năng. Nhưng sương mù vẫn chưa tan…');
      setTimeout(function () { spawnWave(); spawnBoss2(); }, 5000);
    } else if (e.type === 'boss2') {
      state.flags.boss2Killed = true; boss2Ref = null;
      toast('❄️🏆 ĐÃ HẠ SƯƠNG VƯƠNG! Phần thưởng lớn đang chờ — về làng nâng cấp công trình nào.');
    } else if (e.type === 'beast') {
      onBeastKilled(); // event Thú hoang: không hồi sinh, đếm để trao thưởng (Mục 5)
    } else {
      // Hồi sinh quái thường sau 25 giây để còn cái mà farm
      setTimeout(function () { if (started) { var ne = spawnEnemy(e.type, 38 + Math.random() * 16, -20 + Math.random() * 40); } }, 25000);
    }
    while (state.player.xp >= xpNeed()) {
      state.player.xp -= xpNeed(); state.player.level++;
      player.hp = getStats().maxHp;
      toast('⭐ LÊN CẤP ' + state.player.level + '! Chỉ số tăng, hồi đầy máu.');
    }
    checkQuests(); SaveSystem.save();
    updateHUD();
  }
  function updateEnemies(dt) {
    enemies.forEach(function (e) {
      if (!e.alive) return;
      var p = player.group.position;
      e.group.userData.bar.lookAt(camera.position);
      // chọn mục tiêu: người chơi hoặc đồng đội gần hơn
      var target = { x: p.x, z: p.z, isPlayer: true, ref: player };
      var bestD = dist2d(e.group.position.x, e.group.position.z, p.x, p.z);
      companions.forEach(function (cp) {
        if (!cp.alive) return;
        var d = dist2d(e.group.position.x, e.group.position.z, cp.group.position.x, cp.group.position.z);
        if (d < bestD) { bestD = d; target = { x: cp.group.position.x, z: cp.group.position.z, isPlayer: false, ref: cp }; }
      });
      var d = bestD;
      e.atkCd -= dt;
      // Làm chậm: lấy giá trị LỚN NHẤT giữa Đá Sương Giá (đã gán lên quái) và vùng Tháp canh — không cộng dồn.
      var gemSlow = (e.slowUntil && gameTime < e.slowUntil) ? (e.slowPct || 0) : 0;
      var slowEff = Math.max(gemSlow, C.watchtowerSlowAt(state, e.group.position.x, e.group.position.z));
      var spd = e.def.speed * (1 - slowEff);
      if (d > e.def.range) {
        if (d < 30) { // chỉ đuổi trong tầm cảm nhận 30
          var dx = target.x - e.group.position.x, dz = target.z - e.group.position.z;
          var l = Math.sqrt(dx * dx + dz * dz) || 1;
          e.group.position.x += dx / l * spd * dt;
          e.group.position.z += dz / l * spd * dt;
          e.group.rotation.y = Math.atan2(dx, dz);
        }
      } else if (e.atkCd <= 0 && !player.dead) {
        e.atkCd = e.def.cooldown;
        triggerAnim(e, 'attack'); // vung tay đúng thời điểm ra đòn (tầm xa: archer kéo dây)
        if (e.def.kind === 'ranged') {
          shootProjectile(e.group.position, target, e.def.dmg, true, e.def.projectileSpeed);
        } else if (target.isPlayer) {
          hurtPlayer(C.calcIncomingDamage(e.def.dmg, getStats(), 'physical'), e.def.name, e);
        } else {
          hurtCompanion(target.ref, e.def.dmg);
        }
      }
      // Boss: đòn diện rộng có báo hiệu (vòng đỏ)
      if (e.def.kind === 'boss') {
        e.telegraphCd -= dt;
        var dp = dist2d(e.group.position.x, e.group.position.z, p.x, p.z);
        if (e.telegraphCd <= 0 && dp < 15 && !player.dead) {
          e.telegraphCd = e.def.telegraph.every;
          startTelegraph(p.x, p.z, e.def.telegraph, e);
        }
        var bw = document.getElementById('boss-bar-wrap');
        if (dp < 22) { bw.classList.remove('hidden'); document.getElementById('boss-name').textContent = '👹 ' + e.def.name; document.getElementById('bar-boss').style.width = (e.hp / e.maxHp * 100) + '%';
          var bpImg = document.getElementById('boss-portrait');
          if (bpImg) { var wantSrc = e.def.id === 'boss2' ? 'img/p-boss2.jpg' : 'img/p-boss1.jpg'; if (bpImg.getAttribute('src') !== wantSrc) { bpImg.style.display = ''; bpImg.src = wantSrc; } }
        }
        else bw.classList.add('hidden');
      }
    });
    enemies = enemies.filter(function (e) { return e.alive; });
    if (bossRef && !bossRef.alive) bossRef = null;
    if (boss2Ref && !boss2Ref.alive) boss2Ref = null;
    enemies.forEach(function (e) { updateEntityAnim(e, dt, Math.max(1, (e.def && e.def.speed) || 3)); });
  }
  function startTelegraph(x, z, tg, src) {
    var geo = new THREE.RingGeometry(tg.radius - 0.4, tg.radius, 40);
    var mat = new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    var m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.15, z);
    scene.add(m);
    var fill = new THREE.Mesh(new THREE.CircleGeometry(tg.radius, 40), new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.15, side: THREE.DoubleSide }));
    fill.rotation.x = -Math.PI / 2; fill.position.set(x, 0.14, z);
    scene.add(fill);
    telegraphs.push({ x: x, z: z, t: 0, windup: tg.windup, radius: tg.radius, dmg: tg.dmg, mesh: m, fill: fill, src: src || null });
    log('🔴 Boss sắp tung đòn diện rộng — CHẠY RA KHỎI VÒNG ĐỎ!');
  }
  function updateTelegraphs(dt) {
    for (var i = telegraphs.length - 1; i >= 0; i--) {
      var tg = telegraphs[i];
      tg.t += dt;
      tg.mesh.material.opacity = 0.35 + Math.abs(Math.sin(tg.t * 10)) * 0.4;
      tg.fill.scale.setScalar(Math.max(0.05, tg.t / tg.windup));
      if (tg.t >= tg.windup) {
        scene.remove(tg.mesh); scene.remove(tg.fill);
        telegraphs.splice(i, 1);
        burstParticles(new THREE.Vector3(tg.x, 1, tg.z), 0xff7043, 14, 4.5, 0.55, 1.5);
        addTrauma(0.45);
        var d = dist2d(player.group.position.x, player.group.position.z, tg.x, tg.z);
        if (d <= tg.radius && !player.dead) hurtPlayer(C.calcIncomingDamage(tg.dmg, getStats(), 'physical'), 'Đòn diện rộng của Boss', tg.src);
        companions.forEach(function (cp) { if (cp.alive && dist2d(cp.group.position.x, cp.group.position.z, tg.x, tg.z) <= tg.radius) hurtCompanion(cp, Math.round(tg.dmg * 0.6)); });
        spawnFloatText(new THREE.Vector3(tg.x, 1, tg.z), '💥 BÙNG!', '#ff5252');
      }
    }
  }

  /* ================= CombatSystem ================= */
  function hurtPlayer(amount, source, attacker) {
    if (player.dead) return;
    player.hp -= amount;
    player.lastCombatAt = gameTime;
    flashEntity(player.group);
    triggerAnim(player, 'hit');
    addTrauma(0.3);
    spawnFloatText(player.group.position, '-' + amount, '#ff8a80');
    // Đá Phản Đòn: phản % sát thương lên kẻ tấn công cận chiến.
    if (attacker && attacker.alive) {
      var rp = gemModTotal('reflectPct');
      if (rp > 0) damageEnemy(attacker, Math.max(1, Math.round(amount * rp)), {});
    }
    if (player.hp <= 0) {
      player.hp = 0; player.dead = true;
      var lostGold = Math.floor(state.resources.gold * 0.1), lostFood = Math.floor(state.resources.food * 0.1);
      state.resources.gold -= lostGold; state.resources.food -= lostFood;
      toast('☠️ Bạn bị hạ bởi ' + source + '! Mất ' + lostGold + ' Vàng, ' + lostFood + ' Thức ăn. Hồi sinh ở Nhà chính sau 3 giây…', true);
      if (bossRef && bossRef.alive) { bossRef.hp = bossRef.maxHp; setHpBar(bossRef.group.userData.bar, 1); }
      if (boss2Ref && boss2Ref.alive) { boss2Ref.hp = boss2Ref.maxHp; setHpBar(boss2Ref.group.userData.bar, 1); }
      setTimeout(function () {
        player.group.position.set(-4, 0, 4);
        player.hp = getStats().maxHp; player.energy = getStats().maxEnergy; player.dead = false;
        SaveSystem.save(); updateHUD();
        log('🏠 Đã hồi sinh tại Nhà chính.');
      }, 3000);
    }
    updateHUD();
  }
  function shootProjectile(fromPos, targetPos, dmg, hostile, speed) {
    var m = new THREE.Mesh(new THREE.SphereGeometry(hostile ? 0.22 : 0.26, 8, 6), new THREE.MeshBasicMaterial({ color: hostile ? 0xce93d8 : 0xff7043 }));
    m.position.copy(fromPos); m.position.y = 1.3;
    scene.add(m);
    var dir = new THREE.Vector3(targetPos.x - fromPos.x, 0, targetPos.z - fromPos.z).normalize();
    enemyProjectiles.push({ mesh: m, dir: dir, speed: speed || 16, dmg: dmg, life: 3 });
  }
  // Hiệu ứng text bay (dùng sprite canvas đơn giản qua DOM overlay thì phức tạp — dùng sprite 3D)
  var floatTexts = [];
  var FLOAT_MAX = 14; // giới hạn số dòng nổi đồng thời — chống ngập màn hình khi spam đòn/đạn phân tách
  function spawnFloatText(pos, text, color) {
    if (!settings.floatText) return; // toggle "Số bay sát thương" trong Cài đặt
    if (floatTexts.length >= FLOAT_MAX) { var old = floatTexts.shift(); scene.remove(old.sp); }
    var cv = document.createElement('canvas'); cv.width = 256; cv.height = 80;
    var ctx = cv.getContext('2d');
    if (!ctx) return; // môi trường không có canvas 2d: bỏ qua text nổi thay vì văng lỗi
    ctx.font = 'bold 44px sans-serif'; ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 7; ctx.strokeText(text, 128, 50);
    ctx.fillStyle = color || '#fff'; ctx.fillText(text, 128, 50);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false }));
    sp.position.set(pos.x, (pos.y || 0) + 2.6, pos.z);
    sp.scale.set(2.6, 0.8, 1);
    scene.add(sp);
    floatTexts.push({ sp: sp, t: 0 });
  }
  function updateFloatTexts(dt) {
    for (var i = floatTexts.length - 1; i >= 0; i--) {
      var f = floatTexts[i]; f.t += dt;
      f.sp.position.y += dt * 1.4;
      f.sp.material.opacity = 1 - f.t / 1.1;
      if (f.t > 1.1) { scene.remove(f.sp); floatTexts.splice(i, 1); }
    }
  }

  /* ================= SkillSystem: thi triển ================= */
  function basicAttack() {
    if (player.dead || !started) return;
    if (player.basicCd > 0) return;
    player.basicCd = 0.55;
    var pseudo = { base: 8, statScale: 'str', element: 'physical' };
    // AIMBOT cận chiến: quay mặt về mục tiêu + lướt ngắn vào tầm nới trước khi ra đòn.
    if (aimbotOn() && aimTarget && aimTarget.alive) { faceAimPoint(aimTarget.group.position); aimMeleeStep(2.8); }
    swingFx();
    enemies.forEach(function (e) {
      if (!e.alive) return;
      var d = dist2d(player.group.position.x, player.group.position.z, e.group.position.x, e.group.position.z);
      if (d <= 2.8) {
        var r = C.calcDamage(getStats(), pseudo, { armor: 0, resist: 0 });
        damageEnemy(e, r.damage, { crit: r.crit });
      }
    });
  }
  function swingFx() {
    triggerAnim(player, 'attack'); // tay kiếm (arm_r) vung trùng pha với swordMesh bên dưới
    swordMesh.rotation.z = -1.6;
    setTimeout(function () { swordMesh.rotation.z = 0; }, 130);
    // Vệt chém: chùm hạt cong theo hướng chém (pool, Mục 6)
    var p = player.group.position;
    burstParticles(new THREE.Vector3(p.x + Math.sin(player.yaw) * 1.5, 1.3, p.z + Math.cos(player.yaw) * 1.5), 0xfff59d, 5, 2, 0.28, 0.9);
  }
  function castSkill(skillId) {
    if (player.dead || !started) return;
    var skill = D.SKILLS[skillId];
    var mod = C.applyGems(skillId, state.socketed[skillId] || []);
    var now = gameTime;
    if ((player.cooldowns[skillId] || 0) > now) { return; }
    if (player.energy < mod.energyCost) { toast('Không đủ năng lượng cho ' + skill.name + ' (cần ' + mod.energyCost + ')', true); return; }
    player.energy -= mod.energyCost;
    player.cooldowns[skillId] = now + skill.cooldown * (mod.cooldownMult || 1); // Đá Quá Tải kéo dài hồi chiêu
    var st = getStats();
    swingFx();
    if (skill.kind === 'melee') {
      var range = mod.range || skill.range;
      // AIMBOT cận chiến (Chém): quay mặt + lướt ngắn nếu mục tiêu trong tầm nới.
      if (aimbotOn() && aimTarget && aimTarget.alive) { faceAimPoint(aimTarget.group.position); aimMeleeStep(range); }
      enemies.forEach(function (e) {
        if (!e.alive) return;
        var dx = e.group.position.x - player.group.position.x, dz = e.group.position.z - player.group.position.z;
        var d = Math.sqrt(dx * dx + dz * dz);
        if (d > range + 0.6) return;
        var ang = Math.abs(angleDiff(Math.atan2(dx, dz), player.yaw));
        if (ang > 1.9 && d > 1.2) return; // vòng cung ~110°
        var r = C.calcDamage(st, skill, { armor: 0, resist: 0 });
        var dmg = r.damage * mod.damageMult;
        if (mod.addFireFromInt) dmg += st.int * mod.addFireFromInt;
        damageEnemy(e, Math.round(dmg), { crit: r.crit, lifesteal: mod.lifesteal, energyOnHit: mod.energyOnHit });
      });
    } else {
      // projectile: bắn theo hướng nhân vật đang nhìn.
      // AIMBOT: hero quay mặt về điểm ngắm đón đầu; viên đạn GIỮA (số đạn lẻ) nhận homeTarget.
      // Đạn giữa của Phân Tách dẫn hướng nhẹ; 2 viên lệch giữ góc ban đầu.
      var aimSol = aimSolution(skill.speed);
      if (aimSol) faceAimPoint(aimSol.point);
      var baseAng = player.yaw;
      var n = mod.projectiles;
      var centerI = (n % 2 === 1) ? (n - 1) / 2 : -1;
      for (var i = 0; i < n; i++) {
        var ang = baseAng + (i - (n - 1) / 2) * 0.16;
        var m = new THREE.Mesh(new THREE.SphereGeometry(skill.id === 'fireball' ? 0.34 : 0.18, 8, 6),
          new THREE.MeshBasicMaterial({ color: skill.id === 'fireball' ? 0xff5722 : 0xb0bec5 }));
        m.position.copy(player.group.position); m.position.y = 1.4;
        if (skill.id === 'fireball') { var pl = new THREE.PointLight(0xff5722, 1, 6); m.add(pl); }
        scene.add(m);
        projectiles.push({
          mesh: m, dx: Math.sin(ang), dz: Math.cos(ang), speed: skill.speed, life: 2.2,
          skill: skill, mod: mod, pierceLeft: mod.pierce, hitSet: {},
          homeTarget: (aimSol && i === centerI) ? aimSol.target : null
        });
      }
    }
    updateHUD();
  }
  function angleDiff(a, b) { var d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }
  function updateProjectiles(dt) {
    for (var i = projectiles.length - 1; i >= 0; i--) {
      var pr = projectiles[i];
      // AIMBOT: đạn homeTarget lái cong về mục tiêu, tốc độ quay giới hạn HOMING_TURN.
      // Mục tiêu chết hoặc aimbot tắt giữa chừng -> nhả dẫn hướng, đạn bay thẳng tiếp.
      if (pr.homeTarget) {
        if (aimbotOn() && pr.homeTarget.alive) {
          var hp = pr.homeTarget.group.position;
          var wantAng = Math.atan2(hp.x - pr.mesh.position.x, hp.z - pr.mesh.position.z);
          var curAng = Math.atan2(pr.dx, pr.dz);
          var turn = Math.max(-HOMING_TURN * dt, Math.min(HOMING_TURN * dt, angleDiff(wantAng, curAng)));
          var na = curAng + turn;
          pr.dx = Math.sin(na); pr.dz = Math.cos(na);
        } else pr.homeTarget = null;
      }
      pr.mesh.position.x += pr.dx * pr.speed * dt;
      pr.mesh.position.z += pr.dz * pr.speed * dt;
      pr.life -= dt;
      // Vệt hạt sau đạn (pool): cầu lửa = lửa cam, mũi tên = vệt mảnh xám
      pr.trailT = (pr.trailT || 0) + dt;
      if (pr.trailT > 0.04) {
        pr.trailT = 0;
        spawnParticle(pr.mesh.position, pr.skill.id === 'fireball' ? 0xff7043 : 0xcfd8dc, new THREE.Vector3(0, 0.4, 0), 0.3, pr.skill.id === 'fireball' ? 1.3 : 0.7);
      }
      var dead = pr.life <= 0;
      if (!dead) {
        for (var j = 0; j < enemies.length; j++) {
          var e = enemies[j];
          if (!e.alive || pr.hitSet[e.group.id]) continue;
          var d = dist2d(pr.mesh.position.x, pr.mesh.position.z, e.group.position.x, e.group.position.z);
          if (d < 1.05 * e.def.scale + 0.35) {
            pr.hitSet[e.group.id] = true;
            var st = getStats();
            var r = C.calcDamage(st, pr.skill, { armor: 0, resist: pr.skill.element === 'fire' ? 0 : 0 });
            var dmg = r.damage * pr.mod.damageMult;
            if (pr.mod.addFireFromInt && pr.skill.element !== 'fire') dmg += st.int * pr.mod.addFireFromInt;
            damageEnemy(e, Math.round(dmg), { crit: r.crit, lifesteal: pr.mod.lifesteal, energyOnHit: pr.mod.energyOnHit });
            if (pr.mod.slowPct) { e.slowUntil = gameTime + (pr.mod.slowDuration || 2); e.slowPct = pr.mod.slowPct; } // Đá Sương Giá
            // Đá Bùng Nổ: địch quanh điểm nổ nhận % sát thương.
            if (pr.mod.blastPct) {
              var blastDmg = Math.round(dmg * pr.mod.blastPct), blastR = pr.mod.blastRadius || 2.5;
              enemies.forEach(function (e3) {
                if (e3.alive && e3 !== e && dist2d(pr.mesh.position.x, pr.mesh.position.z, e3.group.position.x, e3.group.position.z) <= blastR) {
                  damageEnemy(e3, blastDmg, { lifesteal: pr.mod.lifesteal });
                }
              });
              burstParticles(pr.mesh.position, 0xffab40, 10, 3.5, 0.45, 1.3);
              addTrauma(0.18);
            }
            // Nổ diện cho cầu lửa
            if (pr.skill.aoe) {
              var aoe = pr.mod.aoe || pr.skill.aoe;
              burstParticles(pr.mesh.position, 0xff7043, 8, 3, 0.4, 1.2);
              enemies.forEach(function (e2) {
                if (e2.alive && e2 !== e && dist2d(pr.mesh.position.x, pr.mesh.position.z, e2.group.position.x, e2.group.position.z) <= aoe) {
                  var r2 = C.calcDamage(st, pr.skill, { armor: 0, resist: 0 });
                  damageEnemy(e2, Math.round(r2.damage * pr.mod.damageMult * 0.6), { lifesteal: pr.mod.lifesteal });
                }
              });
            }
            if (pr.pierceLeft > 0) pr.pierceLeft--; else { dead = true; }
            break;
          }
        }
      }
      if (dead) { scene.remove(pr.mesh); projectiles.splice(i, 1); }
    }
    for (var k = enemyProjectiles.length - 1; k >= 0; k--) {
      var ep = enemyProjectiles[k];
      ep.mesh.position.x += ep.dir.x * ep.speed * dt;
      ep.mesh.position.z += ep.dir.z * ep.speed * dt;
      ep.life -= dt;
      var hitP = dist2d(ep.mesh.position.x, ep.mesh.position.z, player.group.position.x, player.group.position.z) < 0.9;
      var hitC = null;
      companions.forEach(function (cp) { if (cp.alive && dist2d(ep.mesh.position.x, ep.mesh.position.z, cp.group.position.x, cp.group.position.z) < 0.9) hitC = cp; });
      if (hitP && !player.dead) { hurtPlayer(C.calcIncomingDamage(ep.dmg, getStats(), 'physical'), 'Cung thủ'); }
      else if (hitC) hurtCompanion(hitC, ep.dmg);
      if (hitP || hitC || ep.life <= 0) { scene.remove(ep.mesh); enemyProjectiles.splice(k, 1); }
    }
  }

  /* ================= CompanionAI ================= */
  function companionCap() {
    var houses = state.buildings.filter(function (b) { return b.type === 'house'; }).length;
    return 1 + houses;
  }
  function spawnCompanion(x, z) {
    var def = D.COMPANION;
    var g = makeHumanoid(0x2e7d32);
    g.add(box(0.09, 0.9, 0.18, 0x90a4ae, -0.55, 1.1, 0.15));
    var bar = makeHpBar(1.5); bar.position.y = 2.45; g.add(bar); g.userData.bar = bar;
    g.position.set(x, 0, z);
    scene.add(g);
    attachModel(g, 'companion'); // thanh HP là Group con nên được giữ; hộp "vũ khí" cũ bị gỡ theo thân
    companions.push({ def: def, group: g, hp: def.hp, maxHp: def.hp, atkCd: 0, alive: true, guardX: x, guardZ: z });
  }
  for (var ci = 0; ci < (state.companions || 0); ci++) spawnCompanion(player.group.position.x - 2 - ci, player.group.position.z + 1);
  function hurtCompanion(cp, dmg) {
    if (!cp.alive) return;
    flashEntity(cp.group);
    triggerAnim(cp, 'hit');
    cp.hp -= dmg;
    setHpBar(cp.group.userData.bar, cp.hp / cp.maxHp);
    if (cp.hp <= 0) {
      cp.alive = false; scene.remove(cp.group);
      state.companions = companions.filter(function (c) { return c.alive; }).length;
      toast('💀 Đồng đội ' + cp.def.name + ' đã ngã! Về Doanh trại chiêu mộ lại.', true);
      SaveSystem.save();
    }
  }
  function updateCompanions(dt) {
    companions.forEach(function (cp) {
      if (!cp.alive) return;
      cp.group.userData.bar.lookAt(camera.position);
      cp.atkCd -= dt;
      var p = player.group.position;
      var target = null, anchorX = p.x, anchorZ = p.z, engageRange = 13;
      if (state.order === 'attack' && markedTarget && markedTarget.alive) target = markedTarget;
      else {
        // tìm địch gần điểm neo nhất
        var bd = 1e9;
        enemies.forEach(function (e) {
          if (!e.alive) return;
          var ax = state.order === 'guard' ? cp.guardX : p.x, az = state.order === 'guard' ? cp.guardZ : p.z;
          var d = dist2d(e.group.position.x, e.group.position.z, ax, az);
          if (d < bd) { bd = d; target = e; }
        });
        if (bd > engageRange) target = null;
      }
      if (state.order === 'guard') { anchorX = cp.guardX; anchorZ = cp.guardZ; }
      if (target) {
        var d = dist2d(cp.group.position.x, cp.group.position.z, target.group.position.x, target.group.position.z);
        if (d > cp.def.range) {
          var dx = target.group.position.x - cp.group.position.x, dz = target.group.position.z - cp.group.position.z;
          var l = Math.sqrt(dx * dx + dz * dz) || 1;
          cp.group.position.x += dx / l * cp.def.speed * dt;
          cp.group.position.z += dz / l * cp.def.speed * dt;
          cp.group.rotation.y = Math.atan2(dx, dz);
        } else if (cp.atkCd <= 0 && target.alive) {
          cp.atkCd = cp.def.cooldown;
          triggerAnim(cp, 'attack');
          damageEnemy(target, Math.round((cp.def.dmg + Math.floor(state.player.level * 0.7)) * C.companionDamageMult(state) * (1 + gemModTotal('allyDamagePct'))), {}); // x cấp Doanh trại x aura Đá Quân Kỳ
        }
      } else {
        var want = state.order === 'guard' ? 0.5 : 2.2;
        var dd = dist2d(cp.group.position.x, cp.group.position.z, anchorX, anchorZ);
        if (dd > want) {
          var dx2 = anchorX - cp.group.position.x, dz2 = anchorZ - cp.group.position.z;
          var l2 = Math.sqrt(dx2 * dx2 + dz2 * dz2) || 1;
          cp.group.position.x += dx2 / l2 * cp.def.speed * dt;
          cp.group.position.z += dz2 / l2 * cp.def.speed * dt;
          cp.group.rotation.y = Math.atan2(dx2, dz2);
        }
        cp.hp = Math.min(cp.maxHp, cp.hp + dt * 1.5); // hồi dần khi không đánh
        setHpBar(cp.group.userData.bar, cp.hp / cp.maxHp);
      }
      collide(cp.group.position, 0.5);
      // Guard: neo lính tại vị trí hiện tại của lính khi ra lệnh guard
      if (state.order === 'guard' && !target && dist2d(cp.group.position.x, cp.group.position.z, cp.guardX, cp.guardZ) < 0.6) { /* đứng yên */ }
    });
    companions = companions.filter(function (c) { return c.alive; });
    companions.forEach(function (cp) { updateEntityAnim(cp, dt, (cp.def && cp.def.speed) || 5.2); });
  }
  function setOrder(o) {
    if (D.ORDERS.indexOf(o) === -1) return;
    state.order = o;
    companions.forEach(function (cp) { cp.guardX = cp.group.position.x; cp.guardZ = cp.group.position.z; });
    document.querySelectorAll('.order-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.order === o); });
    log('📣 Lệnh: ' + D.ORDER_NAMES[o]);
    SaveSystem.save();
  }

  /* ================= Tutorial lần đầu (Mục 3) =================
     Mỗi gợi ý hiện 1 lần duy nhất, trạng thái đã xem lưu trong flags của save (save cũ: mặc định chưa xem). */
  var TUT_TEXT = {
    move: '👋 Lần đầu: dùng WASD / phím mũi tên đi tới cây gần nhất, đứng sát và bấm E (hoặc click dòng gợi ý vàng) để chặt gỗ.',
    build: '🏗️ Menu Xây: chọn công trình, di chuột chọn vị trí (xanh = đặt được) rồi click để đặt. Cuối menu có mục nâng cấp công trình đã xây.',
    inv: '🎒 Túi đồ: bấm "Trang bị" để mặc đồ — chỉ số và sát thương thay đổi thật. Tháo đồ sẽ trả lại túi, không mất.',
    gems: '💎 Panel Đá: chọn kỹ năng rồi lắp đá bạn sở hữu vào các ô (tối đa 3). Tháo miễn phí — cứ thử nhiều build khác nhau!'
  };
  function showTut(id) {
    if (state.flags.tut_done || state.flags['tut_' + id]) return;
    state.flags['tut_' + id] = true;
    $('tut-text').textContent = TUT_TEXT[id];
    $('tut-tip').classList.remove('hidden');
    SaveSystem.save();
  }
  function hideTut() { $('tut-tip').classList.add('hidden'); }

  /* ================= InteractionSystem ================= */
  function nearestInteractable() {
    var p = player.group.position;
    var best = null, bestD = 3.4;
    function consider(d, fn, label) { if (d < bestD) { bestD = d; best = { act: fn, label: label }; } }
    trees.forEach(function (t) { if (t.charges > 0) consider(dist2d(p.x, p.z, t.x, t.z), function () { harvest(t, 'wood', 4, '🪓 Chặt cây'); }, 'E · Chặt cây (+Gỗ)'); });
    rocks.forEach(function (r) { if (r.charges > 0) consider(dist2d(p.x, p.z, r.x, r.z), function () { harvest(r, r.dark ? 'dark' : 'gold', r.dark ? 1 : 2, '⛏️ Đào đá'); }, r.dark ? 'E · Đào đá Hắc Kim' : 'E · Đào đá (+Vàng)'); });
    bushes.forEach(function (b) { if (b.charges > 0) consider(dist2d(p.x, p.z, b.x, b.z), function () { harvest(b, 'food', 3, '🫐 Hái quả'); }, 'E · Hái quả (+Thức ăn)'); });
    consider(dist2d(p.x, p.z, elder.x, elder.z), talkElder, 'E · Nói chuyện với Trưởng làng');
    buildingMeshes.forEach(function (b, bIdx) {
      if (!b) return;
      var d = dist2d(p.x, p.z, b.x, b.z);
      if (b.type === 'barracks') { var rc = C.recruitCostFor(state); consider(d, recruitCompanion, 'E · Chiêu mộ đồng đội (' + rc.gold + ' Vàng, ' + rc.food + ' Thức ăn)'); }
      else if (b.type === 'forge') consider(d, useForge, 'E · Rèn trang bị (15 Vàng, 10 Gỗ)');
      else if (b.type === 'altar') consider(d, useAltar, 'E · Đài kỹ năng: nhận đá hỗ trợ (10 Vàng)');
      else if (b.type === 'market') consider(d, function () { openMarketPanel(bIdx); }, 'E · Chợ — đổi tài nguyên');
      else consider(d, function () { openBuildingPanel(bIdx); }, 'E · ' + b.def.name + ' (Cấp ' + C.buildingLevel(state.buildings[bIdx]) + ') — xem / nâng cấp');
    });
    consider(dist2d(p.x, p.z, 0, 0), function () { toast('🏰 Nhà chính: trung tâm làng. Bị hạ sẽ hồi sinh tại đây.'); }, 'E · Nhà chính');
    return best;
  }
  function harvest(node, res, amount, label) {
    if (node.charges <= 0) return;
    node.charges--;
    var gain = {}; gain[res] = amount;
    C.add(state.resources, gain);
    if (res === 'wood') state.stats.woodHarvested += amount;
    if (res === 'food') state.stats.foodGained += amount;
    log(label + ' +' + amount + ' ' + D.RESOURCE_NAMES[res] + ' (còn ' + node.charges + ' lượt)');
    spawnFloatText(node.group.position, '+' + amount + ' ' + D.RESOURCE_NAMES[res], '#a5d6a7');
    node.group.scale.setScalar(0.75 + node.charges * 0.05);
    if (node.charges <= 0) {
      node.group.visible = false;
      node.respawnAt = gameTime + 60;
    }
    checkQuests(); SaveSystem.save(); updateHUD();
  }
  function talkElder() {
    var qi = C.currentQuestIndex(state);
    var q = D.QUESTS[qi];
    if (q && q.id === 'q4' && !state.flags.gotFirstGear) {
      state.inventory.push('train_sword');
      state.flags.gotFirstGear = true;
      toast('🗡️ Trưởng làng tặng bạn "Kiếm Gỗ Huấn Luyện"! Mở Túi đồ (I) và bấm Trang bị.');
    } else if (q && q.id === 'q9' && !state.flags.reportedBack) {
      state.flags.reportedBack = true;
      toast('🎉 Trưởng làng: "Làng ta an toàn rồi! Đài kỹ năng đã mở khóa trong menu Xây (B)."');
    } else if (q && q.id === 'q10') {
      toast('👴 Trưởng làng: "Sương Vương mạnh hơn Chúa Tể nhiều. Lắp thêm đá (G), mang đồng đội và né vòng đỏ nhanh của nó!"');
    } else if (q && q.id === 'q11') {
      toast('👴 Trưởng làng: "Mở menu Xây (B) — cuối menu có mục nâng cấp công trình đã xây đấy con."');
    } else if (qi >= D.QUESTS.length) {
      toast('👴 Trưởng làng: "Làng đang yên bình nhờ con. Cứ xây thêm Mỏ Hắc Kim, rèn đồ và mạnh lên nữa nhé!"');
    } else {
      toast('👴 Trưởng làng: "' + (q ? q.desc : 'Hãy bảo vệ làng!') + '"');
    }
    checkQuests(); SaveSystem.save(); updateHUD();
  }
  function recruitCompanion() {
    if (companions.filter(function (c) { return c.alive; }).length >= companionCap()) {
      toast('Đã đạt giới hạn đồng đội (' + companionCap() + '). Xây thêm Nhà ở để tăng giới hạn.', true); return;
    }
    var rcost = C.recruitCostFor(state); // Doanh trại cấp cao giảm giá chiêu mộ (core)
    if (!C.spend(state.resources, rcost)) { toast('Không đủ tài nguyên chiêu mộ (cần ' + rcost.gold + ' Vàng, ' + rcost.food + ' Thức ăn)', true); return; }
    spawnCompanion(player.group.position.x - 2, player.group.position.z + 1);
    state.companions = companions.filter(function (c) { return c.alive; }).length;
    toast('🤝 Đã chiêu mộ Lính Canh! Dùng lệnh Z/X/C để điều khiển.');
    SaveSystem.save(); updateHUD();
  }
  function useForge() {
    if (!C.spend(state.resources, { gold: 15, wood: 10 })) { toast('Rèn cần 15 Vàng + 10 Gỗ', true); return; }
    var itemId = C.rollLoot(Math.random, state); // rèn cũng hưởng trọng số Đền thờ như loot rơi
    state.inventory.push(itemId);
    toast('🔨 Rèn thành công: ' + D.ITEMS[itemId].name + ' (' + D.RARITY_NAMES[D.ITEMS[itemId].rarity] + ') — xem trong Túi đồ (I)');
    SaveSystem.save(); updateHUD();
  }
  function useAltar() {
    if (!state.flags.bossKilled) { toast('Đài kỹ năng chỉ hoạt động sau khi hạ Boss đầu tiên.', true); return; }
    var unowned = Object.keys(D.GEMS).filter(function (g) { return state.ownedGems.indexOf(g) === -1; });
    if (!unowned.length) { toast('Bạn đã sở hữu mọi loại đá. Hãy thử các tổ hợp mới trong panel Đá (G)!'); return; }
    if (!C.spend(state.resources, { gold: 10 })) { toast('Cần 10 Vàng để khấn đài', true); return; }
    var g = unowned[Math.floor(Math.random() * unowned.length)];
    state.ownedGems.push(g);
    toast('🔮 Đài ban cho bạn: ' + D.GEMS[g].name + ' — mở panel Đá (G) để lắp.');
    SaveSystem.save(); updateHUD();
  }

  /* ================= QuestSystem: kiểm tra & thưởng ================= */
  function checkQuests() {
    var changed = true;
    while (changed) {
      changed = false;
      var qi = C.currentQuestIndex(state);
      if (qi >= D.QUESTS.length) break;
      var q = D.QUESTS[qi];
      if (C.questDone(q, state.stats, state.flags)) {
        state.completedQuests[q.id] = true;
        var r = q.reward || {};
        var resGain = {};
        ['wood', 'gold', 'food', 'dark'].forEach(function (k) { if (r[k]) resGain[k] = r[k]; });
        C.add(state.resources, resGain);
        if (resGain.food) state.stats.foodGained += 0; // thưởng nhiệm vụ không tính vào tiến trình thu thập để tránh vòng lặp
        if (r.gem && state.ownedGems.indexOf(r.gem) === -1) { state.ownedGems.push(r.gem); toast('💎 Nhận đá: ' + D.GEMS[r.gem].name + '! Mở panel Đá (G), lắp vào Cầu Lửa để thấy khác biệt.'); }
        if (r.item) { state.inventory.push(r.item); toast('🎁 Nhận trang bị: ' + D.ITEMS[r.item].name + '!'); }
        var resTxt = Object.keys(resGain).map(function (k) { return '+' + resGain[k] + ' ' + D.RESOURCE_NAMES[k]; }).join(', ');
        toast('✅ Hoàn thành nhiệm vụ: ' + q.name + (resTxt ? ' · Thưởng ' + resTxt : ''));
        changed = true;
      }
    }
  }

  /* ================= Sản xuất tài nguyên ================= */
  function updateProduction(dt) {
    buildingMeshes.forEach(function (b, idx) {
      if (!b || !b.def.produces) return;
      var sb = state.buildings[idx];
      var pf = sb ? C.productionFor(sb, state) : null; // sản lượng x cấp x hệ số Kho (core)
      if (!pf) return;
      prodTimers[idx] = (prodTimers[idx] || 0) + dt;
      if (prodTimers[idx] >= pf.interval) {
        prodTimers[idx] = 0;
        var amt = Math.max(1, Math.round(pf.amount));
        var gain = {}; gain[pf.res] = amt;
        C.add(state.resources, gain);
        if (pf.res === 'food') state.stats.foodGained += amt;
        spawnFloatText(new THREE.Vector3(b.x, 1, b.z), '+' + amt + ' ' + D.RESOURCE_NAMES[pf.res], '#a5d6a7'); // popup tài nguyên tại công trình
        checkQuests(); updateHUD();
      }
    });
    // Hồi sinh node tài nguyên
    [trees, rocks, bushes].forEach(function (arr) {
      arr.forEach(function (n) {
        if (n.charges <= 0 && n.respawnAt && gameTime > n.respawnAt) {
          n.charges = n === trees[0] ? 5 : n.charges; // giữ đơn giản: đặt lại mặc định theo loại
          n.charges = arr === trees ? 5 : (arr === rocks ? 4 : 3);
          n.group.visible = true; n.group.scale.setScalar(1);
        }
      });
    });
    // Xoay tinh thể trang trí
    buildingMeshes.forEach(function (b) { if (b && b.mesh.userData.spin) b.mesh.userData.spin.rotation.y += dt * 1.4; });
    if (townhallMesh.userData.spin) townhallMesh.userData.spin.rotation.y += dt;
  }

  /* ================= Event làng (Mục 5) — trạng thái RUNTIME, không lưu save ================= */
  function startEvent(id) {
    var def = null;
    D.VILLAGE_EVENTS.forEach(function (e) { if (e.id === id) def = e; });
    if (!def) return;
    if (id === 'harvest_festival') {
      var gain = C.applyEventReward(state, id);
      toast('🎉 ' + def.name + '! Cả làng mở hội: +' + gain.food + ' Thức ăn.');
      spawnFloatText(new THREE.Vector3(0, 2, 0), '+' + gain.food + ' Thức ăn', '#a5d6a7');
      checkQuests(); SaveSystem.save(); updateHUD();
      return;
    }
    if (id === 'wild_beasts') {
      beastsAlive = 2;
      spawnEnemy('beast', 26, -6); spawnEnemy('beast', 26, 5);
      activeEvent = { id: id, t: def.duration, used: {} };
      toast('🐗 ' + def.name + '! 2 thú hoang gần cổng làng — diệt cả 2 để nhận thưởng 20 Vàng + 10 Gỗ!', true);
      return;
    }
    activeEvent = { id: id, t: def.duration, used: {} }; // merchant
    $('btn-event').classList.remove('hidden');
    toast('🧺 ' + def.name + ' — ở lại ' + def.duration + ' giây. Bấm nút 🧺 Sự kiện ở thanh menu để giao dịch!');
    renderMerchant();
  }
  function endEvent() {
    if (!activeEvent) return;
    if (activeEvent.id === 'merchant') $('btn-event').classList.add('hidden');
    if (activeEvent.id === 'wild_beasts') {
      enemies.forEach(function (e) { if (e.type === 'beast' && e.alive) { e.alive = false; scene.remove(e.group); } });
      toast('🐗 Thú hoang đã bỏ chạy — hết giờ sự kiện, không có thưởng.');
    } else {
      toast('Sự kiện đã kết thúc.');
    }
    activeEvent = null; beastsAlive = 0;
  }
  function onBeastKilled() {
    if (!activeEvent || activeEvent.id !== 'wild_beasts') return;
    beastsAlive--;
    if (beastsAlive <= 0) {
      var gain = C.applyEventReward(state, 'wild_beasts');
      toast('🏅 Đã dẹp thú hoang! Thưởng +' + gain.gold + ' Vàng, +' + gain.wood + ' Gỗ.');
      activeEvent = null;
      checkQuests(); SaveSystem.save(); updateHUD();
    }
  }
  function updateEvents(dt) {
    if (activeEvent) {
      activeEvent.t -= dt;
      if (activeEvent.t <= 0) endEvent();
      return;
    }
    eventClock += dt;
    if (eventClock >= nextEventAt) {
      eventClock = 0;
      nextEventAt = 150 + Math.random() * 90; // event tiếp theo sau 150–240 giây chơi
      startEvent(C.pickEvent(Math.random()));
    }
  }
  function renderMerchant() {
    if (!activeEvent || activeEvent.id !== 'merchant') { toast('Hiện không có thương nhân trong làng — chờ sự kiện lần tới.'); return; }
    var def = D.VILLAGE_EVENTS[0];
    var html = '<p>' + def.desc + '</p><p>⏳ Còn khoảng <b>' + Math.ceil(activeEvent.t) + ' giây</b>. Số dư: 🪵 ' + state.resources.wood + ' · 🪙 ' + state.resources.gold + ' · 🍞 ' + state.resources.food + ' · ⬛ ' + state.resources.dark + '</p>';
    def.offers.forEach(function (o) {
      var used = activeEvent.used[o.id];
      var costTxt = Object.keys(o.cost).map(function (k) { return o.cost[k] + ' ' + D.RESOURCE_NAMES[k]; }).join(', ');
      var gainTxt = Object.keys(o.gain).map(function (k) { return '+' + o.gain[k] + ' ' + D.RESOURCE_NAMES[k]; }).join(', ');
      html += '<div class="item-row"><span><b>' + o.label + '</b> <small>(' + costTxt + ' → ' + gainTxt + ')</small></span>' +
        (used ? '<small>đã đổi</small>' : '<button data-offer="' + o.id + '"' + (C.canAfford(state.resources, o.cost) ? '' : ' disabled') + '>Đổi</button>') + '</div>';
    });
    openPanel('🧺 Thương nhân ghé làng', html);
    $('panel-body').querySelectorAll('[data-offer]').forEach(function (b) {
      b.onclick = function () {
        var r = C.applyMerchantOffer(state, b.dataset.offer);
        if (!r.ok) { toast('Không đổi được: ' + r.reason, true); return; }
        activeEvent.used[b.dataset.offer] = true;
        toast('🧺 Đã đổi: ' + r.offer.label);
        SaveSystem.save(); updateHUD(); renderMerchant();
      };
    });
  }

  /* ================= BuildingSystem: chế độ xây + ghost ================= */
  var raycaster = new THREE.Raycaster();
  var mouseNDC = new THREE.Vector2(-2, -2);
  var groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function costTxt(cost) { return Object.keys(cost).map(function (k) { return cost[k] + ' ' + D.RESOURCE_NAMES[k]; }).join(', '); }
  function doUpgrade(idx) {
    var sb = state.buildings[idx];
    var r = C.upgradeBuilding(state, idx);
    if (!r.ok) {
      toast(r.reason === 'max-level' ? 'Công trình đã đạt Cấp 3 tối đa.' : 'Không đủ tài nguyên để nâng cấp!', true);
      return;
    }
    var entry = buildingMeshes[idx];
    if (entry) applyLevelVisual(entry.mesh, sb.type, r.level);
    toast('⬆️ Đã nâng ' + D.BUILDINGS[sb.type].name + ' lên Cấp ' + r.level + '!');
    checkQuests(); SaveSystem.save(); updateHUD();
  }
  // Chợ: panel đổi tài nguyên theo tỉ lệ cố định (logic ở core.marketTrade — nguyên tử).
  function openMarketPanel(idx) {
    var sb = state.buildings[idx]; if (!sb || sb.type !== 'market') return;
    var lv = C.buildingLevel(sb);
    var html = '<p><b>🧺 Chợ</b> — Cấp <b>' + lv + '</b>. Đổi theo tỉ lệ cố định, không giới hạn lượt.' +
      (lv > 1 ? ' Vàng nhận thêm <b>+' + Math.round((lv - 1) * 10) + '%</b> nhờ cấp chợ.' : '') + '</p>' +
      '<p>Số dư: 🪵 ' + state.resources.wood + ' · 🪙 ' + state.resources.gold + ' · 🍞 ' + state.resources.food + ' · ⬛ ' + state.resources.dark + '</p>';
    D.MARKET_TRADES.forEach(function (t) {
      var gainTxt = Object.keys(t.gain).map(function (k) {
        var v = k === 'gold' ? Math.round(t.gain[k] * (1 + 0.1 * (C.maxBuildingLevel(state, 'market') - 1))) : t.gain[k];
        return '+' + v + ' ' + D.RESOURCE_NAMES[k];
      }).join(', ');
      var costTxt2 = Object.keys(t.cost).map(function (k) { return t.cost[k] + ' ' + D.RESOURCE_NAMES[k]; }).join(', ');
      html += '<div class="item-row"><span><b>' + t.label + '</b> <small>(' + costTxt2 + ' → ' + gainTxt + ')</small></span>' +
        '<button data-trade="' + t.id + '"' + (C.canAfford(state.resources, t.cost) ? '' : ' disabled') + '>Đổi</button></div>';
    });
    openPanel('🧺 Chợ · Cấp ' + lv, html);
    $('panel-body').querySelectorAll('[data-trade]').forEach(function (b) {
      b.onclick = function () {
        var r = C.marketTrade(state, b.dataset.trade);
        if (!r.ok) { toast('Không đổi được: ' + (r.reason === 'not-enough' ? 'không đủ tài nguyên' : r.reason), true); return; }
        toast('🧺 Đã đổi: ' + r.trade.label);
        SaveSystem.save(); updateHUD(); openMarketPanel(idx);
      };
    });
  }
  function openBuildingPanel(idx) {
    var sb = state.buildings[idx]; if (!sb) return;
    var def = D.BUILDINGS[sb.type];
    var lv = C.buildingLevel(sb);
    var cost = C.upgradeCostFor(sb.type, lv);
    var pf = C.productionFor(sb, state);
    var html = '<p><b>' + def.name + '</b> — Cấp <b>' + lv + '</b>/3</p><p style="opacity:.85">' + def.desc + '</p>';
    if (pf) html += '<p>🏭 Sản xuất hiện tại: <b>+' + (Math.round(pf.amount * 10) / 10) + ' ' + D.RESOURCE_NAMES[pf.res] + ' / ' + pf.interval + ' giây</b>' + (lv < 3 ? ' (Cấp ' + (lv + 1) + ': +' + Math.round(pf.amount / lv * (lv + 1) * 10) / 10 + ')' : '') + '</p>';
    if (sb.type === 'barracks') html += '<p>🤝 Doanh trại cấp ' + lv + ': giá chiêu mộ ' + costTxt(C.recruitCostFor(state)) + ', sức đồng đội ×' + C.companionDamageMult(state).toFixed(2) + '.</p>';
    if (sb.type === 'market') html += '<div class="item-row"><span>🧺 Mở quầy đổi tài nguyên (tỉ lệ cố định)</span><button data-market="' + idx + '">Đổi</button></div>';
    if (sb.type === 'windmill') html += '<p>🌀 Hiệu lực toàn làng (cối mạnh nhất): sản lượng Trang trại <b>+' + Math.round(C.windmillFarmBonus(state) * 100) + '%</b>. Cánh quạt xoay liên tục — xây thêm cối không cộng dồn.</p>';
    if (sb.type === 'shrine') html += '<p>🔮 Hiệu lực toàn làng (đền mạnh nhất): trọng số rơi đồ Hiếm/Huyền thoại <b>×' + C.shrineLootMult(state) + '</b> khi quay loot (rơi quái + rèn).</p>';
    if (sb.type === 'library') html += '<p>📚 Hiệu lực toàn làng (nhà học mạnh nhất): XP hạ quái <b>×' + C.libraryXpMult(state).toFixed(2) + '</b>.</p>';
    if (sb.type === 'tavern') html += '<p>🍲 Đứng trong bán kính <b>' + D.TAVERN_REGEN.radius + '</b> quanh quán này: hồi <b>' + (D.TAVERN_REGEN.hpPerSecPerLevel * lv) + ' HP + ' + (D.TAVERN_REGEN.enPerSecPerLevel * lv) + ' EN mỗi giây</b> (quán gần nhất quyết định).</p>';
    if (sb.type === 'watchtower') html += '<p>🔭 Quái trong bán kính <b>' + D.WATCHTOWER_SLOW.radiusByLevel[lv] + '</b> quanh tháp này bị <b>chậm ' + Math.round(D.WATCHTOWER_SLOW.pct * 100) + '%</b> (nhiều tháp không cộng dồn; cộng dồn kiểu lấy max với Đá Sương Giá).</p>';
    if (sb.type === 'house') html += '<div class="item-row"><span>😴 Nghỉ ngơi hồi đầy máu</span><button data-rest="1">Nghỉ</button></div>';
    if (cost) html += '<div class="item-row"><span>⬆️ Nâng lên Cấp ' + (lv + 1) + ' — ' + costTxt(cost) + '</span><button data-upgrade="' + idx + '"' + (C.canAfford(state.resources, cost) ? '' : ' disabled') + '>Nâng cấp</button></div>';
    else html += '<p>⭐ Đã đạt cấp tối đa.</p>';
    openPanel('🏠 ' + def.name + ' · Cấp ' + lv, html);
    $('panel-body').querySelectorAll('[data-market]').forEach(function (b) {
      b.onclick = function () { openMarketPanel(idx); };
    });
    $('panel-body').querySelectorAll('[data-upgrade]').forEach(function (b) {
      b.onclick = function () { doUpgrade(idx); openBuildingPanel(idx); if (buildMode.active) renderBuildList(); };
    });
    $('panel-body').querySelectorAll('[data-rest]').forEach(function (b) {
      b.onclick = function () { player.hp = getStats().maxHp; toast('😴 Nghỉ ngơi tại Nhà ở — hồi đầy máu.'); closePanel(); updateHUD(); };
    });
    showTut('build');
  }
  function openBuild() {
    buildMode.active = true;
    savedCam = { pitch: camPitch, dist: camDist }; // khôi phục khi thoát (Mục 2)
    document.getElementById('build-bar').classList.remove('hidden');
    renderBuildList();
    document.exitPointerLock && document.exitPointerLock();
  }
  function closeBuild() {
    buildMode.active = false; buildMode.type = null;
    if (savedCam) { camPitch = savedCam.pitch; camDist = savedCam.dist; savedCam = null; }
    if (buildMode.ghost) { scene.remove(buildMode.ghost); buildMode.ghost = null; }
    document.getElementById('build-bar').classList.add('hidden');
  }
  var buildTab = 'prod'; // tab menu xây đang chọn (runtime, không lưu)
  var BUILD_TABS = [['home', '🏠 Nhà ở'], ['prod', '🏭 Sản xuất'], ['special', '✨ Đặc biệt']];
  function renderBuildList() {
    var wrap = document.getElementById('build-list');
    wrap.innerHTML = '';
    // Tab nhóm công trình (15 loại — tránh tràn màn hình điện thoại)
    var tabs = document.createElement('div');
    tabs.className = 'build-tabs';
    BUILD_TABS.forEach(function (t) {
      var cnt = Object.keys(D.BUILDINGS).filter(function (id) { return id !== 'townhall' && (D.BUILDINGS[id].cat || 'special') === t[0]; }).length;
      var tb = document.createElement('button');
      tb.className = 'build-tab' + (buildTab === t[0] ? ' active' : '');
      tb.textContent = t[1] + ' (' + cnt + ')';
      tb.onclick = function () { buildTab = t[0]; renderBuildList(); };
      tabs.appendChild(tb);
    });
    wrap.appendChild(tabs);
    Object.keys(D.BUILDINGS).forEach(function (id) {
      if (id === 'townhall') return;
      if ((D.BUILDINGS[id].cat || 'special') !== buildTab) return;
      var def = D.BUILDINGS[id];
      var btn = document.createElement('button');
      btn.className = 'build-item' + (buildMode.type === id ? ' selected' : '');
      var locked = def.locked === 'boss' && !state.flags.bossKilled;
      var afford = C.canAfford(state.resources, def.cost);
      if (locked) btn.className += ' locked';
      else if (!afford) btn.className += ' cant';
      var costTxt = Object.keys(def.cost).map(function (k) { return def.cost[k] + ' ' + D.RESOURCE_NAMES[k]; }).join(', ');
      btn.innerHTML = '<b>' + def.name + '</b><br><small>' + (locked ? '🔒 Hạ boss để mở khóa' : costTxt) + '</small>';
      btn.onclick = function () { selectBuildType(id); };
      wrap.appendChild(btn);
    });
    // Mục "Công trình đã xây — nâng cấp" (Mục 5)
    if (state.buildings.length) {
      var sec = document.createElement('div');
      sec.style.cssText = 'width:100%;margin-top:6px;border-top:1px solid rgba(255,255,255,.2);padding-top:6px';
      sec.innerHTML = '<b>🏠 Công trình đã xây — nâng cấp:</b>';
      wrap.appendChild(sec);
      state.buildings.forEach(function (sb, idx) {
        var lv = C.buildingLevel(sb);
        var cost = C.upgradeCostFor(sb.type, lv);
        var row = document.createElement('div');
        row.className = 'item-row';
        var label = document.createElement('span');
        label.innerHTML = D.BUILDINGS[sb.type].name + ' <b>Cấp ' + lv + '</b>';
        row.appendChild(label);
        if (cost) {
          var ub = document.createElement('button');
          ub.textContent = '⬆️ Nâng (' + costTxt(cost) + ')';
          ub.disabled = !C.canAfford(state.resources, cost);
          ub.onclick = function () { doUpgrade(idx); renderBuildList(); };
          row.appendChild(ub);
        } else {
          var mx = document.createElement('small'); mx.textContent = 'MAX Cấp 3'; row.appendChild(mx);
        }
        wrap.appendChild(row);
      });
    }
    showTut('build');
  }
  function selectBuildType(id) {
    var def = D.BUILDINGS[id];
    if (def.locked === 'boss' && !state.flags.bossKilled) { toast('Công trình bị khóa: hãy hạ Boss trước.', true); return; }
    buildMode.type = id; buildMode.rot = 0;
    if (buildMode.ghost) scene.remove(buildMode.ghost);
    buildMode.ghost = makeBuildingMesh(id);
    ghostifyGroup(buildMode.ghost);
    attachModel(buildMode.ghost, id, { ghost: true }); // ghost dùng chính model thật (ép trong suốt + tint ở updateGhost như cũ)
    scene.add(buildMode.ghost);
    renderBuildList();
  }
  function updateGhost() {
    if (!buildMode.active || !buildMode.ghost) return;
    raycaster.setFromCamera(mouseNDC, camera);
    var pt = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, pt)) return;
    buildMode.x = Math.round(pt.x); buildMode.z = Math.round(pt.z);
    buildMode.ghost.position.set(buildMode.x, 0, buildMode.z);
    buildMode.ghost.rotation.y = buildMode.rot;
    var v = C.placementValid(buildMode.type, buildMode.x, buildMode.z, state.buildings, state.flags);
    buildMode.valid = v.ok && C.canAfford(state.resources, D.BUILDINGS[buildMode.type].cost);
    var col = buildMode.valid ? 0x66ff66 : 0xff4444;
    buildMode.ghost.traverse(function (o) { if (o.material && o.material.color) o.material.color.setHex(col); });
  }
  // Phần tài nguyên còn thiếu so với cost, dạng "12 Gỗ, 5 Vàng" — cho thông báo đặt công trình.
  function missingCostText(cost) {
    var miss = [];
    Object.keys(cost).forEach(function (k) {
      var lack = cost[k] - (state.resources[k] || 0);
      if (lack > 0) miss.push(lack + ' ' + (D.RESOURCE_NAMES[k] || k));
    });
    return miss.join(', ');
  }
  // Lý do vị trí không hợp lệ mà placementValid (core.js) đã phân biệt sẵn.
  function placementReasonText(reason) {
    if (reason === 'collision') return 'trùng với công trình khác';
    if (reason === 'out-of-village') return 'ngoài vùng xây dựng của làng';
    if (reason === 'locked') return 'công trình chưa mở khóa — hãy hạ Boss trước';
    return '';
  }
  function confirmBuild() {
    if (!buildMode.type) { toast('Hãy chọn một công trình trước!', true); return; }
    var def = D.BUILDINGS[buildMode.type];
    // Tách rõ 2 nguyên nhân thất bại khi đặt công trình: vị trí trước, tài nguyên sau.
    var v = C.placementValid(buildMode.type, buildMode.x, buildMode.z, state.buildings, state.flags);
    if (!v.ok) {
      var rt = placementReasonText(v.reason);
      toast('Vị trí không hợp lệ' + (rt ? ': ' + rt : '') + '!', true);
      return;
    }
    if (!C.canAfford(state.resources, def.cost)) { toast('Không đủ tài nguyên: thiếu ' + missingCostText(def.cost) + '!', true); return; }
    // Trừ đúng 1 lần, nguyên tử — mọi nhánh thất bại ở trên đều không trừ gì.
    if (!C.spend(state.resources, def.cost)) { toast('Không đủ tài nguyên: thiếu ' + missingCostText(def.cost) + '!', true); return; }
    var b = { type: buildMode.type, x: buildMode.x, z: buildMode.z, rot: buildMode.rot };
    state.buildings.push(b);
    addBuildingMesh(b, state.buildings.length - 1);
    state.stats.buildingsPlaced++;
    toast('🏗️ Đã xây: ' + def.name);
    checkQuests(); SaveSystem.save(); updateHUD();
    closeBuild(); // Đặt thành công 1 công trình là thoát chế độ xây (ẩn ghost + build bar) để tránh bấm nhầm đặt thêm tốn tài nguyên; mở lại bằng B/nút Xây.
  }

  /* ================= UIController ================= */
  // $ đã được định nghĩa ở đầu file (các hàm chạy lúc init như log() cần nó sớm).
  function log(msg) {
    var box = $('log-box');
    var div = document.createElement('div'); div.textContent = msg;
    box.prepend(div);
    while (box.children.length > 6) box.removeChild(box.lastChild);
  }
  function toast(msg, bad) {
    var t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
    $('toast-wrap').appendChild(t);
    setTimeout(function () { t.remove(); }, 4200);
    log(msg);
  }
  function statTxt(st) {
    var names = { str: 'STR', int: 'INT', agi: 'AGI', armor: 'Giáp', resist: 'Kháng %', maxHp: '+HP', maxEnergy: '+EN' };
    return Object.keys(st).map(function (k) { return names[k] + ' +' + st[k]; }).join(', ');
  }
  function updateHUD() {
    $('res-wood').textContent = state.resources.wood;
    $('res-gold').textContent = state.resources.gold;
    $('res-food').textContent = state.resources.food;
    $('res-dark').textContent = state.resources.dark;
    $('player-level').textContent = state.player.level;
    var st = getStats();
    $('bar-hp').style.width = Math.max(0, player.hp / st.maxHp * 100) + '%';
    $('txt-hp').textContent = Math.ceil(player.hp) + '/' + st.maxHp;
    $('bar-en').style.width = Math.max(0, player.energy / st.maxEnergy * 100) + '%';
    $('txt-en').textContent = Math.floor(player.energy) + '/' + st.maxEnergy;
    $('bar-xp').style.width = (state.player.xp / xpNeed() * 100) + '%';
    $('txt-xp').textContent = state.player.xp + '/' + xpNeed();
    // Lớp ảnh AI: chip chân dung đồng đội — chỉ hiện khi có đồng đội còn sống đi theo
    var cpChip = $('companion-chip');
    if (cpChip) cpChip.classList.toggle('hidden', !companions.some(function (c) { return c.alive; }));
    // Nhiệm vụ hiện tại
    var qi = C.currentQuestIndex(state);
    if (qi >= D.QUESTS.length) {
      $('quest-name').textContent = '🎉 Hoàn thành chuỗi nhiệm vụ!';
      $('quest-desc').textContent = 'Làng đã an toàn. Tiếp tục xây dựng, rèn đồ, thử build đá và farm Hắc Kim tự do.';
      $('quest-progress').textContent = '';
    } else {
      var q = D.QUESTS[qi];
      $('quest-name').textContent = (qi + 1) + '. ' + q.name;
      $('quest-desc').textContent = q.desc;
      if (q.goal.type === 'stat') $('quest-progress').textContent = 'Tiến độ: ' + C.questProgress(q, state.stats, state.flags) + ' / ' + q.goal.count;
      else $('quest-progress').textContent = 'Tiến độ: làm theo mô tả ở trên';
    }
    // Cooldown trên nút kỹ năng
    ['slash', 'fireball', 'arrow'].forEach(function (sid) {
      var btn = $('btn-' + sid), cd = btn.querySelector('.cd');
      var remain = (player.cooldowns[sid] || 0) - gameTime;
      cd.textContent = remain > 0 ? remain.toFixed(1) : '';
      var cost = C.applyGems(sid, state.socketed[sid] || []).energyCost;
      btn.classList.toggle('no-energy', player.energy < cost);
      btn.title = C.skillFormulaText(sid, st, state.socketed[sid] || []) + ((state.socketed[sid] || []).length ? ' | Đá: ' + state.socketed[sid].map(function (g) { return D.GEMS[g].name; }).join(', ') : '');
    });
    var prompt = $('interact-prompt');
    if (started && !buildMode.active) {
      var it = nearestInteractable();
      if (it) { prompt.textContent = it.label; prompt.classList.remove('hidden'); }
      else prompt.classList.add('hidden');
    } else prompt.classList.add('hidden');
  }
  function openPanel(title, html) {
    $('panel-title').textContent = title;
    $('panel-body').innerHTML = html;
    $('panel').classList.remove('hidden');
    document.exitPointerLock && document.exitPointerLock();
  }
  function closePanel() { $('panel').classList.add('hidden'); }
  function renderInventory() {
    showTut('inv');
    var st = getStats();
    var html = '<div class="inv-hero"><img src="img/p-hero.jpg" alt="Anh hùng" onerror="this.style.display=\'none\'"><div><div class="inv-hero-name">⚔️ Anh hùng của làng</div><div style="opacity:.85">Cấp ' + state.player.level + ' · Kiếm sĩ trẻ áo xanh lá</div></div></div>' +
      '<div class="stats-grid">' +
      '<span>Máu tối đa: <b>' + st.maxHp + '</b></span><span>Năng lượng: <b>' + st.maxEnergy + '</b></span>' +
      '<span>Sức mạnh (STR): <b>' + st.str + '</b></span><span>Trí tuệ (INT): <b>' + st.int + '</b></span>' +
      '<span>Nhanh nhẹn (AGI): <b>' + st.agi + '</b></span><span>Giáp: <b>' + st.armor + '</b></span>' +
      '<span>Kháng nguyên tố: <b>' + st.resist + '%</b></span><span>Cấp: <b>' + state.player.level + '</b></span></div>' +
      '<p style="opacity:.85">Công thức sát thương: (nền + chỉ số×1.2) × 100/(100+Giáp địch) × kháng. Giáp của bạn giảm sát thương nhận vào theo cùng công thức.</p><hr style="margin:10px 0;opacity:.25">' +
      '<h4>Đang trang bị</h4>';
    D.SLOTS.forEach(function (slot) {
      var id = state.equipped[slot];
      html += '<div class="item-row"><span>' + D.SLOT_NAMES[slot] + ': ' + (id ? '<b class="rarity-' + D.ITEMS[id].rarity + '">' + D.ITEMS[id].name + '</b> <small>(' + statTxt(D.ITEMS[id].stats) + ')</small>' : '<i>trống</i>') + '</span>' + (id ? '<button data-unequip="' + slot + '">Tháo</button>' : '') + '</div>';
    });
    html += '<h4 style="margin-top:12px">Túi đồ (' + state.inventory.length + ')</h4>';
    if (!state.inventory.length) html += '<p style="opacity:.8">Túi trống. Đánh quái, rèn ở Lò rèn hoặc nhận nhiệm vụ để có trang bị.</p>';
    state.inventory.forEach(function (id, i) {
      var it = D.ITEMS[id];
      html += '<div class="item-row"><span><b class="rarity-' + it.rarity + '">' + it.name + '</b> <small>[' + D.SLOT_NAMES[it.slot] + ' · ' + D.RARITY_NAMES[it.rarity] + '] ' + statTxt(it.stats) + ' — ' + it.desc + '</small></span><button data-equip="' + i + '">Trang bị</button></div>';
    });
    openPanel('🎒 Túi đồ & Trang bị', html);
    $('panel-body').querySelectorAll('[data-equip]').forEach(function (b) {
      b.onclick = function () {
        var idx = parseInt(b.dataset.equip, 10);
        var id = state.inventory[idx];
        var r = C.equipItem(state, id);
        if (r.ok) { var st2 = getStats(); player.hp = Math.min(player.hp, st2.maxHp); toast('Đã trang bị: ' + D.ITEMS[id].name); }
        SaveSystem.save(); renderInventory(); updateHUD();
      };
    });
    $('panel-body').querySelectorAll('[data-unequip]').forEach(function (b) {
      b.onclick = function () { C.unequipItem(state, b.dataset.unequip); SaveSystem.save(); renderInventory(); updateHUD(); };
    });
  }
  var gemSkillSel = 'fireball';
  function renderGems() {
    showTut('gems');
    var html = '<p style="opacity:.85">Chọn kỹ năng, rồi lắp đá bạn sở hữu. Tháo đá <b>miễn phí</b>, đá không mất. Tối đa ' + D.MAX_GEMS_PER_SKILL + ' đá/kỹ năng. Đá không tương thích sẽ bị từ chối kèm lý do.</p>' +
      '<p>Kỹ năng: <select id="gem-skill-sel">' + Object.keys(D.SKILLS).map(function (sid) { return '<option value="' + sid + '"' + (sid === gemSkillSel ? ' selected' : '') + '>' + D.SKILLS[sid].name + ' (' + (D.SKILLS[sid].kind === 'melee' ? 'cận chiến' : 'đạn') + ')</option>'; }).join('') + '</select></p>';
    var socketed = state.socketed[gemSkillSel] || [];
    var mod = C.applyGems(gemSkillSel, socketed);
    html += '<h4 style="margin-top:8px">Ô đá của ' + D.SKILLS[gemSkillSel].name + ' (' + socketed.length + '/' + D.MAX_GEMS_PER_SKILL + ')</h4>';
    for (var si = 0; si < D.MAX_GEMS_PER_SKILL; si++) {
      var sg = socketed[si];
      if (sg) html += '<div class="gem-row" title="' + C.gemEffectText(sg) + '"><span>💎 <b>' + D.GEMS[sg].name + '</b> <small>' + D.GEMS[sg].desc + '</small></span><button data-unsocket="' + sg + '">Tháo (miễn phí)</button></div>';
      else html += '<div class="gem-row empty-slot"><span>⬜ Ô trống ' + (si + 1) + ' — chọn đá bên dưới để lắp</span></div>';
    }
    html += '<p style="background:rgba(255,255,255,.06);padding:8px;border-radius:8px">Hiệu quả hiện tại: ' +
      (D.SKILLS[gemSkillSel].kind === 'projectile' ? 'số đạn <b>' + mod.projectiles + '</b> · xuyên <b>' + mod.pierce + '</b> · ' : '') +
      'hệ số sát thương <b>×' + mod.damageMult.toFixed(2) + '</b> · hút máu <b>' + Math.round(mod.lifesteal * 100) + '%</b> · tốn <b>' + mod.energyCost + '</b> EN</p>';
    var extras = [];
    if (mod.energyOnHit) extras.push('hồi ' + mod.energyOnHit + ' EN/đòn trúng');
    if (mod.reflectPct) extras.push('phản đòn ' + Math.round(mod.reflectPct * 100) + '%');
    if (mod.blastPct) extras.push('nổ ' + Math.round(mod.blastPct * 100) + '% (bán kính ' + mod.blastRadius + ')');
    if (mod.allyDamagePct) extras.push('đồng đội +' + Math.round(mod.allyDamagePct * 100) + '% sát thương');
    if (mod.slowPct) extras.push('làm chậm ' + Math.round(mod.slowPct * 100) + '% trong ' + mod.slowDuration + 's');
    if (mod.cooldownMult !== 1) extras.push('hồi chiêu ×' + mod.cooldownMult);
    if (extras.length) html += '<p style="opacity:.92">✨ Hiệu ứng đá thêm: ' + extras.join(' · ') + '</p>';
    html += '<h4 style="margin-top:10px">Đá đang sở hữu</h4>';
    if (!state.ownedGems.length) html += '<p style="opacity:.8">Chưa có đá nào. Hoàn thành nhiệm vụ 7 hoặc khấn Đài kỹ năng.</p>';
    state.ownedGems.forEach(function (g) {
      var gem = D.GEMS[g];
      var compat = C.gemCompatible(g, gemSkillSel);
      var already = socketed.indexOf(g) !== -1;
      html += '<div class="gem-row" title="' + C.gemEffectText(g) + '"><span>💎 <b>' + gem.name + '</b> <small>' + gem.desc + (compat ? '' : ' · <span style="color:#ef9a9a">Không tương thích với kỹ năng này</span>') + '</small></span>' +
        (already ? '<small>đã lắp</small>' : '<button data-socket="' + g + '"' + (compat ? '' : ' disabled') + '>Lắp</button>') + '</div>';
    });
    openPanel('💎 Đá kỹ năng & Kết hợp build', html);
    $('gem-skill-sel').onchange = function (e) { gemSkillSel = e.target.value; renderGems(); };
    $('panel-body').querySelectorAll('[data-socket]').forEach(function (b) {
      b.onclick = function () {
        var r = C.socketGem(state, gemSkillSel, b.dataset.socket);
        if (!r.ok) toast('Không lắp được: ' + r.reason, true);
        else toast('Đã lắp ' + D.GEMS[b.dataset.socket].name + ' vào ' + D.SKILLS[gemSkillSel].name);
        SaveSystem.save(); renderGems(); updateHUD();
      };
    });
    $('panel-body').querySelectorAll('[data-unsocket]').forEach(function (b) {
      b.onclick = function () { C.unsocketGem(state, gemSkillSel, b.dataset.unsocket); SaveSystem.save(); renderGems(); updateHUD(); };
    });
  }
  function renderHelp() {
    openPanel('❓ Điều khiển & Lưu game',
      '<p><b>WASD / phím mũi tên</b> di chuyển · <b>Shift</b> chạy · <b>Chuột</b>: click vào game để khóa chuột xoay camera, hoặc kéo chuột · <b>Lăn chuột / chụm–mở hai ngón</b>: zoom gần–xa</p>' +
      '<p><b>E</b> tương tác · <b>F / Click trái</b> đánh thường · <b>1/2/3</b> kỹ năng Chém/Cầu lửa/Mũi tên · <b>T</b> đánh dấu quái gần nhất</p>' +
      '<p><b>🎯 Aimbot (V hoặc nút 🎯):</b> trợ ngắm — tự khóa quái gần nhất (vòng đỏ dưới chân), đạn Cầu lửa/Mũi tên đón đầu mục tiêu đang chạy và dẫn hướng nhẹ, đòn cận chiến tự lướt ngắn vào tầm. Chỉ trợ ngắm: bạn vẫn tự ra đòn, aimbot không tăng sát thương, không xuyên vật cản, không tự tung chiêu.</p>' +
      '<p><b>B</b> xây dựng (chuột chọn vị trí, R xoay, click đặt) · <b>I</b> túi đồ · <b>G</b> đá kỹ năng · <b>Z/X/C</b> lệnh đồng đội · <b>Esc</b> đóng panel</p>' +
      '<p>📱 Điện thoại: có joystick ảo góc trái và nút ⚔️/E ở góc phải (hỗ trợ cơ bản).</p>' +
      '<hr style="margin:10px 0;opacity:.25">' +
      '<p>⚠️ <b>Lưu game:</b> tiến trình chỉ lưu bằng localStorage <b>trên chính trình duyệt/thiết bị này</b>. Không có tài khoản, không đồng bộ sang thiết bị khác, và <b>có thể mất hẳn khi xóa dữ liệu trang web</b> hoặc dùng trình duyệt khác. Đây không phải cloud save.</p>' +
      '<hr style="margin:10px 0;opacity:.25">' +
      '<p><b>👥 Nhân vật & kẻ địch:</b></p>' +
      '<div class="char-gallery help-gallery">' +
      '<div class="char-card"><img src="img/p-hero.jpg" alt="Anh hùng" onerror="this.style.display=\'none\'"><small>Anh hùng</small></div>' +
      '<div class="char-card"><img src="img/p-elder.jpg" alt="Trưởng làng" onerror="this.style.display=\'none\'"><small>Trưởng làng</small></div>' +
      '<div class="char-card"><img src="img/p-companion.jpg" alt="Đồng đội" onerror="this.style.display=\'none\'"><small>Đồng đội</small></div>' +
      '<div class="char-card"><img src="img/p-goblin.jpg" alt="Goblin" onerror="this.style.display=\'none\'"><small>Goblin</small></div>' +
      '<div class="char-card"><img src="img/p-boss1.jpg" alt="Chúa Tể Sương Mù" onerror="this.style.display=\'none\'"><small>Chúa Tể Sương Mù</small></div>' +
      '<div class="char-card"><img src="img/p-boss2.jpg" alt="Sương Vương" onerror="this.style.display=\'none\'"><small>Sương Vương</small></div>' +
      '</div>' +
      '<hr style="margin:10px 0;opacity:.25">' +
      '<p><b>⚙️ Cài đặt:</b> đồ họa, hiệu ứng, camera, tốc độ ngày–đêm và xuất/nhập save đều nằm trong panel Cài đặt (lưu riêng, áp dụng ngay).</p>' +
      '<p><button class="mini-btn" id="help-open-settings">⚙️ Mở Cài đặt</button></p>');
    var hos = $('help-open-settings');
    if (hos) hos.onclick = function () { renderSettings(); };
  }

  /* ================= Settings (đợt mở rộng): áp dụng + panel =================
     Mọi mục đều có tác dụng THẬT và áp dụng NGAY (không tải lại trang):
     - quality -> trần pixelRatio + cỡ shadow map; shadows -> renderer.shadowMap + sun.castShadow
       (đổi shadowMap.enabled phải needsUpdate vật liệu — traverse 1 lần khi đổi).
     - camDistDefault chỉ áp khi chưa vào game (không giật camera giữa ván).
     - aimbot đồng bộ 2 chiều với nút 🎯/phím V qua setAimbot/applySettings. */
  function applySettings() {
    var q = settings.quality;
    var prCap = q === 'low' ? 1 : (q === 'med' ? 1.5 : 2);
    try { renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, prCap)); } catch (e) { /* harness không có renderer thật */ }
    var shadowSize = q === 'low' ? 512 : (q === 'med' ? 1024 : 2048);
    if (sun.shadow.mapSize.x !== shadowSize) {
      sun.shadow.mapSize.set(shadowSize, shadowSize);
      if (sun.shadow.map) { try { sun.shadow.map.dispose(); } catch (e) {} sun.shadow.map = null; }
    }
    var wantShadow = settings.shadows && q !== 'low';
    if (renderer.shadowMap.enabled !== wantShadow) {
      renderer.shadowMap.enabled = wantShadow;
      scene.traverse(function (o) { if (o.material) o.material.needsUpdate = true; });
    }
    sun.castShadow = wantShadow;
    state.flags.aimbotOn = settings.aimbot;
    paintAimBtn();
    if (!started) camDist = settings.camDistDefault;
    var fe = $('fps-overlay'); if (fe) fe.style.display = settings.showFps ? 'block' : 'none';
  }
  function renderSettings() {
    var s = settings;
    function sel(id, opts, cur) {
      return '<select id="' + id + '">' + opts.map(function (o) {
        return '<option value="' + o[0] + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>';
    }
    function chk(id, cur, label) {
      return '<div class="item-row"><span>' + label + '</span><input type="checkbox" id="' + id + '"' + (cur ? ' checked' : '') + '></div>';
    }
    var html =
      '<h4>🖼️ Đồ họa</h4>' +
      '<div class="item-row"><span>Chất lượng (độ phân giải + bóng)</span>' + sel('st-quality', [['low', 'Thấp'], ['med', 'Trung bình'], ['high', 'Cao']], s.quality) + '</div>' +
      chk('st-shadows', s.shadows, 'Bóng đổ') +
      chk('st-envfx', s.envFx, 'Hiệu ứng môi trường (sao + đom đóm đêm)') +
      '<h4 style="margin-top:10px">✨ Hiệu ứng</h4>' +
      chk('st-shake', s.shake, 'Rung camera khi trúng đòn') +
      chk('st-flash', s.flash, 'Chớp sáng khi trúng đòn') +
      chk('st-hitstop', s.hitStop, 'Hit-stop (khựng hình khi chí mạng/hạ gục)') +
      chk('st-floattext', s.floatText, 'Số bay sát thương / hồi phục') +
      chk('st-particles', s.particles, 'Hạt hiệu ứng (vệt chém, tia lửa đạn)') +
      '<h4 style="margin-top:10px">🎥 Camera</h4>' +
      '<div class="item-row"><span>Độ nhạy xoay: <b id="st-camsens-val">' + s.camSensitivity.toFixed(1) + '×</b></span><input type="range" id="st-camsens" min="0.5" max="2" step="0.1" value="' + s.camSensitivity + '"></div>' +
      '<div class="item-row"><span>Khoảng cách camera mặc định khi vào game</span>' + sel('st-camdist', [[18, 'Gần (18)'], [28, 'Vừa (28)'], [40, 'Xa (40)']], s.camDistDefault) + '</div>' +
      chk('st-aimbot', s.aimbot, 'Tự khóa mục tiêu aimbot 🎯') +
      '<h4 style="margin-top:10px">🎮 Gameplay</h4>' +
      '<div class="item-row"><span>Tốc độ chu kỳ ngày–đêm</span>' + sel('st-dayspeed', [[0.5, 'Chậm 0.5×'], [1, 'Thường 1×'], [2, 'Nhanh 2×']], s.daySpeed) + '</div>' +
      chk('st-fps', s.showFps, 'Hiện FPS (góc trái dưới)') +
      '<h4 style="margin-top:10px">💾 Dữ liệu save</h4>' +
      '<p style="opacity:.85">Save vẫn chỉ nằm trong trình duyệt này (localStorage). Xuất mã save để sao lưu/chuyển máy thủ công, nhập lại khi cần. Nhập sai mã sẽ bị từ chối và <b>giữ nguyên save cũ</b>.</p>' +
      '<div class="item-row"><span>Xuất save</span><span><button id="st-export-btn">Hiện mã</button> <button id="st-download-btn">Tải file JSON</button></span></div>' +
      '<textarea id="st-io" rows="4" style="width:100%;background:#10222f;color:#cfd8dc;border:1px solid rgba(255,255,255,.3);border-radius:8px;padding:8px" placeholder="Mã save sẽ hiện ở đây — hoặc dán mã save vào đây rồi bấm Nhập save"></textarea>' +
      '<div class="item-row"><span>Nhập save</span><span><button id="st-import-btn">Nhập từ mã phía trên</button> <label class="mini-btn" style="display:inline-block">Chọn file…<input type="file" id="st-import-file" accept=".json,.txt" style="display:none"></label></span></div>' +
      '<div class="item-row"><span>Xóa save (chơi lại từ đầu)</span><button id="st-wipe-btn">🗑️ Xóa save</button></div>' +
      '<hr style="margin:10px 0;opacity:.25">' +
      '<div class="item-row"><span>Đặt lại toàn bộ cài đặt về mặc định</span><button id="st-reset-btn">↺ Đặt lại mặc định</button></div>' +
      '<p style="opacity:.75">Cài đặt lưu ở khóa riêng, tách khỏi save game — mất cài đặt không mất tiến trình.</p>';
    openPanel('⚙️ Cài đặt', html);
    function bindChk(id, key) { var el = $(id); if (el) el.onchange = function () { settings[key] = el.checked; persistSettings(); applySettings(); }; }
    bindChk('st-shadows', 'shadows'); bindChk('st-envfx', 'envFx');
    bindChk('st-shake', 'shake'); bindChk('st-flash', 'flash'); bindChk('st-hitstop', 'hitStop');
    bindChk('st-floattext', 'floatText'); bindChk('st-particles', 'particles'); bindChk('st-fps', 'showFps');
    var aimEl = $('st-aimbot'); if (aimEl) aimEl.onchange = function () { setAimbot(aimEl.checked); };
    var qEl = $('st-quality'); if (qEl) qEl.onchange = function () { settings.quality = qEl.value; persistSettings(); applySettings(); toast('Chất lượng: ' + qEl.options[qEl.selectedIndex].text); };
    var cdEl = $('st-camdist'); if (cdEl) cdEl.onchange = function () { settings.camDistDefault = parseInt(cdEl.value, 10); persistSettings(); applySettings(); };
    var dsEl = $('st-dayspeed'); if (dsEl) dsEl.onchange = function () { settings.daySpeed = parseFloat(dsEl.value); persistSettings(); applySettings(); };
    var csEl = $('st-camsens'); if (csEl) csEl.oninput = function () {
      settings.camSensitivity = Math.round(parseFloat(csEl.value) * 10) / 10;
      var v = $('st-camsens-val'); if (v) v.textContent = settings.camSensitivity.toFixed(1) + '×';
      persistSettings();
    };
    // Dữ liệu: xuất / tải / nhập / xóa
    var ioEl = $('st-io');
    var exBtn = $('st-export-btn'); if (exBtn) exBtn.onclick = function () { if (ioEl) { ioEl.value = C.exportSave(state); ioEl.select(); } };
    var dlBtn = $('st-download-btn'); if (dlBtn) dlBtn.onclick = function () {
      try {
        var blob = new Blob([C.exportSave(state)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'village-rpg-save.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      } catch (e) { if (ioEl) ioEl.value = C.exportSave(state); toast('Không tải được file — đã hiện mã save để chép tay.'); }
    };
    function doImport(text) {
      var r = C.importSave(text);
      if (!r.ok) { toast('❌ Mã save không hợp lệ (' + r.reason + ') — save cũ vẫn nguyên vẹn.', true); return; }
      localStorage.setItem(C.SAVE_KEY, C.serialize(r.state));
      toast('✅ Đã nhập save! Đang tải lại game…');
      setTimeout(function () { location.reload(); }, 600);
    }
    var imBtn = $('st-import-btn'); if (imBtn) imBtn.onclick = function () { if (ioEl) doImport(ioEl.value); };
    var fileEl = $('st-import-file'); if (fileEl) fileEl.onchange = function () {
      var f = fileEl.files && fileEl.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { doImport(String(rd.result || '')); };
      rd.readAsText(f);
    };
    var wipeBtn = $('st-wipe-btn');
    if (wipeBtn) wipeBtn.onclick = function () {
      if (wipeBtn.dataset.armed) { SaveSystem.wipe(); location.reload(); return; }
      wipeBtn.dataset.armed = '1';
      wipeBtn.textContent = '⚠️ Bấm LẦN NỮA để xác nhận XÓA TOÀN BỘ save';
      setTimeout(function () { if (wipeBtn) { delete wipeBtn.dataset.armed; wipeBtn.textContent = '🗑️ Xóa save'; } }, 4000);
    };
    var rsBtn = $('st-reset-btn'); if (rsBtn) rsBtn.onclick = function () {
      settings = C.defaultSettings();
      persistSettings(); applySettings(); renderSettings();
      toast('↺ Đã đặt lại cài đặt về mặc định.');
    };
  }
  // Phơi bày cho harness kiểm chứng (chỉ đọc + áp dụng): trạng thái settings thật đang chạy.
  window.__VRPG_SETTINGS = {
    get: function () { return settings; },
    apply: function () { applySettings(); },
    set: function (patch) { for (var k in patch) settings[k] = patch[k]; persistSettings(); applySettings(); },
    camDist: function () { return camDist; },
    floatTextOn: function () { return settings.floatText; },
    rendererInfo: function () {
      return {
        pixelRatio: (renderer.getPixelRatio ? renderer.getPixelRatio() : null),
        shadowEnabled: !!renderer.shadowMap.enabled,
        shadowSize: sun.shadow.mapSize.x,
        sunCastShadow: !!sun.castShadow
      };
    }
  };

  /* ================= Input ================= */
  addEventListener('keydown', function (e) {
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') e.preventDefault();
    keys[e.code] = true;
    if (!started) return;
    if (e.code === 'KeyE') { var it = nearestInteractable(); if (it && !buildMode.active) it.act(); }
    if (e.code === 'KeyF') basicAttack();
    if (e.code === 'Digit1') castSkill('slash');
    if (e.code === 'Digit2') castSkill('fireball');
    if (e.code === 'Digit3') castSkill('arrow');
    if (e.code === 'KeyB') { buildMode.active ? closeBuild() : openBuild(); }
    if (e.code === 'KeyI') { $('panel').classList.contains('hidden') ? renderInventory() : closePanel(); }
    if (e.code === 'KeyG') { $('panel').classList.contains('hidden') ? renderGems() : closePanel(); }
    if (e.code === 'KeyZ') setOrder('follow');
    if (e.code === 'KeyX') setOrder('guard');
    if (e.code === 'KeyC') setOrder('attack');
    if (e.code === 'KeyV') setAimbot(!aimbotOn());
    if (e.code === 'KeyT') {
      var best = null, bd = 1e9;
      enemies.forEach(function (en) { if (en.alive) { var d = dist2d(player.group.position.x, player.group.position.z, en.group.position.x, en.group.position.z); if (d < bd) { bd = d; best = en; } } });
      if (best) { markedTarget = best; toast('🎯 Đã đánh dấu: ' + best.def.name + ' (đồng đội ở lệnh Tấn công sẽ lao vào)'); }
    }
    if (e.code === 'KeyR' && buildMode.active) buildMode.rot += Math.PI / 4;
    if (e.code === 'Escape') { closePanel(); if (buildMode.active) closeBuild(); }
  });
  addEventListener('keyup', function (e) { keys[e.code] = false; });
  $('interact-prompt').onclick = function () { if (!started) return; var it = nearestInteractable(); if (it && !buildMode.active) it.act(); };
  var dragging = false, lastMX = 0, lastMY = 0;
  renderer.domElement.addEventListener('mousedown', function (e) {
    if (!started) return;
    if (buildMode.active) { if (e.button === 0) confirmBuild(); return; }
    dragging = true; lastMX = e.clientX; lastMY = e.clientY;
    if (e.button === 0 && document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock && renderer.domElement.requestPointerLock();
    }
  });
  addEventListener('mouseup', function () { dragging = false; });
  addEventListener('mousemove', function (e) {
    mouseNDC.x = (e.clientX / innerWidth) * 2 - 1;
    mouseNDC.y = -(e.clientY / innerHeight) * 2 + 1;
    if (!started) return;
    if (document.pointerLockElement === renderer.domElement) {
      camYaw -= e.movementX * 0.0032 * settings.camSensitivity;
      camPitch = Math.max(0.08, Math.min(1.2, camPitch + e.movementY * 0.0028 * settings.camSensitivity));
    } else if (dragging) {
      camYaw -= (e.clientX - lastMX) * 0.005 * settings.camSensitivity;
      camPitch = Math.max(0.08, Math.min(1.2, camPitch + (e.clientY - lastMY) * 0.004 * settings.camSensitivity));
      lastMX = e.clientX; lastMY = e.clientY;
    }
  });
  addEventListener('click', function (e) {
    if (!started || buildMode.active) return;
    if (document.pointerLockElement === renderer.domElement && e.target === renderer.domElement) basicAttack();
  });
  addEventListener('wheel', function (e) {
    // Bước zoom TỈ LỆ theo khoảng cách hiện tại (xa thì bước lớn)
    // Giữ nguyên quy ước dấu cũ: lăn xuống (deltaY > 0) = camera xa ra, lăn lên = lại gần.
    var step = Math.max(1.2, camDist * 0.12);
    camDist = clampCamDist(camDist + Math.sign(e.deltaY) * step);
  }, { passive: true });
  addEventListener('resize', function () {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  // Nút HUD
  document.querySelectorAll('.skill-btn[data-skill]').forEach(function (b) { b.onclick = function () { castSkill(b.dataset.skill); }; });
  $('btn-attack').onclick = function () { basicAttack(); };
  $('btn-aim').onclick = function () { setAimbot(!aimbotOn()); };
  document.querySelectorAll('.order-btn').forEach(function (b) { b.onclick = function () { setOrder(b.dataset.order); }; });
  $('btn-build').onclick = function () { buildMode.active ? closeBuild() : openBuild(); };
  $('btn-inventory').onclick = function () { renderInventory(); };
  $('btn-gems').onclick = function () { renderGems(); };
  $('btn-help').onclick = function () { renderHelp(); };
  var setBtn = $('btn-settings'); if (setBtn) setBtn.onclick = function () { renderSettings(); };
  var setBtn2 = $('btn-settings-start'); if (setBtn2) setBtn2.onclick = function () { renderSettings(); };
  $('btn-event').onclick = function () { renderMerchant(); };
  $('tut-tip').onclick = function () { hideTut(); };
  $('tut-skip').onclick = function (e) { e.stopPropagation(); state.flags.tut_done = true; hideTut(); SaveSystem.save(); toast('Đã tắt hướng dẫn lần đầu. Xem lại bất cứ lúc nào trong panel ❓.'); };
  $('panel-close').onclick = function () { closePanel(); };
  $('btn-newgame').onclick = function () {
    if (confirm('Chơi mới sẽ XÓA toàn bộ save hiện tại. Bạn chắc chắn?')) { SaveSystem.wipe(); location.reload(); }
  };
  // Cảm ứng cơ bản
  if ('ontouchstart' in window) {
    $('touch-ui').classList.remove('hidden');
    var joy = $('joystick'), knob = $('joystick-knob'), joyId = null;
    joy.addEventListener('touchstart', function (e) { joyId = e.changedTouches[0].identifier; }, { passive: true });
    addEventListener('touchmove', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier === joyId) {
          var r = joy.getBoundingClientRect();
          var dx = (t.clientX - (r.left + 55)) / 45, dy = (t.clientY - (r.top + 55)) / 45;
          var l = Math.sqrt(dx * dx + dy * dy); if (l > 1) { dx /= l; dy /= l; }
          touchMove.x = dx; touchMove.z = -dy; touchMove.active = true;
          knob.style.left = (35 + dx * 30) + 'px'; knob.style.top = (35 + dy * 30) + 'px';
        }
      }
    }, { passive: true });
    addEventListener('touchend', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === joyId) {
        joyId = null; touchMove.active = false; touchMove.x = 0; touchMove.z = 0;
        knob.style.left = '35px'; knob.style.top = '35px';
      }
    });
    // Vuốt nửa phải để xoay camera + PINCH ZOOM 2 ngón trên canvas.
    // Pinch-out (hai ngón mở ra) = phóng to = camera lại gần.
    // hai ngón CHỤM LẠI (pinch-in) = thu nhỏ = camera XA RA (camDist TĂNG).
    var camTouchId = null, camLX = 0;
    var pinchOn = false, pinchPrev = 0; // pinchOn: đang chụm/mở 2 ngón; pinchPrev: khoảng cách 2 ngón ở lần move trước
    function canvasTouchList(e) { return e.targetTouches || e.touches || []; }
    renderer.domElement.addEventListener('touchstart', function (e) {
      if (canvasTouchList(e).length >= 2) { pinchOn = true; pinchPrev = 0; camTouchId = null; return; } // vào pinch: hủy xoay 1 ngón để tránh giật
      var t = e.changedTouches[0]; if (t.clientX > innerWidth / 2) { camTouchId = t.identifier; camLX = t.clientX; }
    }, { passive: true });
    renderer.domElement.addEventListener('touchmove', function (e) {
      var tl = canvasTouchList(e);
      if (tl.length >= 2) {
        var ddx = tl[0].clientX - tl[1].clientX, ddy = tl[0].clientY - tl[1].clientY;
        var dist2 = Math.sqrt(ddx * ddx + ddy * ddy);
        // dist2 tăng (mở ngón) -> trừ camDist (lại gần); dist2 giảm (chụm ngón) -> cộng camDist (xa ra)
        if (pinchPrev > 0) camDist = clampCamDist(camDist - (dist2 - pinchPrev) * 0.08);
        pinchPrev = dist2; pinchOn = true;
        return; // đang pinch thì KHÔNG xoay camera
      }
      if (pinchOn) return; // vừa rời pinch nhưng ngón còn lại chưa nhấc hết: bỏ qua, tránh camera nhảy
      for (var i = 0; i < e.changedTouches.length; i++) { var t = e.changedTouches[i]; if (t.identifier === camTouchId) { camYaw -= (t.clientX - camLX) * 0.008 * settings.camSensitivity; camLX = t.clientX; } }
    }, { passive: true });
    function camTouchCleanup(e) { // touchend/touchcancel: còn <2 ngón trên canvas là kết thúc pinch, dọn trạng thái sạch
      if (canvasTouchList(e).length < 2) { pinchOn = false; pinchPrev = 0; }
      for (var i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === camTouchId) camTouchId = null;
    }
    renderer.domElement.addEventListener('touchend', camTouchCleanup);
    renderer.domElement.addEventListener('touchcancel', camTouchCleanup);
    $('t-atk').onclick = function () { basicAttack(); };
    $('t-act').onclick = function () { var it = nearestInteractable(); if (it) it.act(); };
    $('t-jump').onclick = function () { castSkill('fireball'); };
  }

  /* ================= Vòng lặp chính ================= */
  var lastT = performance.now(), saveTimer = 0;
  var fpsFrames = 0, fpsTimer = 0; // đo FPS thật (hiển thị khi bật trong Cài đặt, cập nhật 2 lần/giây)
  player.basicCd = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    var realDt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    var dt = realDt;
    if (hitStopT > 0) { hitStopT -= realDt; dt = 0; } // HIT-STOP: đóng băng LOGIC theo thời gian thật, render vẫn chạy
    frameNo++;
    if (started && frameNo % 6 === 0) updateOcclusion(); // occlusion giản lược: 10 lần/giây là đủ
    if (started && !player.dead && dt > 0) {
      gameTime += dt;
      if (player.basicCd > 0) player.basicCd -= dt;
      updatePlayer(dt);
      updateAimbot(dt);
      updateEnemies(dt);
      updateCompanions(dt);
      updateProjectiles(dt);
      updateTelegraphs(dt);
      updateProduction(dt);
      updateEvents(dt);
      updateGhost();
      elder.group.rotation.y = Math.sin(gameTime * 0.7) * 0.4;
      mistPlanes.forEach(function (mp, mi) { mp.rotation.y += dt * 0.04 * (mi % 3 + 1); }); // sương trôi rất chậm
      // Nhắc lệnh active
      document.querySelectorAll('.order-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.order === state.order); });
      updateHUD();
      saveTimer += dt;
      if (saveTimer > 10) { saveTimer = 0; SaveSystem.save(); }
    } else if (started) {
      updateTelegraphs(realDt);
    }
    // Hiệu ứng theo thời gian thật — vẫn chạy trong hit-stop.
    if (started) {
      updateFloatTexts(realDt);
      updateFlashes(realDt);
      updateParticles(realDt);
      if (healFloatAcc >= 1 && gameTime - lastHealFloat > 0.35) {
        spawnFloatText(player.group.position, '+' + Math.round(healFloatAcc), '#69f0ae'); // số nổi HỒI MÁU (xanh lá)
        healFloatAcc = 0; lastHealFloat = gameTime;
      }
    }
    updateDayNight(realDt); // chu kỳ ngày–đêm: chạy theo thời gian thật, kể cả trong hit-stop
    updateDecor(realDt); // trang trí động: cánh cối xay gió + mây trôi + cờ phấp phới
    // FPS: đếm khung theo thời gian thật; ghi vào overlay 2 lần/giây khi đang bật trong Cài đặt
    fpsFrames++; fpsTimer += realDt;
    if (fpsTimer >= 0.5) {
      var fpsNow = Math.round(fpsFrames / fpsTimer);
      fpsFrames = 0; fpsTimer = 0;
      if (settings.showFps) { var fe2 = $('fps-overlay'); if (fe2) fe2.textContent = fpsNow + ' FPS'; }
    }
    CameraController.update(realDt || 0.016);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);

  /* ================= Bắt đầu ================= */
  if (hadSave) $('start-continue-note').textContent = '💾 Đã tìm thấy save cũ trên trình duyệt này — vào game sẽ tiếp tục đúng tiến trình.';
  applySettings(); // áp cài đặt đã lưu (bóng/phân giải/aimbot/FPS) ngay từ đầu phiên
  checkQuests(); // áp thưởng còn treo nếu có
  updateHUD();
  paintAimBtn(); // khôi phục trạng thái nút 🎯 từ flags.aimbotOn của save (mặc định tắt)
  // Handler nút Vào game đã gắn SỚM ở đầu file — không gắn lại ở đây.
})();
