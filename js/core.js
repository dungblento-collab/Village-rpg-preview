/* core.js — Logic thuần (không phụ thuộc DOM/Three.js) để test được bằng Node.
   Chứa: ResourceSystem, công thức sát thương (CombatSystem), SkillSystem (đá hỗ trợ),
   BuildingSystem (kiểm tra đặt công trình), SaveSystem (serialize/version), QuestSystem (tiến trình).
   Dùng ở browser qua window.VRPG (game.js nạp data.js trước), và ở Node qua require. */
(function (root, factory) {
  var data = (typeof module !== 'undefined' && module.exports) ? require('./data.js') : root.VRPG_DATA;
  var api = factory(data);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VRPG = api;
})(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';

  var SAVE_VERSION = 1;
  var SAVE_KEY = 'projectVillageRPG.save.v1';

  /* ================= ResourceSystem =================
     Quy tắc: chi tiêu kiểm tra số dư trước; thất bại => KHÔNG trừ gì cả. */
  function createResources(init) {
    var r = { wood: 30, gold: 20, food: 20, dark: 0 };
    if (init) for (var k in r) if (typeof init[k] === 'number') r[k] = Math.max(0, Math.floor(init[k]));
    return r;
  }
  function canAfford(res, cost) {
    if (!cost) return true;
    for (var k in cost) { if ((res[k] || 0) < cost[k]) return false; }
    return true;
  }
  function spend(res, cost) { // trả false và không thay đổi gì nếu không đủ
    if (!canAfford(res, cost)) return false;
    for (var k in cost) res[k] -= cost[k];
    return true;
  }
  function add(res, gain) {
    if (!gain) return;
    for (var k in gain) { if (typeof res[k] === 'number') res[k] += gain[k]; }
  }
  function hasNegative(res) { for (var k in res) if (res[k] < 0) return true; return false; }

  /* ================= Chỉ số & sát thương =================
     Công thức (ghi rõ, áp dụng thật trong game):
       rawDamage    = skill.base + statValue * 1.2   (stat theo skill.statScale: str/int/agi)
       sau giáp     = raw * 100 / (100 + armor)       (giáp giảm dần, không bao giờ về 0)
       sau kháng    = * (1 - min(resist,75)/100)      chỉ với sát thương nguyên tố (fire)
       AGI tăng tỉ lệ chí mạng: critChance = 3% + AGI*0.4% ; chí mạng x1.6
       Năng lượng hồi 4/giây; hồi máu ngoài giao tranh 2/giây (game.js áp dụng). */
  var BASE_STATS = { maxHp: 100, maxEnergy: 50, str: 10, int: 10, agi: 10, armor: 0, resist: 0 };
  function computeStats(equippedIds) {
    var s = {}; for (var k in BASE_STATS) s[k] = BASE_STATS[k];
    (equippedIds || []).forEach(function (id) {
      var item = D.ITEMS[id]; if (!item) return;
      for (var st in item.stats) s[st] = (s[st] || 0) + item.stats[st];
    });
    return s;
  }
  function calcDamage(attackerStats, skill, defenderStats, rng) {
    var statVal = attackerStats[skill.statScale] || 0;
    var raw = skill.base + statVal * 1.2;
    var afterArmor = raw * 100 / (100 + Math.max(0, defenderStats.armor || 0));
    var final = afterArmor;
    if (skill.element !== 'physical') {
      var res = Math.min(75, Math.max(0, defenderStats.resist || 0));
      final = afterArmor * (1 - res / 100);
    }
    var critChance = 0.03 + (attackerStats.agi || 0) * 0.004;
    var crit = (rng ? rng() : Math.random()) < critChance;
    if (crit) final *= 1.6;
    return { damage: Math.max(1, Math.round(final)), crit: crit, raw: raw };
  }
  // Sát thương kẻ địch đánh người chơi/đồng đội (dạng đơn giản dùng cùng công thức giáp)
  function calcIncomingDamage(rawDmg, defenderStats, element) {
    var afterArmor = rawDmg * 100 / (100 + Math.max(0, defenderStats.armor || 0));
    if (element && element !== 'physical') {
      var res = Math.min(75, Math.max(0, defenderStats.resist || 0));
      afterArmor *= (1 - res / 100);
    }
    return Math.max(1, Math.round(afterArmor));
  }

  /* ================= Aimbot: toán học đón đầu (trợ ngắm) =================
     aimPoint: tìm thời gian bay t > 0 nhỏ nhất thỏa |target + vel*t − shooter| = projSpeed*t
     (phương trình bậc hai theo t; a = v·v − s², b = 2(r·v), c = r·r với r = target − shooter).
     Không có nghiệm (mục tiêu nhanh hơn đạn theo hướng bất lợi) -> xấp xỉ 1 vòng: t = |r + v*(|r|/s)| / s.
     t luôn được clamp vào [0, AIM_MAX_FLIGHT] và không bao giờ NaN/âm: projSpeed <= 0/NaN coi như 1. */
  var AIM_MAX_FLIGHT = 1.2; // giây — không đón đầu quá xa, tránh đạn "tiên tri" vô lý
  function aimPoint(shooter, target, vel, projSpeed) {
    var vx = (vel && isFinite(vel.x)) ? vel.x : 0, vz = (vel && isFinite(vel.z)) ? vel.z : 0;
    var rx = target.x - shooter.x, rz = target.z - shooter.z;
    var sp = (typeof projSpeed === 'number' && isFinite(projSpeed) && projSpeed > 0) ? projSpeed : 1;
    var a = vx * vx + vz * vz - sp * sp;
    var b = 2 * (rx * vx + rz * vz);
    var c = rx * rx + rz * rz;
    var t = NaN;
    if (Math.abs(a) < 1e-9) {
      if (Math.abs(b) > 1e-9) { var tl = -c / b; if (tl > 0) t = tl; }
    } else {
      var disc = b * b - 4 * a * c;
      if (disc >= 0) {
        var sq = Math.sqrt(disc), best = Infinity;
        var t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
        if (t1 > 0) best = Math.min(best, t1);
        if (t2 > 0) best = Math.min(best, t2);
        if (best < Infinity) t = best;
      }
    }
    if (!(t > 0) || !isFinite(t)) { // không nghiệm hoặc nghiệm rác -> xấp xỉ 1 vòng lặp
      var px = rx + vx * (Math.sqrt(c) / sp), pz = rz + vz * (Math.sqrt(c) / sp);
      t = Math.sqrt(px * px + pz * pz) / sp;
    }
    if (!(t > 0) || !isFinite(t)) t = 0;
    if (t > AIM_MAX_FLIGHT) t = AIM_MAX_FLIGHT;
    return { x: target.x + vx * t, z: target.z + vz * t, t: t };
  }
  // Vector đơn vị từ shooter tới point; trùng điểm -> {dx:0, dz:0} (nơi gọi tự giữ hướng cũ)
  function aimDir(shooter, point) {
    var dx = point.x - shooter.x, dz = point.z - shooter.z;
    var l = Math.sqrt(dx * dx + dz * dz);
    if (!(l > 1e-9)) return { dx: 0, dz: 0 };
    return { dx: dx / l, dz: dz / l };
  }

  /* ================= SkillSystem: đá hỗ trợ ================= */
  function gemCompatible(gemId, skillId) {
    var gem = D.GEMS[gemId], skill = D.SKILLS[skillId];
    if (!gem || !skill) return false;
    if (Array.isArray(gem.skills)) return gem.skills.indexOf(skillId) !== -1; // giới hạn theo từng kỹ năng (vd Quá Tải)
    if (gem.compatible === 'all') return true;
    return gem.compatible.indexOf(skill.kind) !== -1;
  }
  // Trả về thông số kỹ năng sau khi gắn đá. Đây là nơi hành vi chiến đấu thay đổi thật.
  function applyGems(skillId, gemIds) {
    var skill = D.SKILLS[skillId];
    var out = {
      skillId: skillId, projectiles: skill.kind === 'projectile' ? 1 : 0,
      pierce: 0, lifesteal: 0, damageMult: 1, energyCost: skill.energy,
      aoe: skill.aoe || 0, range: skill.range || 0, addFireFromInt: 0,
      cooldownMult: 1, energyOnHit: 0, reflectPct: 0, blastPct: 0, blastRadius: 0,
      allyDamagePct: 0, slowPct: 0, slowDuration: 0
    };
    (gemIds || []).forEach(function (gid) {
      if (!gemCompatible(gid, skillId)) return; // đá không tương thích bị bỏ qua rõ ràng
      var m = D.GEMS[gid].mods;
      if (m.extraProjectiles) { out.projectiles += m.extraProjectiles; }
      if (m.damageMult) out.damageMult *= Math.pow(m.damageMult, 1); // hệ số mỗi đạn khi phân tách (áp 1 lần)
      if (m.damageMultBonus) out.damageMult *= (1 + m.damageMultBonus);
      if (m.pierce) out.pierce += m.pierce;
      if (m.lifesteal) out.lifesteal += m.lifesteal;
      if (m.energyMult) out.energyCost = Math.round(out.energyCost * m.energyMult);
      if (m.aoeMult) out.aoe *= m.aoeMult;
      if (m.rangeMult) out.range *= m.rangeMult;
      if (m.addFireFromInt) out.addFireFromInt += m.addFireFromInt;
      if (m.energyOnHit) out.energyOnHit += m.energyOnHit;
      if (m.reflectPct) out.reflectPct = Math.max(out.reflectPct, m.reflectPct);
      if (m.blastPct) { out.blastPct += m.blastPct; out.blastRadius = Math.max(out.blastRadius, m.blastRadius || 2.5); }
      if (m.allyDamagePct) out.allyDamagePct += m.allyDamagePct;
      if (m.cooldownMult) out.cooldownMult *= m.cooldownMult;
      if (m.slowPct) { out.slowPct = Math.max(out.slowPct, m.slowPct); out.slowDuration = Math.max(out.slowDuration, m.slowDuration || 0); }
    });
    out.energyCost = Math.max(1, Math.round(out.energyCost));
    return out;
  }
  // Lắp đá: kiểm tra sở hữu, tương thích, giới hạn ô, không trùng. Trả {ok, reason}
  function socketGem(state, skillId, gemId) {
    if (!D.SKILLS[skillId]) return { ok: false, reason: 'bad-skill' };
    if (!D.GEMS[gemId]) return { ok: false, reason: 'bad-gem' };
    if (state.ownedGems.indexOf(gemId) === -1) return { ok: false, reason: 'not-owned' };
    if (!gemCompatible(gemId, skillId)) return { ok: false, reason: 'incompatible' };
    var cur = state.socketed[skillId] || (state.socketed[skillId] = []);
    if (cur.indexOf(gemId) !== -1) return { ok: false, reason: 'already-socketed' };
    if (cur.length >= D.MAX_GEMS_PER_SKILL) return { ok: false, reason: 'slot-full' };
    cur.push(gemId);
    return { ok: true };
  }
  function unsocketGem(state, skillId, gemId) { // tháo miễn phí, đá không bị mất
    var cur = state.socketed[skillId] || [];
    var i = cur.indexOf(gemId);
    if (i === -1) return false;
    cur.splice(i, 1);
    return true;
  }

  /* ================= BuildingSystem: kiểm tra đặt =================
     Hợp lệ khi: trong vùng làng (x <= 28, |z| <= 34, |x| <= 44), không chồng công trình khác
     (khoảng cách tâm >= (sizeA+sizeB)/2 + 1), không chồng Nhà chính, đủ tài nguyên, đã mở khóa. */
  var VILLAGE = { maxX: 28, minX: -44, maxZ: 34, minZ: -34 };
  function placementValid(typeId, x, z, placedBuildings, flags) {
    var def = D.BUILDINGS[typeId];
    if (!def) return { ok: false, reason: 'bad-type' };
    if (def.locked === 'boss' && !(flags && flags.bossKilled)) return { ok: false, reason: 'locked' };
    if (x > VILLAGE.maxX || x < VILLAGE.minX || z > VILLAGE.maxZ || z < VILLAGE.minZ) return { ok: false, reason: 'out-of-village' };
    var all = [{ type: 'townhall', x: 0, z: 0 }].concat(placedBuildings || []);
    for (var i = 0; i < all.length; i++) {
      var b = all[i], bd = D.BUILDINGS[b.type]; if (!bd) continue;
      var minDist = (def.size + bd.size) / 2 + 1;
      var dx = x - b.x, dz = z - b.z;
      if (Math.sqrt(dx * dx + dz * dz) < minDist) return { ok: false, reason: 'collision' };
    }
    return { ok: true };
  }

  /* ================= QuestSystem ================= */
  function questProgress(quest, stats, flags) {
    var g = quest.goal;
    if (g.type === 'stat') return Math.min(stats[g.key] || 0, g.count);
    if (g.type === 'flag') return flags[g.key] ? 1 : 0;
    return 0;
  }
  function questDone(quest, stats, flags) {
    var g = quest.goal;
    if (g.type === 'stat') return (stats[g.key] || 0) >= g.count;
    if (g.type === 'flag') return !!flags[g.key];
    return false;
  }
  function currentQuestIndex(state) {
    for (var i = 0; i < D.QUESTS.length; i++) {
      if (!state.completedQuests[D.QUESTS[i].id]) return i;
    }
    return D.QUESTS.length; // đã xong hết chuỗi
  }

  /* ================= SaveSystem ================= */
  function defaultState() {
    return {
      version: SAVE_VERSION,
      resources: createResources(),
      buildings: [],               // [{type,x,z,rot}]
      player: { level: 1, xp: 0, x: -6, z: 6 },
      inventory: [],               // [itemId,...] mỗi phần tử là 1 vật phẩm riêng (không nhân bản: equip di chuyển qua lại)
      equipped: {},                // slot -> itemId
      ownedGems: ['lifesteal', 'empower'],
      socketed: { slash: [], fireball: [], arrow: [] },
      completedQuests: {},
      stats: { woodHarvested: 0, foodGained: 0, buildingsPlaced: 0, monstersKilled: 0, buildingsUpgraded: 0 },
      flags: {},
      companions: 0,
      order: 'follow'
    };
  }
  function serialize(state) { return JSON.stringify(state); }
  function deserialize(json) {
    var s = JSON.parse(json);
    if (!s || s.version !== SAVE_VERSION) throw new Error('save-version-mismatch');
    var d = defaultState();
    // hợp nhất an toàn: chỉ nhận field đã biết
    d.resources = createResources(s.resources);
    d.buildings = Array.isArray(s.buildings) ? s.buildings.filter(function (b) { return D.BUILDINGS[b.type]; }).map(function (b) {
      var nb = { type: b.type, x: b.x, z: b.z, rot: b.rot || 0 };
      if (typeof b.level === 'number') nb.level = Math.max(1, Math.min(3, Math.floor(b.level))); // cấp công trình (save cũ thiếu -> mặc định 1 ở helpers)
      return nb;
    }) : [];
    if (s.player) { d.player.level = s.player.level || 1; d.player.xp = s.player.xp || 0; d.player.x = s.player.x; d.player.z = s.player.z; }
    d.inventory = Array.isArray(s.inventory) ? s.inventory.filter(function (id) { return D.ITEMS[id]; }) : [];
    d.equipped = {};
    if (s.equipped) for (var slot in s.equipped) { if (D.ITEMS[s.equipped[slot]] && D.SLOTS.indexOf(slot) !== -1) d.equipped[slot] = s.equipped[slot]; }
    d.ownedGems = Array.isArray(s.ownedGems) ? s.ownedGems.filter(function (g) { return D.GEMS[g]; }) : d.ownedGems;
    if (s.socketed) for (var sk in d.socketed) { if (Array.isArray(s.socketed[sk])) d.socketed[sk] = s.socketed[sk].filter(function (g) { return D.GEMS[g]; }); }
    d.completedQuests = s.completedQuests || {};
    if (s.stats) for (var st in d.stats) d.stats[st] = s.stats[st] || 0;
    d.flags = s.flags || {};
    d.companions = s.companions || 0;
    if (D.ORDERS.indexOf(s.order) !== -1) d.order = s.order;
    return d;
  }

  /* ================= Inventory / Equipment ================= */
  function equipItem(state, itemId) {
    var idx = state.inventory.indexOf(itemId);
    if (idx === -1) return { ok: false, reason: 'not-in-inventory' };
    var item = D.ITEMS[itemId]; if (!item) return { ok: false, reason: 'bad-item' };
    state.inventory.splice(idx, 1);
    var prev = state.equipped[item.slot];
    if (prev) state.inventory.push(prev); // đồ cũ quay về túi — không nhân bản, không mất
    state.equipped[item.slot] = itemId;
    return { ok: true, slot: item.slot, replaced: prev || null };
  }
  function unequipItem(state, slot) {
    var id = state.equipped[slot];
    if (!id) return { ok: false, reason: 'empty-slot' };
    delete state.equipped[slot];
    state.inventory.push(id);
    return { ok: true, item: id };
  }
  function equippedIds(state) { var out = []; for (var s in state.equipped) out.push(state.equipped[s]); return out; }
  // Kiểm tra bảo toàn vật phẩm: tổng số lần xuất hiện của mỗi itemId trong túi + trang bị
  function countItemEverywhere(state, itemId) {
    var n = state.inventory.filter(function (i) { return i === itemId; }).length;
    for (var s in state.equipped) if (state.equipped[s] === itemId) n++;
    return n;
  }

  /* ================= Nâng cấp công trình & sản xuất (Mục 5) ================= */
  function buildingLevel(b) { return (b && typeof b.level === 'number') ? Math.max(1, Math.min(3, Math.floor(b.level))) : 1; }
  function upgradeCostFor(typeId, curLevel) {
    var def = D.BUILDINGS[typeId];
    if (!def || !def.upgrades) return null;
    if (curLevel >= 3) return null; // đã tối đa
    return def.upgrades[curLevel + 1] || null;
  }
  // Nâng cấp nguyên tử: thiếu tài nguyên -> không trừ gì, không đổi level. Trả {ok, reason?, level?}
  function upgradeBuilding(state, idx) {
    var b = state.buildings[idx];
    if (!b) return { ok: false, reason: 'bad-index' };
    var lv = buildingLevel(b);
    var cost = upgradeCostFor(b.type, lv);
    if (!cost) return { ok: false, reason: 'max-level' };
    if (!spend(state.resources, cost)) return { ok: false, reason: 'not-enough' };
    b.level = lv + 1;
    state.stats.buildingsUpgraded = (state.stats.buildingsUpgraded || 0) + 1;
    return { ok: true, level: b.level, cost: cost };
  }
  function maxBuildingLevel(state, typeId) {
    var m = 0;
    (state.buildings || []).forEach(function (b) { if (b.type === typeId) m = Math.max(m, buildingLevel(b)); });
    return m;
  }
  // Kho cấp cao tăng sản lượng toàn cục: +5% mỗi cấp trên 1 của Kho tốt nhất (tối đa +10%).
  function productionGlobalMult(state) { return 1 + 0.05 * Math.max(0, maxBuildingLevel(state, 'warehouse') - 1); }
  // Sản lượng hiệu dụng của 1 công trình: amount x level x hệ số Kho toàn cục.
  // Trang trại còn nhân thêm (1 + windmillFarmBonus) — Cối xay gió tăng THÔNG LƯỢNG farm.
  function productionFor(building, state) {
    var def = D.BUILDINGS[building.type];
    if (!def || !def.produces) return null;
    var mult = state ? productionGlobalMult(state) : 1;
    if (state && building.type === 'farm') mult *= (1 + windmillFarmBonus(state));
    return { res: def.produces.res, amount: def.produces.amount * buildingLevel(building) * mult, interval: def.produces.interval };
  }
  // Doanh trại theo cấp: giảm giá chiêu mộ + tăng sát thương đồng đội.
  function recruitCostFor(state) {
    var lv = maxBuildingLevel(state, 'barracks');
    var c = { gold: D.COMPANION.cost.gold, food: D.COMPANION.cost.food };
    if (lv >= 2) c.gold = Math.round(c.gold * 0.8);
    if (lv >= 3) { c.gold = Math.round(D.COMPANION.cost.gold * 0.6); c.food = Math.round(c.food * 0.8); }
    return c;
  }
  function companionDamageMult(state) { return 1 + 0.15 * Math.max(0, maxBuildingLevel(state, 'barracks') - 1); }

  /* ================= Event làng (Mục 5): logic thuần ================= */
  function pickEvent(rngValue) { return rngValue < 0.4 ? 'merchant' : (rngValue < 0.7 ? 'harvest_festival' : 'wild_beasts'); }
  function festivalFood(farmCount) { return 5 + 6 * (farmCount || 0); }
  function applyEventReward(state, eventId) {
    if (eventId === 'harvest_festival') {
      var farms = (state.buildings || []).filter(function (b) { return b.type === 'farm'; }).length;
      var g1 = { food: festivalFood(farms) }; add(state.resources, g1); return g1;
    }
    if (eventId === 'wild_beasts') { var g2 = { gold: 20, wood: 10 }; add(state.resources, g2); return g2; }
    return null; // merchant đi qua applyMerchantOffer
  }
  function applyMerchantOffer(state, offerId) {
    var ev = null;
    D.VILLAGE_EVENTS.forEach(function (e) { if (e.id === 'merchant') ev = e; });
    if (!ev) return { ok: false, reason: 'no-event' };
    var offer = null;
    ev.offers.forEach(function (o) { if (o.id === offerId) offer = o; });
    if (!offer) return { ok: false, reason: 'bad-offer' };
    if (!spend(state.resources, offer.cost)) return { ok: false, reason: 'not-enough' };
    add(state.resources, offer.gain);
    return { ok: true, offer: offer };
  }

  /* ================= 6 công trình mới (đợt mở rộng): logic thuần =================
     Quy tắc chống cộng dồn vô hạn (ghi rõ): MỌI hiệu ứng theo cấp đều lấy công trình
     MẠNH NHẤT (cấp cao nhất) của loại đó — xây thêm bản sao không tăng thêm hiệu ứng. */
  // Chợ: đổi theo MARKET_TRADES. Vàng nhận được x (1 + 0.1 x (cấp chợ mạnh nhất - 1)).
  // Nguyên tử như spend(): không đủ -> từ chối, KHÔNG trừ gì.
  function marketTrade(state, tradeId) {
    var trade = null;
    (D.MARKET_TRADES || []).forEach(function (t) { if (t.id === tradeId) trade = t; });
    if (!trade) return { ok: false, reason: 'bad-trade' };
    if (!maxBuildingLevel(state, 'market')) return { ok: false, reason: 'no-market' };
    if (!spend(state.resources, trade.cost)) return { ok: false, reason: 'not-enough' };
    var gain = {};
    for (var k in trade.gain) {
      gain[k] = (k === 'gold') ? Math.round(trade.gain[k] * (1 + 0.1 * (maxBuildingLevel(state, 'market') - 1))) : trade.gain[k];
    }
    add(state.resources, gain);
    return { ok: true, trade: trade, gainApplied: gain };
  }
  // Cối xay gió: +sản lượng farm theo cấp cối mạnh nhất (0.30/0.40/0.50 — trần +50%).
  function windmillFarmBonus(state) {
    var lv = maxBuildingLevel(state, 'windmill');
    return lv ? (D.WINDMILL_FARM_BONUS[lv] || 0) : 0;
  }
  // Đền thờ: hệ số trọng số loot Hiếm/Huyền thoại theo cấp đền mạnh nhất.
  function shrineLootMult(state) {
    var lv = maxBuildingLevel(state, 'shrine');
    return lv ? (D.SHRINE_LOOT_MULT[lv] || 1) : 1;
  }
  // Trọng số quay loot hiện tại: item rare/legendary nặng gấp shrineLootMult lần.
  function lootWeights(state) {
    var m = shrineLootMult(state);
    return D.LOOT_TABLE.map(function (id) {
      var it = D.ITEMS[id];
      var rare = it && (it.rarity === 'rare' || it.rarity === 'legendary');
      return { id: id, w: rare ? m : 1 };
    });
  }
  // Quay 1 vật phẩm từ LOOT_TABLE theo trọng số đền. rng truyền vào để test tất định.
  function rollLoot(rng, state) {
    var ws = lootWeights(state), total = 0, i;
    for (i = 0; i < ws.length; i++) total += ws[i].w;
    var r = (rng ? rng() : Math.random()) * total;
    for (i = 0; i < ws.length; i++) { r -= ws[i].w; if (r < 0) return ws[i].id; }
    return ws[ws.length - 1].id;
  }
  // Nhà học: hệ số XP + điểm cộng XP duy nhất (game.killEnemy đi qua xpGainFor).
  function libraryXpMult(state) {
    var lv = maxBuildingLevel(state, 'library');
    return 1 + (lv ? (D.LIBRARY_XP_BONUS[lv] || 0) : 0);
  }
  function xpGainFor(state, baseXp) { return Math.max(1, Math.round(baseXp * libraryXpMult(state))); }
  // Quán ăn: quán GẦN NHẤT trong bán kính quyết định tốc độ hồi. Ngoài bán kính -> null.
  function tavernRegenAt(state, x, z) {
    var best = null;
    (state.buildings || []).forEach(function (b) {
      if (b.type !== 'tavern') return;
      var dx = x - b.x, dz = z - b.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d <= D.TAVERN_REGEN.radius && (!best || d < best.d)) best = { d: d, level: buildingLevel(b) };
    });
    if (!best) return null;
    return { hpPerSec: D.TAVERN_REGEN.hpPerSecPerLevel * best.level, enPerSec: D.TAVERN_REGEN.enPerSecPerLevel * best.level, level: best.level };
  }
  // Tháp canh: 0.20 nếu (x,z) nằm trong bán kính của BẤT KỲ tháp nào (không cộng dồn), ngược lại 0.
  function watchtowerSlowAt(state, x, z) {
    var hit = false;
    (state.buildings || []).forEach(function (b) {
      if (hit || b.type !== 'watchtower') return;
      var r = D.WATCHTOWER_SLOW.radiusByLevel[buildingLevel(b)] || 8;
      var dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz <= r * r) hit = true;
    });
    return hit ? D.WATCHTOWER_SLOW.pct : 0;
  }

  /* ================= Settings (đợt mở rộng): LƯU RIÊNG, không lẫn save game =================
     Key riêng 'projectVillageRPG.settings.v1'. Mất/hỏng settings -> mặc định, save game vô sự.
     sanitizeSettings: chỉ nhận giá trị hợp lệ, kẹp thanh trượt 0.5–2, enum chặt chẽ. */
  var SETTINGS_KEY = 'projectVillageRPG.settings.v1';
  var SETTINGS_DEFAULTS = {
    quality: 'high', shadows: true, envFx: true,
    shake: true, flash: true, hitStop: true, floatText: true, particles: true,
    camSensitivity: 1, camDistDefault: 40, aimbot: false,
    daySpeed: 1, showFps: false
  };
  function defaultSettings() { var o = {}; for (var k in SETTINGS_DEFAULTS) o[k] = SETTINGS_DEFAULTS[k]; return o; }
  function sanitizeSettings(inp) {
    var o = defaultSettings();
    if (!inp || typeof inp !== 'object') return o;
    if (['low', 'med', 'high'].indexOf(inp.quality) !== -1) o.quality = inp.quality;
    ['shadows', 'envFx', 'shake', 'flash', 'hitStop', 'floatText', 'particles', 'aimbot', 'showFps'].forEach(function (k) {
      if (typeof inp[k] === 'boolean') o[k] = inp[k];
    });
    if (typeof inp.camSensitivity === 'number' && isFinite(inp.camSensitivity)) o.camSensitivity = Math.max(0.5, Math.min(2, inp.camSensitivity));
    if ([18, 28, 40].indexOf(inp.camDistDefault) !== -1) o.camDistDefault = inp.camDistDefault;
    if ([0.5, 1, 2].indexOf(inp.daySpeed) !== -1) o.daySpeed = inp.daySpeed;
    return o;
  }
  function loadSettings(storage) {
    try {
      var raw = storage && storage.getItem(SETTINGS_KEY);
      if (raw) return sanitizeSettings(JSON.parse(raw));
    } catch (e) { /* settings hỏng -> mặc định, không đụng save */ }
    return defaultSettings();
  }
  function saveSettings(storage, s) {
    try { storage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(s))); return true; }
    catch (e) { return false; }
  }

  /* ================= Xuất / Nhập save (đợt mở rộng) =================
     importSave kiểm tra TRƯỚC khi ghi: JSON hợp lệ + version khớp + deserialize chạy qua.
     Sai bất kỳ bước nào -> {ok:false} và nơi gọi GIỮ NGUYÊN save cũ. */
  function exportSave(state) { return serialize(state); }
  function importSave(text) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { return { ok: false, reason: 'bad-json' }; }
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'bad-json' };
    if (parsed.version !== SAVE_VERSION) return { ok: false, reason: 'version' };
    try { return { ok: true, state: deserialize(text) }; }
    catch (e) { return { ok: false, reason: 'invalid' }; }
  }

  /* ================= Text công thức (Mục 3: tooltip định lượng) ================= */
  var STAT_NAMES = { str: 'STR', int: 'INT', agi: 'AGI' };
  function skillFormulaText(skillId, stats, gemIds) {
    var skill = D.SKILLS[skillId]; if (!skill) return '';
    var mod = applyGems(skillId, gemIds || []);
    var st = stats || BASE_STATS;
    var dmg = Math.round(calcDamage(st, skill, { armor: 0, resist: 0 }, function () { return 0.99; }).damage * mod.damageMult + (mod.addFireFromInt ? st.int * mod.addFireFromInt : 0));
    var cd = Math.round(skill.cooldown * mod.cooldownMult * 10) / 10;
    var txt = skill.name + ' — sát thương ~' + dmg + ' (gốc ' + skill.base + ' + ' + STAT_NAMES[skill.statScale] + ' ' + (st[skill.statScale] || 0) + '×1.2)';
    if (mod.projectiles > 1) txt += ' × ' + mod.projectiles + ' đạn';
    txt += ' · Tốn ' + mod.energyCost + ' EN · Hồi chiêu ' + cd + 's';
    if (skill.kind === 'melee') txt += ' · Tầm ' + (Math.round((mod.range || skill.range) * 10) / 10);
    if (mod.blastPct) txt += ' · Nổ ' + Math.round(mod.blastPct * 100) + '% quanh điểm nổ';
    return txt;
  }
  function gemEffectText(gemId) {
    var gem = D.GEMS[gemId]; if (!gem) return '';
    var m = gem.mods, parts = [];
    if (m.extraProjectiles) parts.push('+' + m.extraProjectiles + ' đạn (mỗi đạn ×' + m.damageMult + ')');
    if (m.damageMultBonus) parts.push('+' + Math.round(m.damageMultBonus * 100) + '% sát thương');
    if (m.pierce) parts.push('xuyên ' + m.pierce + ' địch');
    if (m.lifesteal) parts.push('hút máu ' + Math.round(m.lifesteal * 100) + '%');
    if (m.energyMult) parts.push('năng lượng ×' + m.energyMult);
    if (m.energyOnHit) parts.push('hồi ' + m.energyOnHit + ' EN/đòn trúng');
    if (m.reflectPct) parts.push('phản ' + Math.round(m.reflectPct * 100) + '% sát thương');
    if (m.blastPct) parts.push('nổ ' + Math.round(m.blastPct * 100) + '% (bán kính ' + (m.blastRadius || 2.5) + ')');
    if (m.allyDamagePct) parts.push('đồng đội +' + Math.round(m.allyDamagePct * 100) + '% sát thương');
    if (m.cooldownMult) parts.push('hồi chiêu ×' + m.cooldownMult);
    if (m.aoeMult) parts.push('phạm vi ×' + m.aoeMult);
    if (m.addFireFromInt) parts.push('thêm lửa = INT×' + m.addFireFromInt);
    if (m.slowPct) parts.push('làm chậm ' + Math.round(m.slowPct * 100) + '% trong ' + (m.slowDuration || 0) + 's');
    return gem.name + ': ' + (parts.length ? parts.join(' · ') : gem.desc);
  }

  /* ================= Animation rối khớp: toán POSE THUẦN =================
     poseHumanoid(inp) -> { parts: {torso|head|arm_l|arm_r|leg_l|leg_r|tail_a|tail_b: {x,y,z}}, bob }
     Góc xoay Euler (rad) TUYỆT ĐỐI cho từng node khớp của model GLB (js/gltf-lite.js),
     gồm cả tư thế gốc theo loài (vd người: tay T-pose phải hạ xuống bằng góc z gốc).
     Quy ước trục (nhân vật nhìn về +Z, pivot tại khớp):
       xoay X dương = phần dưới pivot ngả về SAU (-Z) với chi rủ xuống / đỉnh ngả về
       TRƯỚC (+Z) với phần thân trên pivot (torso/head).
       Phía 'r' = +X (phía kiếm vung của người chơi), 'l' = -X.
     inp: { state:'idle'|'walk', t: giây (đồng hồ cho thở/lướt), phase: pha bước (rad,
       tích lũy theo quãng đường — game.js cộng dồn, KHÔNG dùng đồng hồ tường),
       speed01: 0..1, attackT: giây kể từ lúc ra đòn (-1 = không), hitT: giây kể từ
       lúc trúng đòn (-1 = không), species:'humanoid'|'goblin'|'archer'|'fog' }.
     Mọi góc đều bị KẸP biên an toàn và ép hữu hạn — input rác (NaN) tự về mặc định. */
  var POSE_ATTACK_DUR = 0.35, POSE_HIT_DUR = 0.25;
  var POSE_LIM = { x: 2.4, y: 1.4, z: 2.8 };
  function pFin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function pClamp(v, m) { return Math.max(-m, Math.min(m, v)); }
  function pSmooth(u) { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); }
  function pEaseOut(u) { u = Math.max(0, Math.min(1, u)); return 1 - Math.pow(1 - u, 3); }
  function poseHumanoid(inp) {
    inp = inp || {};
    var species = ['humanoid', 'goblin', 'archer', 'fog'].indexOf(inp.species) !== -1 ? inp.species : 'humanoid';
    var fog = species === 'fog';
    var t = pFin(inp.t, 0), phase = pFin(inp.phase, 0);
    var speed01 = Math.max(0, Math.min(1, pFin(inp.speed01, 0)));
    var walking = inp.state === 'walk' && speed01 > 0.02;
    var attackT = pFin(inp.attackT, -1), hitT = pFin(inp.hitT, -1);
    var P = {};
    ['torso', 'head', 'arm_l', 'arm_r', 'leg_l', 'leg_r', 'tail_a', 'tail_b'].forEach(function (k) { P[k] = { x: 0, y: 0, z: 0 }; });
    var bob = 0;
    // Tư thế gốc theo loài: góc z hạ tay. Người bị nướng ở T-pose (tay ngang) nên phải
    // hạ ~70°; goblin/archer/boss tay đã rủ sẵn trong hình học nên chỉ chỉnh nhẹ.
    var hangZ = species === 'humanoid' ? 1.22 : (fog ? 0.12 : 0.18);
    P.arm_r.z = -hangZ; P.arm_l.z = hangZ;

    if (fog) {
      // LƯỚT: không chân — thân lắc theo đuôi 2 đốt uốn lệch pha, tay rủ đung đưa.
      var swayF = walking ? phase : t * 1.3;
      var amp = walking ? (0.6 + 0.4 * speed01) : 0.55;
      P.tail_a.z = 0.15 * amp * Math.sin(swayF);
      P.tail_a.x = 0.05 * Math.sin(t * 0.9);
      P.tail_b.z = 0.20 * amp * Math.sin(swayF - 1.05); // đốt 2 trễ pha — đuôi uốn sóng
      P.tail_b.x = 0.04 * Math.sin(t * 0.9 - 0.7);
      P.torso.z = 0.05 * Math.sin(swayF - 0.5);
      P.torso.x = walking ? 0.13 * speed01 : 0.03 * Math.sin(t * 1.3);
      P.arm_r.x = 0.10 * Math.sin(t * 1.3 + 1.0) + (walking ? 0.28 * speed01 : 0);
      P.arm_l.x = 0.10 * Math.sin(t * 1.3 + 1.6) + (walking ? 0.28 * speed01 : 0);
      P.head.x = -P.torso.x * 0.6;
      bob = 0.05 * Math.sin(t * 1.3) + (walking ? Math.abs(Math.sin(phase)) * 0.03 : 0);
    } else if (walking) {
      var legAmp = 0.58 * (0.35 + 0.65 * speed01);
      var armAmp = 0.42 * (0.30 + 0.70 * speed01);
      var sPh = Math.sin(phase);
      P.leg_r.x = sPh * legAmp;
      P.leg_l.x = -sPh * legAmp;                 // 2 chân lệch pha π tuyệt đối
      P.arm_r.x = -sPh * armAmp;                 // tay ngược pha với chân CÙNG phía
      P.arm_l.x = sPh * armAmp;
      P.torso.x = 0.06 + 0.10 * speed01;         // nghiêng trước theo tốc độ
      P.torso.z = 0.035 * Math.sin(phase);
      P.head.x = -P.torso.x * 0.7 + 0.03 * Math.sin(phase * 2);
      bob = Math.abs(Math.sin(phase)) * 0.035 * (0.4 + 0.6 * speed01); // nhún 2 nhịp / chu kỳ bước
    } else {
      // ĐỨNG YÊN: thở — thân nhún sin rất nhỏ, tay lắc micro, đầu giữ ổn định.
      var br = Math.sin(t * 1.6);
      P.torso.x = 0.02 + 0.018 * br;
      P.arm_r.x = 0.035 * Math.sin(t * 1.6 + 0.5);
      P.arm_l.x = 0.035 * Math.sin(t * 1.6 + 0.9);
      P.head.x = -0.012 * br;
      P.head.y = 0.03 * Math.sin(t * 0.23);
    }

    // ĐÒN ĐÁNH: cửa sổ POSE_ATTACK_DUR giây — đường cong nhanh vào (easeOut 45% đầu),
    // chậm ra (smoothstep trả về 0 ở cuối cửa sổ).
    if (attackT >= 0 && attackT < POSE_ATTACK_DUR) {
      var u = attackT / POSE_ATTACK_DUR;
      var A = u < 0.45 ? pEaseOut(u / 0.45) : 1 - pSmooth((u - 0.45) / 0.55);
      if (species === 'archer') {
        var draw = u < 0.6 ? u / 0.6 : (u < 0.85 ? 1 : 1 - (u - 0.85) / 0.15);
        P.arm_l.x += -0.62 * A;                  // tay cung giơ về trước, giữ chắc
        P.arm_r.x += 0.85 * draw;                // tay dây kéo về sau rồi THẢ ở 85%
        P.arm_r.z += -0.15 * draw;
        P.torso.y += -0.15 * A;
      } else if (fog) {
        P.arm_r.x += -1.15 * A; P.arm_l.x += -1.15 * A;   // cả 2 tay vung lên rộng
        P.arm_r.z += -0.50 * A; P.arm_l.z += 0.50 * A;
        P.torso.x += 0.22 * A;
        P.tail_a.z += 0.30 * Math.sin(u * Math.PI);
        P.tail_b.z += 0.35 * Math.sin(u * Math.PI);
      } else {
        var sw = species === 'goblin' ? 1.5 : 1.85;
        P.arm_r.x += -sw * A;                    // tay kiếm chém về trước
        P.arm_r.z += 0.55 * A;
        P.torso.y += 0.30 * A;                   // thân vặn theo đòn
        P.head.x += -0.08 * A;
      }
    }
    // TRÚNG ĐÒN: giật lùi + đầu lắc, decay mũ trong POSE_HIT_DUR giây.
    if (hitT >= 0 && hitT < POSE_HIT_DUR) {
      var D = Math.exp(-hitT * 9);
      P.torso.x += (fog ? -0.20 : -0.38) * D;
      P.head.x += 0.30 * D;
      P.arm_r.z += -0.30 * D; P.arm_l.z += 0.30 * D;
    }
    // Kẹp biên + ép hữu hạn cho MỌI đầu ra.
    for (var k in P) {
      P[k].x = pClamp(pFin(P[k].x, 0), POSE_LIM.x);
      P[k].y = pClamp(pFin(P[k].y, 0), POSE_LIM.y);
      P[k].z = pClamp(pFin(P[k].z, 0), POSE_LIM.z);
    }
    return { parts: P, bob: pFin(bob, 0) };
  }

  return {
    SAVE_VERSION: SAVE_VERSION, SAVE_KEY: SAVE_KEY, VILLAGE: VILLAGE, BASE_STATS: BASE_STATS,
    poseHumanoid: poseHumanoid, POSE_ATTACK_DUR: POSE_ATTACK_DUR, POSE_HIT_DUR: POSE_HIT_DUR,
    createResources: createResources, canAfford: canAfford, spend: spend, add: add, hasNegative: hasNegative,
    computeStats: computeStats, calcDamage: calcDamage, calcIncomingDamage: calcIncomingDamage,
    aimPoint: aimPoint, aimDir: aimDir, AIM_MAX_FLIGHT: AIM_MAX_FLIGHT,
    gemCompatible: gemCompatible, applyGems: applyGems, socketGem: socketGem, unsocketGem: unsocketGem,
    placementValid: placementValid,
    questProgress: questProgress, questDone: questDone, currentQuestIndex: currentQuestIndex,
    defaultState: defaultState, serialize: serialize, deserialize: deserialize,
    equipItem: equipItem, unequipItem: unequipItem, equippedIds: equippedIds, countItemEverywhere: countItemEverywhere,
    buildingLevel: buildingLevel, upgradeCostFor: upgradeCostFor, upgradeBuilding: upgradeBuilding,
    maxBuildingLevel: maxBuildingLevel, productionGlobalMult: productionGlobalMult, productionFor: productionFor,
    recruitCostFor: recruitCostFor, companionDamageMult: companionDamageMult,
    pickEvent: pickEvent, festivalFood: festivalFood, applyEventReward: applyEventReward, applyMerchantOffer: applyMerchantOffer,
    marketTrade: marketTrade, windmillFarmBonus: windmillFarmBonus,
    shrineLootMult: shrineLootMult, lootWeights: lootWeights, rollLoot: rollLoot,
    libraryXpMult: libraryXpMult, xpGainFor: xpGainFor,
    tavernRegenAt: tavernRegenAt, watchtowerSlowAt: watchtowerSlowAt,
    SETTINGS_KEY: SETTINGS_KEY, SETTINGS_DEFAULTS: SETTINGS_DEFAULTS,
    defaultSettings: defaultSettings, sanitizeSettings: sanitizeSettings,
    loadSettings: loadSettings, saveSettings: saveSettings,
    exportSave: exportSave, importSave: importSave,
    skillFormulaText: skillFormulaText, gemEffectText: gemEffectText
  };
});
