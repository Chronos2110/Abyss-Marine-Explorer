// =============================================================================
// ABYSS: Marine Explorer — entities.js
// All 6 fauna constructors + 4 pollution animation. Exposed on window.ABYSS.Entities.
// =============================================================================

window.ABYSS = window.ABYSS || {};

window.ABYSS.Entities = (function () {
  'use strict';

  var _scene = null;
  var _faunaGroups = [];
  var _shark = null;

  // Shared interactables list — appended to by registerFauna
  var _interactables = null;

  // =============================================================================
  // CLOWNFISH CANVAS TEXTURE
  // Orange body with two white stripe bands at 40% and 65% height
  // IMPORTANT: texture.needsUpdate = true must be set after draw
  // =============================================================================

  function makeClownfishTexture() {
    var c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    var ctx = c.getContext('2d');

    // Orange base
    ctx.fillStyle = '#ff6600';
    ctx.fillRect(0, 0, 128, 256);

    // White stripe 1 — at 40% height
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, Math.floor(256 * 0.38), 128, Math.floor(256 * 0.09));

    // White stripe 2 — at 65% height
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, Math.floor(256 * 0.62), 128, Math.floor(256 * 0.07));

    // Thin black borders on stripes
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, Math.floor(256 * 0.37), 128, 3);
    ctx.fillRect(0, Math.floor(256 * 0.47), 128, 3);
    ctx.fillRect(0, Math.floor(256 * 0.61), 128, 3);
    ctx.fillRect(0, Math.floor(256 * 0.69), 128, 3);

    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true; // critical — prevents black texture
    return tex;
  }

  // =============================================================================
  // HELPER — registerFauna
  // =============================================================================

  function registerFauna(group, id, type) {
    group.userData.type = type;
    group.userData.id = id;
    group.userData.scanned = false;
    _faunaGroups.push(group);

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.faunaId = id;
        c.userData.faunaGroup = group;
      }
    });

    if (_interactables) _interactables.push(group);
    _scene.add(group);
  }

  // =============================================================================
  // SEA TURTLE
  // =============================================================================

  function buildSeaTurtle(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);

    var shellMat = new THREE.MeshPhongMaterial({
      color: 0x2d5c20,
      emissive: 0x0a200a,
      emissiveIntensity: 0.25,
      shininess: 40
    });

    var body = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), shellMat);
    body.scale.set(1.2, 0.4, 0.8);
    group.add(body);

    var patMat = new THREE.MeshPhongMaterial({
      color: 0x1a3a10,
      emissive: 0x051005,
      emissiveIntensity: 0.1,
      shininess: 20
    });
    var pat = new THREE.Mesh(new THREE.SphereGeometry(1.02, 6, 4), patMat);
    pat.scale.set(1.2, 0.38, 0.8);
    group.add(pat);

    var headMat = new THREE.MeshPhongMaterial({ color: 0x3d6a2a, shininess: 30 });
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 6, 4), headMat);
    head.position.set(0, 0.05, 0.88);
    group.add(head);

    var eyeMat = new THREE.MeshPhongMaterial({ color: 0x111111 });
    [-0.1, 0.1].forEach(function (ex) {
      var eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 4, 4), eyeMat);
      eye.position.set(ex, 0.08, 0.3);
      head.add(eye);
    });

    var flipMat = new THREE.MeshPhongMaterial({
      color: 0x2d5c20,
      emissive: 0x091508,
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
      group.add(f);
      flippers.push(f);
    });

    group.userData.flippers = flippers;
    group.userData.startPos = new THREE.Vector3(x, y, z);
    registerFauna(group, 'turtle', 'fauna');
  }

  // =============================================================================
  // JELLYFISH — v2: translucent blue with shininess
  // =============================================================================

  function buildJellyfish(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);

    // v2 material: aaddff teal-blue, translucent, high shininess
    var jellyMat = new THREE.MeshPhongMaterial({
      color: 0xaaddff,
      emissive: 0x224466,
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.72,
      shininess: 120
    });

    var bell = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
      jellyMat
    );
    group.add(bell);

    var tendMat = new THREE.MeshPhongMaterial({
      color: 0xaaddff,
      transparent: true,
      opacity: 0.4,
      emissive: 0x113355,
      emissiveIntensity: 0.3
    });
    for (var i = 0; i < 6; i++) {
      var angle = (i / 6) * Math.PI * 2;
      var t = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.008, 1.4 + Math.random() * 0.6, 4),
        tendMat
      );
      t.position.set(Math.cos(angle) * 0.45, -0.72 - 0.25, Math.sin(angle) * 0.45);
      group.add(t);
    }

    group.userData.bell = bell;
    group.userData.baseY = y;
    registerFauna(group, 'jellyfish', 'fauna');
  }

  // =============================================================================
  // CLOWNFISH — v2: canvas-texture stripes
  // =============================================================================

  function buildClownfish(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);
    group.userData.center = new THREE.Vector3(x, y, z);

    var clownTex = makeClownfishTexture();
    var bodyMat = new THREE.MeshPhongMaterial({
      map: clownTex,
      shininess: 60
    });
    var tailMat = new THREE.MeshPhongMaterial({
      color: 0xff8800,
      emissive: 0x441100,
      emissiveIntensity: 0.15
    });

    for (var f = 0; f < 3; f++) {
      var sub = new THREE.Group();
      var body = new THREE.Mesh(new THREE.SphereGeometry(0.3, 6, 4), bodyMat);
      var tail = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.28, 4), tailMat);
      tail.rotation.z = Math.PI / 2;
      tail.position.set(-0.35, 0, 0);
      body.add(tail);
      sub.add(body);
      sub.userData.offset = f * (Math.PI * 2 / 3);
      group.add(sub);
    }

    registerFauna(group, 'clownfish', 'fauna');
  }

  // =============================================================================
  // MANTA RAY — v2: dual-material (dark top / white belly)
  // =============================================================================

  function buildMantaRay(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);

    // v2: wet-black topside
    var topMat = new THREE.MeshPhongMaterial({
      color: 0x151528,
      emissive: 0x040410,
      emissiveIntensity: 0.2,
      shininess: 20
    });
    // v2: white belly with subtle blue emissive
    var bellyMat = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: 0x112233,
      emissiveIntensity: 0.15,
      shininess: 8
    });

    group.add(new THREE.Mesh(new THREE.BoxGeometry(3, 0.15, 1.5), topMat));
    var belly = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.07, 1.3), bellyMat);
    belly.position.y = -0.04;
    group.add(belly);

    var wings = [];
    [[-2.1, 0.02, 0], [2.1, 0.02, 0]].forEach(function (wp, wi) {
      // Top face uses topMat, bottom uses bellyMat
      var wTop = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.06, 1.1), topMat);
      wTop.position.set(wp[0], wp[1], wp[2]);
      wTop.rotation.z = (wi === 0 ? 0.2 : -0.2);

      var wBelly = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.04, 1.1), bellyMat);
      wBelly.position.set(wp[0], wp[1] - 0.04, wp[2]);
      wBelly.rotation.z = (wi === 0 ? 0.2 : -0.2);

      group.add(wTop);
      group.add(wBelly);
      wings.push(wTop); // animate the top mesh for wing flap
    });

    var tail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.02, 2.2, 4), topMat);
    tail.rotation.z = Math.PI / 2;
    tail.position.set(0, 0, -1.3);
    group.add(tail);

    // Cephalic fins
    [-0.35, 0.35].forEach(function (cx) {
      var cf = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.08, 0.4), topMat);
      cf.position.set(cx, 0, 0.85);
      group.add(cf);
    });

    group.userData.wings = wings;
    group.userData.startPos = new THREE.Vector3(x, y, z);
    registerFauna(group, 'mantaray', 'fauna');
  }

  // =============================================================================
  // BIOLUMINESCENT EEL — v2: rippling emissive color chase
  // =============================================================================

  function buildBiolumEel(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);

    var segments = [];
    for (var i = 0; i < 8; i++) {
      var t = i / 7;
      var r = 0.22 - i * 0.014;

      // v2: alternating emissive between 0x00ffcc and 0x0088ff driven by Math.sin
      // We store the segment index so update() can drive the color chase
      var segMat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(0, 0.7 + t * 0.3, 0.75 + t * 0.25),
        emissive: new THREE.Color(0, 0.55, 0.8),
        emissiveIntensity: 0.85 + t * 0.6,
        transparent: true,
        opacity: 0.88,
        shininess: 100
      });

      var seg = new THREE.Mesh(new THREE.SphereGeometry(r, 6, 4), segMat);
      seg.position.set(0, i * 0.33, 0);
      seg.userData.segIndex = i;
      group.add(seg);
      segments.push(seg);
    }

    // Head fin
    var finMat = new THREE.MeshPhongMaterial({
      color: 0x00ffcc,
      emissive: 0x00aa88,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.7
    });
    var fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.5, 0.08), finMat);
    fin.position.set(0.2, 1.2, 0);
    group.add(fin);

    group.userData.segments = segments;
    group.userData.startPos = new THREE.Vector3(x, y, z);
    registerFauna(group, 'eel', 'fauna');
  }

  // =============================================================================
  // SHARK — v2: wet-skin MeshPhongMaterial with specular
  // =============================================================================

  function buildShark() {
    var group = new THREE.Group();

    // v2: wet skin sheen
    var mat = new THREE.MeshPhongMaterial({
      color: 0x5577aa,
      specular: 0x8899bb,
      shininess: 60
    });

    var body = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), mat);
    body.scale.set(3.2, 0.68, 0.82);
    group.add(body);

    // Dorsal fin
    var df = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.95, 0.55), mat);
    df.position.set(0.4, 0.75, 0);
    group.add(df);

    // Caudal fin
    var cf = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.8, 0.55), mat);
    cf.position.set(-2.9, 0.1, 0);
    cf.rotation.z = 0.4;
    group.add(cf);

    // Pectoral fins
    [0.7, -0.7].forEach(function (pz) {
      var pf = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.07, 0.5), mat);
      pf.position.set(0.5, -0.25, pz);
      group.add(pf);
    });

    // Belly (lighter)
    var bellyMat = new THREE.MeshPhongMaterial({ color: 0x8aabb8, shininess: 40 });
    var belly = new THREE.Mesh(new THREE.SphereGeometry(0.95, 8, 4), bellyMat);
    belly.scale.set(2.8, 0.4, 0.65);
    belly.position.y = -0.22;
    group.add(belly);

    group.userData.isShark = true;
    group.userData.angle = 0;
    group.position.set(40, 5, -20);
    _scene.add(group);
    _faunaGroups.push(group);
    _shark = group;
  }

  // =============================================================================
  // createAll — spawn everything, return { fauna[], pollution[], shark }
  // =============================================================================

  function createAll(scene, interactables) {
    _scene = scene;
    _faunaGroups = [];
    _shark = null;
    _interactables = interactables;

    buildSeaTurtle(3,   -2, -18);
    buildJellyfish(-6,   1, -14);
    buildClownfish( 8,  -1, -20);
    buildMantaRay( -4,   3, -30);
    buildBiolumEel(10,  -3, -25);
    buildShark();

    return {
      fauna: _faunaGroups,
      shark: _shark
    };
  }

  // =============================================================================
  // update — all swim / float / undulate animations
  // =============================================================================

  function update(elapsedTime) {
    var t = elapsedTime;

    _faunaGroups.forEach(function (group) {
      if (!group.visible) return;
      var id = group.userData.id;
      var sp = group.userData.startPos;

      // ----- SEA TURTLE -----
      if (id === 'turtle') {
        group.position.x = (sp ? sp.x : 3)   + Math.sin(t * 0.38) * 9;
        group.position.z = (sp ? sp.z : -18)  + Math.cos(t * 0.28) * 6;
        group.position.y = (sp ? sp.y : -2)   + Math.sin(t * 0.65) * 0.6;
        var dx = Math.cos(t * 0.38) * 9 * 0.38;
        var dz = -Math.sin(t * 0.28) * 6 * 0.28;
        group.rotation.y = Math.atan2(dx, -dz);
        if (group.userData.flippers) {
          group.userData.flippers.forEach(function (f, i) {
            f.rotation.z = Math.sin(t * 2.2 + i * Math.PI * 0.5) * 0.38 * (i < 2 ? 1 : -0.55);
          });
        }
      }

      // ----- JELLYFISH -----
      if (id === 'jellyfish') {
        var bell = group.userData.bell;
        if (bell) bell.scale.y = 1 + Math.sin(t * 2.8) * 0.15;
        group.position.y = (group.userData.baseY || 1) + Math.sin(t * 1.4) * 1.4;
        group.children.forEach(function (c, ci) {
          if (ci > 0) c.rotation.z = Math.sin(t * 2.2 + ci * 0.9) * 0.22;
        });
      }

      // ----- CLOWNFISH -----
      if (id === 'clownfish') {
        group.children.forEach(function (sub, fi) {
          var off = sub.userData.offset || fi * (Math.PI * 2 / 3);
          var tt = t * 0.75 + off;
          sub.position.x = Math.sin(tt) * 2.6 + Math.sin(tt * 2.1) * 0.9;
          sub.position.y = Math.cos(tt * 1.25) * 1.1;
          sub.position.z = Math.cos(tt) * 2.2;
          sub.rotation.y = -tt + Math.PI;
        });
      }

      // ----- MANTA RAY -----
      if (id === 'mantaray') {
        var wings = group.userData.wings;
        if (wings) {
          wings.forEach(function (w, wi) {
            w.rotation.z = (wi === 0 ? 1 : -1) * Math.sin(t * 1.4) * 0.3;
          });
        }
        group.position.x = (sp ? sp.x : -4)  + Math.sin(t * 0.22) * 14;
        group.position.z = (sp ? sp.z : -30)  + Math.cos(t * 0.18) * 12;
        group.position.y = (sp ? sp.y : 3)    + Math.sin(t * 0.45) * 1.8;
        var mdx = Math.cos(t * 0.22) * 14 * 0.22;
        var mdz = -Math.sin(t * 0.18) * 12 * 0.18;
        group.rotation.y = Math.atan2(mdx, -mdz) + Math.PI * 0.5;
      }

      // ----- BIOLUMINESCENT EEL — v2: rippling color chase -----
      if (id === 'eel') {
        var segs = group.userData.segments;
        if (segs) {
          segs.forEach(function (seg, si) {
            seg.position.x = Math.sin(t * 2.0 + si * 0.85) * 0.45;
            seg.position.z = Math.cos(t * 1.5 + si * 0.6) * 0.15;

            // v2: color chase — sine wave makes emissive oscillate between 0x00ffcc and 0x0088ff
            var wave = (Math.sin(t * 3.0 + si * 0.9) + 1) * 0.5; // 0..1
            var em = seg.material.emissive;
            em.r = 0;
            em.g = 0.53 + wave * 0.47;   // 0.53 (0x88) → 1.0 (0xff)
            em.b = 0.53 + (1 - wave) * 0.47; // inverse
          });
        }
        group.position.y = (sp ? sp.y : -3) + Math.sin(t * 0.55) * 1.8;
        group.position.x = (sp ? sp.x : 10) + Math.sin(t * 0.35) * 5;
      }

      // ----- SHARK -----
      if (group.userData.isShark) {
        group.userData.angle += 0.07 * (1 / 60); // approximate per-frame increment
        var a = group.userData.angle;
        group.position.x = Math.cos(a) * 42;
        group.position.z = -20 + Math.sin(a) * 42;
        group.position.y = 5 + Math.sin(t * 0.3) * 2;
        group.rotation.y = -a + Math.PI / 2;
      }
    });
  }

  // Shark delta-based update (called with real delta from main.js)
  function updateSharkAngle(delta) {
    if (_shark) {
      _shark.userData.angle += delta * 0.07;
    }
  }

  // =============================================================================
  // Public API
  // =============================================================================

  return {
    createAll:        createAll,
    update:           update,
    updateSharkAngle: updateSharkAngle
  };

}());
