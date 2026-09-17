/* =============================================================================
   ABYSS: Marine Explorer — js/entities.js
   All 6 fauna + 4 pollution. Exposes window.EntityManager.

   ZERO SHADER RECOMPILATION RULE:
   - emissiveIntensity is set ONCE at material creation and never mutated.
   - Scan highlight: emissive.setHex(0x00ffff), restored via origHex.
   - Static predefined pollution materials prevent dynamic shader rebuilds.
   - Origin coordinates stored in userData.origin for zero-allocation resets.
   ============================================================================= */

(function () {
  'use strict';

  /* ─── Module state ─────────────────────────────────────────────────────────── */
  var _scene         = null;
  var _interactables = [];
  var _fauna         = [];        // all animated groups incl. shark
  var _pollution     = [];        // mesh references for pollution artifacts
  var _sharkAngle    = 0;

  /* ─── Static predefined pollution materials (Zero Shader Recompilation) ──── */
  var POLLUTION_BAG_MAT_1 = null;
  var POLLUTION_BAG_MAT_2 = null;
  var POLLUTION_BARREL_MAT_1 = null;
  var POLLUTION_BARREL_MAT_2 = null;

  function _initPollutionMaterials() {
    if (!POLLUTION_BAG_MAT_1) {
      POLLUTION_BAG_MAT_1 = new THREE.MeshPhongMaterial({
        color: 0xdde8ff,
        transparent: true,
        opacity: 0.52,
        shininess: 90,
        side: THREE.DoubleSide
      });
      POLLUTION_BAG_MAT_2 = new THREE.MeshPhongMaterial({
        color: 0xfff8f0,
        transparent: true,
        opacity: 0.48,
        shininess: 80,
        side: THREE.DoubleSide
      });
      POLLUTION_BARREL_MAT_1 = new THREE.MeshPhongMaterial({
        color: 0xbb3300,
        shininess: 18,
        emissive: 0x220800,
        emissiveIntensity: 0.5
      });
      POLLUTION_BARREL_MAT_2 = new THREE.MeshPhongMaterial({
        color: 0x7a4422,
        shininess: 12,
        emissive: 0x100500,
        emissiveIntensity: 0.5
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     CLOWNFISH CANVAS TEXTURE
     Orange body + two white stripe bands. needsUpdate = true is critical.
     ───────────────────────────────────────────────────────────────────────── */
  function _makeClownTex() {
    var cv  = document.createElement('canvas');
    cv.width = 128; cv.height = 256;
    var c   = cv.getContext('2d');

    c.fillStyle = '#ff6000';
    c.fillRect(0, 0, 128, 256);

    // Stripe 1 at 38% height
    c.fillStyle = '#ffffff';
    c.fillRect(0, Math.floor(256 * 0.36), 128, Math.floor(256 * 0.10));

    // Stripe 2 at 62% height
    c.fillStyle = '#ffffff';
    c.fillRect(0, Math.floor(256 * 0.60), 128, Math.floor(256 * 0.08));

    // Thin black borders
    ['#111'].forEach(function (col) { c.fillStyle = col; });
    c.fillStyle = '#000';
    [0.35, 0.46, 0.59, 0.68].forEach(function (frac) {
      c.fillRect(0, Math.floor(256 * frac), 128, 3);
    });

    var tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;   // CRITICAL — prevents black render
    return tex;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     registerFauna — tag meshes for gaze raycasting
     ───────────────────────────────────────────────────────────────────────── */
  function _registerFauna(group, id) {
    group.userData.type    = 'fauna';
    group.userData.id      = id;
    group.userData.scanned = false;

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.faunaGroup = group;
        c.userData.faunaId    = id;
      }
    });

    _interactables.push(group);
    _fauna.push(group);
    _scene.add(group);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SEA TURTLE
     ───────────────────────────────────────────────────────────────────────── */
  function _buildTurtle(x, y, z) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    // Shell — emissiveIntensity fixed at 0.25, never mutated
    var shellMat = new THREE.MeshPhongMaterial({
      color: 0x2d5c20, emissive: 0x0a200a,
      emissiveIntensity: 0.25, shininess: 40
    });
    var body = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), shellMat);
    body.scale.set(1.2, 0.4, 0.8);
    g.add(body);

    var patMat = new THREE.MeshPhongMaterial({
      color: 0x1a3a10, emissive: 0x051005,
      emissiveIntensity: 0.1, shininess: 20
    });
    var pat = new THREE.Mesh(new THREE.SphereGeometry(1.02, 6, 4), patMat);
    pat.scale.set(1.2, 0.38, 0.8);
    g.add(pat);

    var headMat = new THREE.MeshPhongMaterial({ color: 0x3d6a2a, shininess: 30 });
    var head    = new THREE.Mesh(new THREE.SphereGeometry(0.28, 6, 4), headMat);
    head.position.set(0, 0.05, 0.88);
    g.add(head);

    var eyeMat = new THREE.MeshPhongMaterial({ color: 0x111111 });
    [-0.1, 0.1].forEach(function (ex) {
      var eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 4, 4), eyeMat);
      eye.position.set(ex, 0.08, 0.3);
      head.add(eye);
    });

    var flipMat = new THREE.MeshPhongMaterial({
      color: 0x2d5c20, emissive: 0x091508,
      emissiveIntensity: 0.15
    });
    var flipDefs = [
      { pos: [ 1.15, 0,  0.15], sz: [0.75, 0.08, 0.32] },
      { pos: [-1.15, 0,  0.15], sz: [0.75, 0.08, 0.32] },
      { pos: [ 0.85, 0, -0.50], sz: [0.52, 0.07, 0.24] },
      { pos: [-0.85, 0, -0.50], sz: [0.52, 0.07, 0.24] }
    ];
    var flippers = [];
    flipDefs.forEach(function (fd) {
      var f = new THREE.Mesh(new THREE.BoxGeometry(fd.sz[0], fd.sz[1], fd.sz[2]), flipMat);
      f.position.set(fd.pos[0], fd.pos[1], fd.pos[2]);
      g.add(f);
      flippers.push(f);
    });

    g.userData.flippers  = flippers;
    g.userData.startPos  = new THREE.Vector3(x, y, z);
    _registerFauna(g, 'turtle');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     JELLYFISH
     ───────────────────────────────────────────────────────────────────────── */
  function _buildJellyfish(x, y, z) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    var bellMat = new THREE.MeshPhongMaterial({
      color: 0xaaddff, emissive: 0x224466,
      emissiveIntensity: 0.5,
      transparent: true, opacity: 0.72, shininess: 120
    });
    var bell = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
      bellMat
    );
    g.add(bell);

    var tendMat = new THREE.MeshPhongMaterial({
      color: 0xaaddff, transparent: true, opacity: 0.38,
      emissive: 0x113355, emissiveIntensity: 0.3
    });
    for (var i = 0; i < 6; i++) {
      var angle = (i / 6) * Math.PI * 2;
      var len   = 1.3 + Math.random() * 0.7;
      var t     = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.007, len, 4), tendMat);
      t.position.set(Math.cos(angle) * 0.44, -0.9 - len * 0.5, Math.sin(angle) * 0.44);
      g.add(t);
    }

    g.userData.bell   = bell;
    g.userData.baseY  = y;
    _registerFauna(g, 'jellyfish');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     CLOWNFISH SCHOOL (3 fish orbiting a shared centre)
     ───────────────────────────────────────────────────────────────────────── */
  function _buildClownfish(x, y, z) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    var clownTex = _makeClownTex();
    var bodyMat  = new THREE.MeshPhongMaterial({ map: clownTex, shininess: 60 });
    var tailMat  = new THREE.MeshPhongMaterial({
      color: 0xff8800, emissive: 0x441100,
      emissiveIntensity: 0.5
    });

    for (var f = 0; f < 3; f++) {
      var sub  = new THREE.Group();
      var body = new THREE.Mesh(new THREE.SphereGeometry(0.3, 6, 4), bodyMat);
      var tail = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.28, 4), tailMat);
      tail.rotation.z = Math.PI / 2;
      tail.position.set(-0.35, 0, 0);
      body.add(tail);
      sub.add(body);
      sub.userData.phase = f * (Math.PI * 2 / 3);
      g.add(sub);
    }

    _registerFauna(g, 'clownfish');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     MANTA RAY — dark top, white belly
     ───────────────────────────────────────────────────────────────────────── */
  function _buildMantaRay(x, y, z) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    var topMat = new THREE.MeshPhongMaterial({
      color: 0x151528, emissive: 0x040410,
      emissiveIntensity: 0.5, shininess: 20
    });
    var bellyMat = new THREE.MeshPhongMaterial({
      color: 0xffffff, emissive: 0x112233,
      emissiveIntensity: 0.5, shininess: 8
    });

    g.add(new THREE.Mesh(new THREE.BoxGeometry(3, 0.15, 1.5), topMat));

    var belly = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.07, 1.3), bellyMat);
    belly.position.y = -0.04;
    g.add(belly);

    var wings = [];
    [[-2.1, 0.02, 0], [2.1, 0.02, 0]].forEach(function (wp, wi) {
      var wTop = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.06, 1.1), topMat);
      wTop.position.set(wp[0], wp[1], wp[2]);
      wTop.rotation.z = (wi === 0 ? 0.2 : -0.2);

      var wBelly = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.04, 1.1), bellyMat);
      wBelly.position.set(wp[0], wp[1] - 0.04, wp[2]);
      wBelly.rotation.z = (wi === 0 ? 0.2 : -0.2);

      g.add(wTop);
      g.add(wBelly);
      wings.push(wTop);
    });

    var tail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.02, 2.2, 4), topMat);
    tail.rotation.z = Math.PI / 2;
    tail.position.set(0, 0, -1.3);
    g.add(tail);

    [-0.35, 0.35].forEach(function (cx) {
      var cf = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.08, 0.4), topMat);
      cf.position.set(cx, 0, 0.85);
      g.add(cf);
    });

    g.userData.wings    = wings;
    g.userData.startPos = new THREE.Vector3(x, y, z);
    _registerFauna(g, 'mantaray');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BIOLUMINESCENT EEL — 8-segment articulated spine
     Emissive colour chase driven at runtime (only .setHex, no intensity change)
     ───────────────────────────────────────────────────────────────────────── */
  function _buildEel(x, y, z) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    var segments = [];
    for (var i = 0; i < 8; i++) {
      var t     = i / 7;
      var rad   = 0.22 - i * 0.014;
      var segMat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(0, 0.7 + t * 0.3, 0.75 + t * 0.25),
        emissive: new THREE.Color(0, 0.55, 0.8),
        emissiveIntensity: 0.5,
        transparent: true, opacity: 0.88, shininess: 100
      });
      var seg = new THREE.Mesh(new THREE.SphereGeometry(rad, 6, 4), segMat);
      seg.position.set(0, i * 0.33, 0);
      seg.userData.segIdx = i;
      g.add(seg);
      segments.push(seg);
    }

    var finMat = new THREE.MeshPhongMaterial({
      color: 0x00ffcc, emissive: 0x00aa88,
      emissiveIntensity: 0.5,
      transparent: true, opacity: 0.7
    });
    var fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.5, 0.08), finMat);
    fin.position.set(0.2, 1.2, 0);
    g.add(fin);

    g.userData.segments = segments;
    g.userData.startPos = new THREE.Vector3(x, y, z);
    _registerFauna(g, 'eel');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SHARK — outer perimeter circular patrol, ~44 unit radius
     NOT in interactables (cannot be scanned)
     ───────────────────────────────────────────────────────────────────────── */
  function _buildShark() {
    var g   = new THREE.Group();
    var mat = new THREE.MeshPhongMaterial({
      color: 0x5577aa, specular: 0x8899bb, shininess: 60
    });

    var body = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), mat);
    body.scale.set(3.2, 0.68, 0.82);
    g.add(body);

    var df = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.95, 0.55), mat);
    df.position.set(0.4, 0.75, 0);
    g.add(df);

    var cf = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.8, 0.55), mat);
    cf.position.set(-2.9, 0.1, 0);
    cf.rotation.z = 0.4;
    g.add(cf);

    [0.7, -0.7].forEach(function (pz) {
      var pf = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.07, 0.5), mat);
      pf.position.set(0.5, -0.25, pz);
      g.add(pf);
    });

    var bellyMat = new THREE.MeshPhongMaterial({ color: 0x8aabb8, shininess: 40 });
    var belly    = new THREE.Mesh(new THREE.SphereGeometry(0.95, 8, 4), bellyMat);
    belly.scale.set(2.8, 0.4, 0.65);
    belly.position.y = -0.22;
    g.add(belly);

    g.userData.isShark = true;
    g.position.set(44, 5, 0);
    _scene.add(g);
    _fauna.push(g);
    return g;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     POLLUTION — 4 artifacts (2 plastic bags, 2 chemical barrels)
     - Static predefined materials ensure zero dynamic GLSL shader compilation.
     - m.userData.origin stores spawn coordinates for zero-allocation resets.
     ───────────────────────────────────────────────────────────────────────── */
  function buildPollution(scene) {
    var targetScene = scene || _scene;
    _initPollutionMaterials();

    var defs = [
      { geo: new THREE.PlaneGeometry(0.8, 1.0, 2, 2),       mat: POLLUTION_BAG_MAT_1,    pos: [-5, -6.5, -16], rot: [0.3, 0.5, 0.1]  },
      { geo: new THREE.PlaneGeometry(0.8, 1.0, 2, 2),       mat: POLLUTION_BAG_MAT_2,    pos: [ 9, -6.2, -21], rot: [0.1, 1.2, 0.2]  },
      { geo: new THREE.CylinderGeometry(0.4, 0.4, 1.0, 8),  mat: POLLUTION_BARREL_MAT_1, pos: [ 5, -7.2, -23], rot: [0.1, 0.2, 0.05] },
      { geo: new THREE.CylinderGeometry(0.4, 0.4, 1.0, 8),  mat: POLLUTION_BARREL_MAT_2, pos: [-13,-7.2, -29], rot: [0.0, 0.8, 0.08] }
    ];

    defs.forEach(function (d, i) {
      var m = new THREE.Mesh(d.geo, d.mat);
      m.position.set(d.pos[0], d.pos[1], d.pos[2]);
      m.rotation.set(d.rot[0], d.rot[1], d.rot[2]);
      m.userData.type      = 'pollution';
      m.userData.id        = 'pollution_' + i;
      m.userData.collected = false;
      m.userData.baseY     = d.pos[1];
      m.userData.origin    = m.position.clone();

      _pollution.push(m);
      _interactables.push(m);
      if (targetScene) targetScene.add(m);
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     buildAll — spawn everything into scene
     ───────────────────────────────────────────────────────────────────────── */
  function buildAll(scene) {
    _scene         = scene;
    _interactables = [];
    _fauna         = [];
    _pollution     = [];
    _sharkAngle    = 0;

    _buildTurtle(3,   -2,  -18);
    _buildJellyfish(-6,  1,  -14);
    _buildClownfish(8,  -1,  -20);
    _buildMantaRay(-4,   3,  -30);
    _buildEel(10,  -3,  -25);
    _buildShark();
    buildPollution(scene);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     update — all swim / float / undulate animations each frame
     ───────────────────────────────────────────────────────────────────────── */
  function update(t, delta) {
    _fauna.forEach(function (g) {
      if (!g.visible) return;

      var id = g.userData.id;
      var sp = g.userData.startPos;

      /* ── Turtle ── */
      if (id === 'turtle') {
        g.position.x = sp.x + Math.sin(t * 0.38) * 9;
        g.position.z = sp.z + Math.cos(t * 0.28) * 6;
        g.position.y = sp.y + Math.sin(t * 0.65) * 0.6;
        var dx = Math.cos(t * 0.38) * 9 * 0.38;
        var dz = -Math.sin(t * 0.28) * 6 * 0.28;
        g.rotation.y = Math.atan2(dx, -dz);
        if (g.userData.flippers) {
          g.userData.flippers.forEach(function (f, i) {
            f.rotation.z = Math.sin(t * 2.2 + i * Math.PI * 0.5) * 0.38 * (i < 2 ? 1 : -0.55);
          });
        }
      }

      /* ── Jellyfish ── */
      if (id === 'jellyfish') {
        var bell = g.userData.bell;
        if (bell) bell.scale.y = 1 + Math.sin(t * 2.8) * 0.14;
        g.position.y = g.userData.baseY + Math.sin(t * 1.4) * 1.4;
        g.children.forEach(function (c, ci) {
          if (ci > 0) c.rotation.z = Math.sin(t * 2.2 + ci * 0.9) * 0.22;
        });
      }

      /* ── Clownfish ── */
      if (id === 'clownfish') {
        g.children.forEach(function (sub, fi) {
          var ph = sub.userData.phase !== undefined ? sub.userData.phase : fi * (Math.PI * 2 / 3);
          var tt = t * 0.75 + ph;
          sub.position.x = Math.sin(tt) * 2.6 + Math.sin(tt * 2.1) * 0.9;
          sub.position.y = Math.cos(tt * 1.25) * 1.1;
          sub.position.z = Math.cos(tt) * 2.2;
          sub.rotation.y = -tt + Math.PI;
        });
      }

      /* ── Manta Ray ── */
      if (id === 'mantaray') {
        var wings = g.userData.wings;
        if (wings) {
          wings.forEach(function (w, wi) {
            w.rotation.z = (wi === 0 ? 1 : -1) * Math.sin(t * 1.4) * 0.3;
          });
        }
        g.position.x = sp.x + Math.sin(t * 0.22) * 14;
        g.position.z = sp.z + Math.cos(t * 0.18) * 12;
        g.position.y = sp.y + Math.sin(t * 0.45) * 1.8;
        var mdx = Math.cos(t * 0.22) * 14 * 0.22;
        var mdz = -Math.sin(t * 0.18) * 12 * 0.18;
        g.rotation.y = Math.atan2(mdx, -mdz) + Math.PI * 0.5;
      }

      /* ── Bioluminescent Eel — emissive colour chase via setHex (no intensity change) ── */
      if (id === 'eel') {
        var segs = g.userData.segments;
        if (segs) {
          segs.forEach(function (seg, si) {
            seg.position.x = Math.sin(t * 2.0 + si * 0.85) * 0.45;
            seg.position.z = Math.cos(t * 1.5 + si * 0.6) * 0.15;

            var wave = (Math.sin(t * 3.0 + si * 0.9) + 1) * 0.5;
            var g_ch = Math.round(0x88 + wave * (0xff - 0x88));
            var b_ch = Math.round(0xff - wave * (0xff - 0x88));
            var hexCol = (g_ch << 8) | b_ch;
            seg.material.emissive.setHex(hexCol);
          });
        }
        g.position.y = sp.y + Math.sin(t * 0.55) * 1.8;
        g.position.x = sp.x + Math.sin(t * 0.35) * 5;
      }

      /* ── Shark — outer perimeter patrol at R ~44 ── */
      if (g.userData.isShark) {
        _sharkAngle += delta * 0.065;
        g.position.x  = Math.cos(_sharkAngle) * 44;
        g.position.z  = -20 + Math.sin(_sharkAngle) * 44;
        g.position.y  = 5 + Math.sin(t * 0.28) * 1.8;
        g.rotation.y  = -_sharkAngle + Math.PI * 0.5;
      }
    });

    /* Pollution bob (only if not collected) */
    _pollution.forEach(function (obj) {
      if (!obj.userData.collected) {
        obj.rotation.y += delta * 0.36;
        obj.position.y = obj.userData.baseY + Math.sin(t * 1.15 + obj.position.x * 0.4) * 0.16;
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     reset — called between sessions
     - Reset userData.scanned = false across all fauna.
     - For each item in pollutionList:
       1. Set userData.collected = false.
       2. Reset visible = true.
       3. Restore origin coordinates: p.position.copy(p.userData.origin).
       4. Re-insert p into interactables if not already present.
     ───────────────────────────────────────────────────────────────────────── */
  function reset() {
    // Reset userData.scanned = false across all fauna
    _fauna.forEach(function (f) {
      if (f && f.userData) {
        f.userData.scanned = false;
      }
    });

    // Reset pollution state in-place with zero reallocation
    var pollutionList = _pollution;
    pollutionList.forEach(function (p) {
      p.userData.collected = false;
      p.visible = true;
      if (p.userData.origin) {
        p.position.copy(p.userData.origin);
      }
      if (_interactables.indexOf(p) === -1) {
        _interactables.push(p);
      }
    });

    _sharkAngle = 0;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
     ───────────────────────────────────────────────────────────────────────── */
  window.EntityManager = {
    buildAll:         buildAll,
    buildPollution:   buildPollution,
    update:           update,
    reset:            reset,
    getInteractables: function () { return _interactables; },
    getPollution:     function () { return _pollution; }
  };

}());
