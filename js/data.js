/* data.js — Định nghĩa dữ liệu (definitions) tách khỏi state phiên chơi.
   Mọi thực thể có ID ổn định. Dùng được ở browser (window.VRPG_DATA) và Node (module.exports) để test. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VRPG_DATA = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RESOURCES = ['wood', 'gold', 'food', 'dark']; // Đúng 4 tài nguyên cốt lõi
  var RESOURCE_NAMES = { wood: 'Gỗ', gold: 'Vàng', food: 'Thức ăn', dark: 'Hắc Kim' };

  /* ---------------- Công trình ---------------- */
  var BUILDINGS = {
    townhall:  { id: 'townhall',  name: 'Nhà chính',     cost: {},                                  size: 4, color: 0x8b5a2b, desc: 'Trung tâm làng. Hồi sinh tại đây.' },
    house:     { id: 'house',     name: 'Nhà ở',         cost: { wood: 20, gold: 5 },               size: 3, color: 0xd9a05b, desc: '+1 giới hạn đồng đội, nơi nghỉ ngơi.' },
    lumber:    { id: 'lumber',    name: 'Trại khai thác gỗ', cost: { wood: 15, gold: 5 },           size: 3, color: 0x6aa84f, desc: 'Sản xuất +3 Gỗ / 10 giây.', produces: { res: 'wood', amount: 3, interval: 10 } },
    farm:      { id: 'farm',      name: 'Trang trại',    cost: { wood: 15, gold: 5 },               size: 3, color: 0xe3c565, desc: 'Sản xuất +3 Thức ăn / 10 giây.', produces: { res: 'food', amount: 3, interval: 10 } },
    warehouse: { id: 'warehouse', name: 'Kho tài nguyên', cost: { wood: 25, gold: 10 },              size: 3, color: 0x9c6644, desc: 'Thương lái ghé kho: +4 Vàng / 30 giây.', produces: { res: 'gold', amount: 4, interval: 30 } },
    barracks:  { id: 'barracks',  name: 'Doanh trại',    cost: { wood: 30, gold: 15, food: 10 },     size: 3.5, color: 0x7f5539, desc: 'Chiêu mộ đồng đội (đến gần, phím E).' },
    forge:     { id: 'forge',     name: 'Lò rèn',        cost: { wood: 20, gold: 20, dark: 1 },      size: 3, color: 0x606c78, desc: 'Rèn trang bị ngẫu nhiên (đến gần, phím E).' },
    altar:     { id: 'altar',     name: 'Đài kỹ năng',   cost: { wood: 25, gold: 25, dark: 2 },      size: 3, color: 0x7b5ea7, desc: 'Mở khóa sau boss đầu tiên. Nhận đá hỗ trợ (đến gần, phím E).', locked: 'boss' },
    darkmine:  { id: 'darkmine',  name: 'Mỏ Hắc Kim',    cost: { wood: 40, gold: 30, food: 10 },     size: 3, color: 0x3d348b, desc: 'Sản xuất +1 Hắc Kim / 25 giây.', produces: { res: 'dark', amount: 1, interval: 25 } },
    /* --- 6 công trình mới (đợt mở rộng): cat = tab menu xây (home/prod/special); tham số chức năng ở các khối riêng bên dưới --- */
    market:    { id: 'market',    name: 'Chợ',           cost: { wood: 35, gold: 15 },               size: 4, cat: 'special', color: 0xc96f3b, desc: 'Đổi tài nguyên theo tỉ lệ cố định (đến gần, phím E). Vàng nhận thêm +10% mỗi cấp trên 1.' },
    windmill:  { id: 'windmill',  name: 'Cối xay gió',   cost: { wood: 45, gold: 10 },               size: 3, cat: 'prod',    color: 0xd9a441, desc: 'Cánh quạt xoay thật. Tăng sản lượng MỌI Trang trại: +30/40/50% theo cấp (chỉ tính cối mạnh nhất, trần +50%).' },
    shrine:    { id: 'shrine',    name: 'Đền thờ nhỏ',   cost: { wood: 20, gold: 10, dark: 3 },      size: 3, cat: 'special', color: 0x8e7fb8, desc: 'Tăng trọng số rơi vật phẩm Hiếm/Huyền thoại khi quay loot: ×1.5/2/2.5 theo cấp (chỉ tính đền mạnh nhất).' },
    tavern:    { id: 'tavern',    name: 'Quán ăn',       cost: { wood: 30, food: 15 },               size: 4, cat: 'home',    color: 0xc89b6c, desc: 'Đứng trong bán kính 6 quanh quán: hồi 1 máu + 2 năng lượng mỗi giây cho mỗi cấp của quán.' },
    library:   { id: 'library',   name: 'Nhà học',       cost: { wood: 35, gold: 20 },               size: 4, cat: 'special', color: 0x546a8a, desc: 'Tăng XP nhận khi hạ quái: +15/25/35% theo cấp (chỉ tính nhà học mạnh nhất).' },
    watchtower:{ id: 'watchtower',name: 'Tháp canh',     cost: { wood: 40, gold: 5 },                size: 3, cat: 'special', color: 0x7a4a2b, desc: 'Quái trong bán kính tháp bị chậm 20% (bán kính 8/10/12 theo cấp; nhiều tháp không cộng dồn).' }
  };
  // Tab cho 9 công trình cũ (menu xây nhóm: Nhà ở / Sản xuất / Đặc biệt)
  BUILDINGS.house.cat = 'home';
  BUILDINGS.lumber.cat = 'prod'; BUILDINGS.farm.cat = 'prod'; BUILDINGS.warehouse.cat = 'prod'; BUILDINGS.darkmine.cat = 'prod';
  BUILDINGS.barracks.cat = 'special'; BUILDINGS.forge.cat = 'special'; BUILDINGS.altar.cat = 'special';

  /* ---------------- Tham số chức năng 6 công trình mới (đợt mở rộng) ----------------
     Mọi hệ số nằm tại đây; logic thuần áp dụng trong core.js, hiệu ứng runtime trong game.js. */
  var MARKET_TRADES = [ // chợ: tỉ lệ cố định; vàng nhận được x (1 + 0.1 x (cấp chợ - 1)) ở core.marketTrade
    { id: 'wood_gold', label: '10 Gỗ → 6 Vàng', cost: { wood: 10 }, gain: { gold: 6 } },
    { id: 'food_gold', label: '10 Thức ăn → 8 Vàng', cost: { food: 10 }, gain: { gold: 8 } },
    { id: 'gold_dark', label: '20 Vàng → 5 Hắc Kim', cost: { gold: 20 }, gain: { dark: 5 } }
  ];
  var WINDMILL_FARM_BONUS = { 1: 0.30, 2: 0.40, 3: 0.50 }; // theo cấp cối MẠNH NHẤT — không cộng dồn, trần +50%
  var SHRINE_LOOT_MULT = { 1: 1.5, 2: 2.0, 3: 2.5 };        // x trọng số rarity rare + legendary, theo cấp đền MẠNH NHẤT
  var LIBRARY_XP_BONUS = { 1: 0.15, 2: 0.25, 3: 0.35 };     // +XP, theo cấp nhà học MẠNH NHẤT
  var TAVERN_REGEN = { radius: 6, hpPerSecPerLevel: 1, enPerSecPerLevel: 2 }; // bán kính cố định; tốc độ hồi x cấp quán gần nhất
  var WATCHTOWER_SLOW = { pct: 0.20, radiusByLevel: { 1: 8, 2: 10, 3: 12 } }; // chậm 20% — không cộng dồn giữa các tháp

  /* ---------------- Nâng cấp công trình (Mục 5) ----------------
     cost lên cấp lưu tại def.upgrades[level]; sản xuất xlevel (core.productionFor).
     Hiệu ứng theo cấp: Trại gỗ/Trang trại/Mỏ/Kho xlevel sản lượng; Doanh trại giảm giá chiêu mộ + tăng sức đồng đội (core);
     Kho tăng +5%/cấp trên cấp 1 cho sản lượng toàn cục (core.productionGlobalMult). */
  var BUILDING_UPGRADES = {
    house:     { 2: { wood: 20, gold: 10 },              3: { wood: 30, gold: 20, dark: 1 } },
    lumber:    { 2: { wood: 20, gold: 10 },              3: { wood: 35, gold: 20, dark: 1 } },
    farm:      { 2: { wood: 20, gold: 10 },              3: { wood: 35, gold: 20, dark: 1 } },
    warehouse: { 2: { wood: 25, gold: 15 },              3: { wood: 40, gold: 25, dark: 1 } },
    barracks:  { 2: { wood: 25, gold: 20, food: 10 },    3: { wood: 40, gold: 35, food: 15, dark: 1 } },
    forge:     { 2: { wood: 20, gold: 25, dark: 1 },     3: { wood: 35, gold: 40, dark: 2 } },
    altar:     { 2: { wood: 25, gold: 30, dark: 2 },     3: { wood: 40, gold: 45, dark: 3 } },
    darkmine:  { 2: { wood: 45, gold: 35, food: 10, dark: 1 }, 3: { wood: 60, gold: 50, food: 15, dark: 2 } },
    market:    { 2: { wood: 30, gold: 20 },              3: { wood: 45, gold: 35, dark: 1 } },
    windmill:  { 2: { wood: 35, gold: 15 },              3: { wood: 50, gold: 25, dark: 1 } },
    shrine:    { 2: { wood: 20, gold: 15, dark: 2 },     3: { wood: 30, gold: 25, dark: 3 } },
    tavern:    { 2: { wood: 25, gold: 10, food: 10 },    3: { wood: 40, gold: 20, food: 15 } },
    library:   { 2: { wood: 30, gold: 25 },              3: { wood: 45, gold: 40, dark: 1 } },
    watchtower:{ 2: { wood: 30, gold: 10 },              3: { wood: 45, gold: 20, dark: 1 } }
  };
  Object.keys(BUILDING_UPGRADES).forEach(function (id) { if (BUILDINGS[id]) BUILDINGS[id].upgrades = BUILDING_UPGRADES[id]; });

  /* ---------------- Trang bị ---------------- */
  var RARITIES = ['common', 'magic', 'rare', 'legendary'];
  var RARITY_NAMES = { common: 'Thường', magic: 'Ma thuật', rare: 'Hiếm', legendary: 'Huyền thoại' };
  var SLOTS = ['helmet', 'armor', 'weapon', 'offhand', 'ring', 'amulet'];
  var SLOT_NAMES = { helmet: 'Mũ', armor: 'Giáp', weapon: 'Vũ khí', offhand: 'Tay phụ', ring: 'Nhẫn', amulet: 'Dây chuyền' };

  // stats: str/int/agi/armor/resist(0-100 phần trăm)/maxHp/maxEnergy
  var ITEMS = {
    train_sword:  { id: 'train_sword',  name: 'Kiếm Gỗ Huấn Luyện', slot: 'weapon', rarity: 'common',    stats: { str: 2 }, desc: 'Kiếm gỗ của trưởng làng.' },
    iron_sword:   { id: 'iron_sword',   name: 'Kiếm Sắt',           slot: 'weapon', rarity: 'magic',     stats: { str: 5 }, desc: 'Lưỡi sắt rèn tay.' },
    flame_blade:  { id: 'flame_blade',  name: 'Hỏa Diệm Kiếm',      slot: 'weapon', rarity: 'rare',      stats: { str: 8, int: 4 }, desc: 'Ấm lên khi cầm. Kỹ năng lửa mạnh hơn nhờ INT.' },
    dragon_fang:  { id: 'dragon_fang',  name: 'Nanh Rồng Cổ',       slot: 'weapon', rarity: 'legendary', stats: { str: 14, int: 8, agi: 4 }, desc: 'Vũ khí huyền thoại rơi từ boss.' },
    cloth_cap:    { id: 'cloth_cap',    name: 'Mũ Vải',             slot: 'helmet', rarity: 'common',    stats: { armor: 2, maxHp: 10 }, desc: 'Mũ vải dày.' },
    seer_hood:    { id: 'seer_hood',    name: 'Mũ Trùm Tiên Tri',   slot: 'helmet', rarity: 'rare',      stats: { int: 7, maxEnergy: 15 }, desc: 'Nhìn xa trông rộng.' },
    leather_armor:{ id: 'leather_armor',name: 'Giáp Da',            slot: 'armor',  rarity: 'common',    stats: { armor: 5, maxHp: 15 }, desc: 'Giáp da thuộc.' },
    plate_armor:  { id: 'plate_armor',  name: 'Giáp Tấm Sắt',       slot: 'armor',  rarity: 'magic',     stats: { armor: 11, maxHp: 25 }, desc: 'Nặng nhưng chắc.' },
    wooden_shield:{ id: 'wooden_shield',name: 'Khiên Gỗ',           slot: 'offhand',rarity: 'common',    stats: { armor: 4 }, desc: 'Khiên gỗ sồi.' },
    ember_orb:    { id: 'ember_orb',    name: 'Ngọc Than Hồng',     slot: 'offhand',rarity: 'rare',      stats: { int: 9, resist: 10 }, desc: 'Ngọc ấm chứa lửa tàn.' },
    copper_ring:  { id: 'copper_ring',  name: 'Nhẫn Đồng',          slot: 'ring',   rarity: 'common',    stats: { agi: 2 }, desc: 'Nhẫn đồng đơn giản.' },
    swift_ring:   { id: 'swift_ring',   name: 'Nhẫn Tật Phong',     slot: 'ring',   rarity: 'magic',     stats: { agi: 6 }, desc: 'Bước chân nhẹ hơn.' },
    sage_amulet:  { id: 'sage_amulet',  name: 'Dây Chuyền Hiền Triết', slot: 'amulet', rarity: 'magic',  stats: { int: 5, maxEnergy: 10 }, desc: 'Tăng trí tuệ và năng lượng.' },
    dark_amulet:  { id: 'dark_amulet',  name: 'Dây Chuyền Hắc Kim', slot: 'amulet', rarity: 'legendary', stats: { int: 10, str: 6, resist: 15 }, desc: 'Đúc từ Hắc Kim nguyên chất.' }
  };
  var LOOT_TABLE = ['iron_sword', 'cloth_cap', 'leather_armor', 'wooden_shield', 'copper_ring', 'sage_amulet', 'swift_ring', 'plate_armor', 'seer_hood', 'ember_orb', 'flame_blade'];

  /* ---------------- Kỹ năng & đá ---------------- */
  // kind: melee | projectile ; element: physical | fire
  var SKILLS = {
    slash:    { id: 'slash',    name: 'Chém Nhanh', kind: 'melee',      element: 'physical', base: 12, statScale: 'str', energy: 8,  cooldown: 1.2, range: 3.0, desc: 'Chém vòng cung trước mặt. Tăng theo STR.' },
    fireball: { id: 'fireball', name: 'Cầu Lửa',    kind: 'projectile', element: 'fire',     base: 16, statScale: 'int', energy: 14, cooldown: 2.0, speed: 26, aoe: 2.2, desc: 'Bắn cầu lửa nổ diện. Tăng theo INT.' },
    arrow:    { id: 'arrow',    name: 'Mũi Tên Bóng', kind: 'projectile', element: 'physical', base: 11, statScale: 'agi', energy: 6, cooldown: 0.9, speed: 34, desc: 'Mũi tên nhanh, rẻ năng lượng. Tăng theo AGI.' }
  };

  // Đá hỗ trợ: compatible = danh sách kind hoặc 'all'. Modifiers áp dụng trong core.applyGems.
  var GEMS = {
    split:   { id: 'split',   name: 'Đá Phân Tách',    type: 'support', compatible: ['projectile'], desc: '+2 đạn phụ (mỗi đạn 65% sát thương). Chỉ đạn.', mods: { extraProjectiles: 2, damageMult: 0.65 } },
    pierce:  { id: 'pierce',   name: 'Đá Xuyên Thấu',  type: 'support', compatible: ['projectile'], desc: 'Đạn xuyên qua tối đa 2 kẻ địch. Chỉ đạn.', mods: { pierce: 2 } },
    lifesteal:{ id: 'lifesteal', name: 'Đá Hút Sinh Lực', type: 'support', compatible: 'all',       desc: 'Hồi máu bằng 15% sát thương gây ra.', mods: { lifesteal: 0.15 } },
    empower: { id: 'empower', name: 'Đá Cường Hóa',    type: 'support', compatible: 'all',            desc: '+50% sát thương nhưng +50% năng lượng tốn.', mods: { damageMultBonus: 0.5, energyMult: 1.5 } },
    expand:  { id: 'expand',  name: 'Đá Mở Rộng',      type: 'support', compatible: 'all',            desc: 'Tăng 60% phạm vi/vùng nổ của kỹ năng.', mods: { aoeMult: 1.6, rangeMult: 1.6 } },
    emberheart: { id: 'emberheart', name: 'Đá Biến Đổi: Tim Than', type: 'transform', compatible: ['projectile'], desc: 'Biến đổi đặc biệt: cầu lửa/mũi tên gây thêm sát thương lửa theo INT.', mods: { addFireFromInt: 0.5 } },
    /* --- 5 đá mới (vòng hoàn thiện theo góp ý) --- */
    energy_siphon: { id: 'energy_siphon', name: 'Đá Hồi Năng Lượng', type: 'support', compatible: 'all', desc: 'Mỗi đòn trúng đích hồi lại 2 năng lượng (EN).', mods: { energyOnHit: 2 } },
    thorns:    { id: 'thorns',    name: 'Đá Phản Đòn',    type: 'support', compatible: 'all',            desc: 'Phản 25% sát thương cận chiến nhận vào lên kẻ tấn công.', mods: { reflectPct: 0.25 } },
    blast:     { id: 'blast',     name: 'Đá Bùng Nổ',     type: 'support', compatible: ['projectile'],  desc: 'Đạn trúng gây nổ: địch quanh điểm nổ (bán kính 2.5) nhận 50% sát thương của đòn. Chỉ đạn.', mods: { blastPct: 0.5, blastRadius: 2.5 } },
    warbanner: { id: 'warbanner', name: 'Đá Quân Kỳ',     type: 'support', compatible: 'all',            desc: 'Hào quang đồng đội: đồng đội +25% sát thương khi có đá này lắp ở bất kỳ kỹ năng nào.', mods: { allyDamagePct: 0.25 } },
    overload:  { id: 'overload',  name: 'Đá Biến Đổi: Quá Tải', type: 'transform', compatible: ['projectile', 'melee'], skills: ['arrow', 'slash'], desc: 'Biến đổi mạnh: +60% sát thương, nhưng tốn gấp đôi năng lượng và hồi chiêu +50%. Chỉ Mũi Tên Bóng / Chém Nhanh (đơn mục tiêu).', mods: { damageMultBonus: 0.6, energyMult: 2, cooldownMult: 1.5 } },
    frostbrand:{ id: 'frostbrand', name: 'Đá Biến Đổi: Sương Giá', type: 'transform', compatible: ['projectile'], desc: 'Thưởng hạ Sương Vương: đạn +30% sát thương và làm chậm địch 30% trong 2 giây.', mods: { damageMultBonus: 0.3, slowPct: 0.3, slowDuration: 2 } }
  };
  var MAX_GEMS_PER_SKILL = 3;

  /* ---------------- Kẻ địch ---------------- */
  var ENEMIES = {
    goblin: { id: 'goblin', name: 'Goblin Cận Chiến', kind: 'melee', hp: 45, dmg: 7,  speed: 3.4, range: 1.6, cooldown: 1.1, xp: 20, color: 0x4caf50, scale: 1.0, drops: { gold: [2, 6], food: [0, 3] } },
    archer: { id: 'archer', name: 'Cung Thủ Bóng Đêm', kind: 'ranged', hp: 32, dmg: 6, speed: 3.0, range: 11, cooldown: 1.8, xp: 28, color: 0x8e44ad, scale: 1.0, projectileSpeed: 18, drops: { gold: [3, 8], food: [0, 2] } },
    boss:   { id: 'boss',   name: 'Chúa Tể Sương Mù', kind: 'boss', hp: 420, dmg: 13, speed: 2.6, range: 2.4, cooldown: 1.4, xp: 200, color: 0xc0392b, scale: 2.2, drops: { gold: [40, 60], food: [5, 10], dark: [3, 5] }, telegraph: { radius: 6, windup: 1.5, dmg: 30, every: 7 } },
    boss2:  { id: 'boss2',  name: 'Sương Vương', kind: 'boss', hp: 900, dmg: 18, speed: 2.9, range: 2.6, cooldown: 1.2, xp: 450, color: 0x5c6bc0, scale: 2.6, drops: { gold: [80, 120], food: [10, 15], dark: [8, 12] }, telegraph: { radius: 7.5, windup: 1.1, dmg: 45, every: 5.5 } },
    beast:  { id: 'beast',  name: 'Thú Hoang', kind: 'melee', hp: 35, dmg: 6, speed: 4.2, range: 1.6, cooldown: 1.0, xp: 15, color: 0x795548, scale: 0.9, drops: { food: [2, 4] } }
  };

  /* ---------------- Event làng ngẫu nhiên (Mục 5) ----------------
     Trạng thái event là RUNTIME (không lưu save) — logic chọn/áp thưởng nằm ở core.js. */
  var VILLAGE_EVENTS = [
    { id: 'merchant', name: 'Thương nhân ghé làng', duration: 90, desc: 'Một thương nhân dừng chân 90 giây. Mở panel sự kiện để giao dịch (mỗi món đổi 1 lần).', offers: [
      { id: 'buy_food', label: 'Mua 10 Thức ăn', cost: { gold: 8 }, gain: { food: 10 } },
      { id: 'sell_dark', label: 'Đổi 3 Hắc Kim lấy 45 Vàng', cost: { dark: 3 }, gain: { gold: 45 } },
      { id: 'buy_dark', label: 'Mua 1 Hắc Kim', cost: { gold: 18 }, gain: { dark: 1 } }
    ] },
    { id: 'harvest_festival', name: 'Lễ hội thu hoạch', duration: 0, desc: 'Cả làng mở hội: nhận Thức ăn = 5 + 6 cho mỗi Trang trại đang có.' },
    { id: 'wild_beasts', name: 'Thú hoang quấy phá', duration: 120, desc: '2 con thú hoang mò vào gần cổng làng! Diệt cả 2 để nhận thưởng 20 Vàng + 10 Gỗ.' }
  ];

  /* ---------------- Đồng đội ---------------- */
  var COMPANION = { id: 'guard', name: 'Lính Canh', hp: 90, dmg: 9, speed: 5.2, range: 1.8, cooldown: 1.0, cost: { gold: 15, food: 10 } };
  var ORDERS = ['follow', 'guard', 'attack'];
  var ORDER_NAMES = { follow: 'Theo sau', guard: 'Giữ vị trí / Bảo vệ', attack: 'Tấn công mục tiêu đánh dấu' };

  /* ---------------- Nhiệm vụ (chuỗi đầu-cuối, mục IX) ---------------- */
  var QUESTS = [
    { id: 'q1',  name: 'Thu thập Gỗ',        desc: 'Chặt cây thu 20 Gỗ (tới gần cây, phím E).',        goal: { type: 'stat', key: 'woodHarvested', count: 20 }, reward: { gold: 10 } },
    { id: 'q2',  name: 'Dựng công trình đầu tiên', desc: 'Mở menu Xây (phím B) và đặt 1 công trình bất kỳ.', goal: { type: 'stat', key: 'buildingsPlaced', count: 1 }, reward: { wood: 10 } },
    { id: 'q3',  name: 'Tích trữ Thức ăn',   desc: 'Thu thập 15 Thức ăn (đánh quái rơi, hoặc xây Trang trại).', goal: { type: 'stat', key: 'foodGained', count: 15 }, reward: { gold: 10 } },
    { id: 'q4',  name: 'Nhận trang bị đầu tiên', desc: 'Nói chuyện với Trưởng làng cạnh Nhà chính (phím E) để nhận Kiếm Gỗ, rồi trang bị trong Túi đồ (phím I).', goal: { type: 'flag', key: 'gotFirstGear' }, reward: {} },
    { id: 'q5',  name: 'Vào khu nguy hiểm',  desc: 'Đi về phía Đông, qua cột mốc đỏ vào Khu Sương Mù.', goal: { type: 'flag', key: 'enteredDanger' }, reward: { food: 5 } },
    { id: 'q6',  name: 'Dọn quái',            desc: 'Tiêu diệt 3 quái trong Khu Sương Mù.',              goal: { type: 'stat', key: 'monstersKilled', count: 3 }, reward: { gold: 15 } },
    { id: 'q7',  name: 'Nhận thưởng chiến đấu', desc: 'Tiêu diệt thêm 2 quái để nhận Đá Phân Tách.',     goal: { type: 'stat', key: 'monstersKilled', count: 5 }, reward: { gem: 'split' } },
    { id: 'q8',  name: 'Đánh bại Boss',       desc: 'Tiêu diệt Chúa Tể Sương Mù ở cuối Khu Sương Mù. Né vòng đỏ báo hiệu!', goal: { type: 'flag', key: 'bossKilled' }, reward: { dark: 3, item: 'dragon_fang' } },
    { id: 'q9',  name: 'Trở về làng',         desc: 'Về nói chuyện với Trưởng làng (phím E): mở khóa Đài kỹ năng.', goal: { type: 'flag', key: 'reportedBack' }, reward: { gold: 25, gem: 'pierce' } },
    { id: 'q10', name: 'Sương Vương trỗi dậy', desc: 'Sương mù chưa tan: Sương Vương (mạnh hơn Chúa Tể) đã xuất hiện ở cuối Khu Sương Mù. Tiêu diệt nó!', goal: { type: 'flag', key: 'boss2Killed' }, reward: { dark: 6, gem: 'frostbrand' } },
    { id: 'q11', name: 'Nâng tầm ngôi làng',  desc: 'Nâng cấp 1 công trình bất kỳ lên Cấp 2: mở Xây (B) xem mục "Công trình đã xây", hoặc tới gần công trình và bấm E.', goal: { type: 'stat', key: 'buildingsUpgraded', count: 1 }, reward: { gold: 30 } }
  ];

  return {
    RESOURCES: RESOURCES, RESOURCE_NAMES: RESOURCE_NAMES,
    BUILDINGS: BUILDINGS, ITEMS: ITEMS, LOOT_TABLE: LOOT_TABLE,
    MARKET_TRADES: MARKET_TRADES, WINDMILL_FARM_BONUS: WINDMILL_FARM_BONUS,
    SHRINE_LOOT_MULT: SHRINE_LOOT_MULT, LIBRARY_XP_BONUS: LIBRARY_XP_BONUS,
    TAVERN_REGEN: TAVERN_REGEN, WATCHTOWER_SLOW: WATCHTOWER_SLOW,
    RARITIES: RARITIES, RARITY_NAMES: RARITY_NAMES, SLOTS: SLOTS, SLOT_NAMES: SLOT_NAMES,
    SKILLS: SKILLS, GEMS: GEMS, MAX_GEMS_PER_SKILL: MAX_GEMS_PER_SKILL,
    ENEMIES: ENEMIES, COMPANION: COMPANION, ORDERS: ORDERS, ORDER_NAMES: ORDER_NAMES, VILLAGE_EVENTS: VILLAGE_EVENTS,
    QUESTS: QUESTS
  };
});
