/* gltf-lite.js — Loader GLB tối giản của riêng Project Village RPG.
   Vì sao tự viết thay vì GLTFLoader chính thức: game dùng Three.js r152.2 bản NON-MODULE
   toàn cục từ cdnjs; GLTFLoader bản module sẽ ép đổi toàn bộ kiến trúc nạp script.
   23 model của dự án do chính dự án sinh ra (tools/build_models.py) nên định dạng đã biết
   trước và kiểm soát được: GLB 2.0, node phẳng có matrix, mỗi mesh 1 primitive indexed,
   thuộc tính POSITION (+TEXCOORD_0 không dùng), vật liệu PBR phẳng màu (baseColorFactor,
   emissiveFactor, roughness/metallic), KHÔNG texture / skin / animation.
   Loader này CHỈ hứa xử lý đúng định dạng đó — không phải loader glTF tổng quát.

   Hai tầng tách bạch:
   - parseGLB(buffer): THUẦN dữ liệu (không THREE, không DOM) → chạy được trong Node để test.
   - buildGroup(THREE, parsed): dựng THREE.Group (MeshStandardMaterial, flatShading vì file
     không chứa NORMAL — pháp tuyến mặt do shader tính, đúng chất low-poly phẳng).
   Nạp qua: window.GLTF_LITE (trình duyệt) hoặc module.exports (Node test). */
(function (global) {
  'use strict';

  /* ================= Tầng 1: parse thuần ================= */
  var COMP_INFO = {
    5120: { Arr: Int8Array, size: 1 }, 5121: { Arr: Uint8Array, size: 1 },
    5122: { Arr: Int16Array, size: 2 }, 5123: { Arr: Uint16Array, size: 2 },
    5125: { Arr: Uint32Array, size: 4 }, 5126: { Arr: Float32Array, size: 4 }
  };
  var TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

  function mat4Identity() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
  // Nhân 2 ma trận cột-chính (column-major) kiểu glTF: out = a * b
  function mat4Multiply(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      var s = 0;
      for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }
  function mat4FromTRS(t, q, s) { // translation [3], quaternion [x,y,z,w], scale [3]
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var x2 = x + x, y2 = y + y, z2 = z + z;
    var xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    var o = mat4Identity();
    o[0] = (1 - (yy + zz)) * s[0]; o[1] = (xy + wz) * s[0]; o[2] = (xz - wy) * s[0];
    o[4] = (xy - wz) * s[1]; o[5] = (1 - (xx + zz)) * s[1]; o[6] = (yz + wx) * s[1];
    o[8] = (xz + wy) * s[2]; o[9] = (yz - wx) * s[2]; o[10] = (1 - (xx + yy)) * s[2];
    o[12] = t[0]; o[13] = t[1]; o[14] = t[2];
    return o;
  }
  function nodeLocalMatrix(node) {
    if (node.matrix) return new Float32Array(node.matrix);
    if (node.translation || node.rotation || node.scale) {
      return mat4FromTRS(node.translation || [0, 0, 0], node.rotation || [0, 0, 0, 1], node.scale || [1, 1, 1]);
    }
    return mat4Identity();
  }
  function transformPoint(m, x, y, z) {
    return [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14]
    ];
  }

  // Đọc 1 accessor thành TypedArray (tôn trọng byteOffset + byteStride xen kẽ nếu có).
  function readAccessor(json, bin, accIdx) {
    var acc = json.accessors[accIdx];
    var info = COMP_INFO[acc.componentType];
    if (!info) throw new Error('gltf-lite: componentType lạ ' + acc.componentType);
    var nComp = TYPE_COUNT[acc.type];
    var bv = json.bufferViews[acc.bufferView];
    var start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    var stride = bv.byteStride || info.size * nComp;
    var out = new info.Arr(acc.count * nComp);
    if (stride === info.size * nComp) {
      var src = new info.Arr(bin.buffer, bin.byteOffset + start, acc.count * nComp);
      out.set(src);
    } else {
      var dv = new DataView(bin.buffer, bin.byteOffset);
      var read = acc.componentType === 5126 ? 'getFloat32' : acc.componentType === 5125 ? 'getUint32' : acc.componentType === 5123 ? 'getUint16' : acc.componentType === 5121 ? 'getUint8' : acc.componentType === 5122 ? 'getInt16' : 'getInt8';
      for (var i = 0; i < acc.count; i++) for (var k = 0; k < nComp; k++) {
        out[i * nComp + k] = dv[read](start + i * stride + k * info.size, true);
      }
    }
    return out;
  }

  /* parseGLB(buffer) — buffer: ArrayBuffer | Uint8Array | Buffer (Node).
     Trả: { materials: [{name, color:[r,g,b,a], emissive:[r,g,b]|null, roughness, metallic, doubleSided}],
            parts: [{name, matrix:Float32Array(16) world, positions:Float32Array, indices:Uint32Array, material:int}],
            stats: {meshes, materials, faces, bboxMin:[3], bboxMax:[3]} }  (bbox theo tọa độ THẾ GIỚI sau matrix) */
  function parseGLB(buffer) {
    var u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('gltf-lite: không phải file GLB (sai magic)');
    if (dv.getUint32(4, true) !== 2) throw new Error('gltf-lite: chỉ hỗ trợ GLB phiên bản 2');
    var off = 12, json = null, bin = null;
    while (off < u8.byteLength) {
      var len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      var chunk = u8.subarray(off + 8, off + 8 + len);
      if (type === 0x4E4F534A) { // 'JSON'
        var txt = '';
        if (typeof TextDecoder !== 'undefined') txt = new TextDecoder('utf-8').decode(chunk);
        else txt = Buffer.from(chunk).toString('utf8'); // Node cũ
        json = JSON.parse(txt);
      } else if (type === 0x004E4942) { bin = chunk; } // 'BIN\0'
      off += 8 + len;
    }
    if (!json) throw new Error('gltf-lite: thiếu chunk JSON');
    if (!bin) throw new Error('gltf-lite: thiếu chunk BIN');

    var materials = (json.materials || []).map(function (m) {
      var pbr = m.pbrMetallicRoughness || {};
      return {
        name: m.name || '',
        color: pbr.baseColorFactor ? pbr.baseColorFactor.slice() : [1, 1, 1, 1],
        emissive: m.emissiveFactor ? m.emissiveFactor.slice() : null,
        roughness: pbr.roughnessFactor != null ? pbr.roughnessFactor : 1,
        metallic: pbr.metallicFactor != null ? pbr.metallicFactor : 0,
        doubleSided: !!m.doubleSided
      };
    });

    var parts = [];
    var bMin = [Infinity, Infinity, Infinity], bMax = [-Infinity, -Infinity, -Infinity];
    var faces = 0;
    function walkNode(nodeIdx, parentMat) {
      var node = json.nodes[nodeIdx];
      var world = mat4Multiply(parentMat, nodeLocalMatrix(node));
      if (node.mesh != null) {
        var mesh = json.meshes[node.mesh];
        mesh.primitives.forEach(function (prim) {
          if (prim.attributes.POSITION == null) return;
          var pos = readAccessor(json, bin, prim.attributes.POSITION);
          var idx = prim.indices != null ? readAccessor(json, bin, prim.indices) : null;
          if (!idx) { idx = new Uint32Array(pos.length / 3); for (var i = 0; i < idx.length; i++) idx[i] = i; }
          else if (!(idx instanceof Uint32Array)) idx = Uint32Array.from(idx);
          parts.push({ name: node.name || mesh.name || '', matrix: world, positions: pos, indices: idx, material: prim.material != null ? prim.material : -1 });
          faces += idx.length / 3;
          for (var v = 0; v < pos.length; v += 3) {
            var p = transformPoint(world, pos[v], pos[v + 1], pos[v + 2]);
            for (var k = 0; k < 3; k++) { if (p[k] < bMin[k]) bMin[k] = p[k]; if (p[k] > bMax[k]) bMax[k] = p[k]; }
          }
        });
      }
      (node.children || []).forEach(function (c) { walkNode(c, world); });
    }
    var scene = json.scenes[json.scene || 0];
    scene.nodes.forEach(function (n) { walkNode(n, mat4Identity()); });

    return {
      materials: materials,
      parts: parts,
      stats: { meshes: parts.length, materials: materials.length, faces: faces, bboxMin: bMin, bboxMax: bMax }
    };
  }

  /* ================= Tầng 2: dựng THREE.Group (chỉ chạy trên trình duyệt) ================= */
  function buildGroup(THREE, parsed) {
    var mats = parsed.materials.map(function (m) {
      var mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(m.color[0], m.color[1], m.color[2]),
        roughness: m.roughness, metalness: m.metallic,
        flatShading: true, // file không có NORMAL — pháp tuyến mặt phẳng do shader suy ra, đúng chất low-poly
        side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide
      });
      if (m.emissive) { mat.emissive = new THREE.Color(m.emissive[0], m.emissive[1], m.emissive[2]); mat.emissiveIntensity = 1; }
      if (m.color[3] < 0.999) { mat.transparent = true; mat.opacity = m.color[3]; }
      return mat;
    });
    var fallbackMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.9, flatShading: true });
    var group = new THREE.Group();
    var m4 = new THREE.Matrix4();
    parsed.parts.forEach(function (part) {
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(part.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(part.indices, 1));
      geo.computeVertexNormals(); // dự phòng cho pipeline cần normal; flatShading vẫn thắng trong shader
      var mesh = new THREE.Mesh(geo, part.material >= 0 ? mats[part.material] : fallbackMat);
      mesh.name = part.name;
      m4.fromArray(part.matrix);
      mesh.applyMatrix4(m4);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    });
    return group;
  }

  var api = { parseGLB: parseGLB, buildGroup: buildGroup };
  global.GLTF_LITE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
