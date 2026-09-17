/* =============================================================================
   ABYSS: Marine Explorer — js/entities.js  v5
   FIX 1: Fauna Dispersion & Independent Animation
   
   CRITICAL RUNTIME ARCHITECTURE:
   - Hardcoded spawn coordinates for all fauna — zero random clustering.
   - Per-instance userData schema on EVERY fauna group:
       id:      `${type}_${index}`
       type:    'fauna'
       scanned: false
       origin:  group.position.clone()  (immutable spawn anchor)
       phase:   index * 1.35            (unique per instance — no shared phase)
       speed:   0.8 + Math.random() * 0.4
   - Animation Loop (update(elapsedTime, delta)):
       Every position & rotation update reads g.userData.phase and g.userData.origin.
       Never reads or mutates a shared closure variable across instances.
       No two instances share a phase value or origin reference.
   - All entities in faunaList are also in window.ABYSS.EntityManager.interactables[].
   - ZERO shader recompilation: emissiveIntensity set once at construction;
     scan highlight uses emissive.setHex() only.
   - Research Hub terminals: O2_REFILL, SPECIMEN_DEPOSIT, WASTE_DISPOSAL.
   - 4 Pollution items + Power Conduit wire-up.
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  /* ─── Module state ──────────────────────────────────────────────────────────── */
  var _scene         = null;
  var _interactables = [];
  var _fauna         = [];      // all animated groups incl. shark
  var _pollution     = [];
  var _shark         = null;

  // Subsea terminal refs (needed by update() for animation)
  var _specimenJar   = null;   // holographic jar mesh — hovers above SPECIMEN_DEPOSIT
  var _wasteHatch    = null;   // hatch mesh — lerp rotation target
  var _o2Light       = null;   // PointLight inside O2 tank — dims during cooldown
  var _specimenLight = null;   // PointLight above jar
  var _o2Terminal    = null;   // O2_REFILL terminal mesh ref (for cooldown visual)

  /* ─── Shark waypoint circuit (radius 44, centered around (0, 4.5, -30)) ─────── */
  var SHARK_WAYPOINTS = [
    new THREE.Vector3( 44, 4.5, -30),
    new THREE.Vector3(  0, 5.0,  14),
    new THREE.Vector3(-44, 4.0, -30),
    new THREE.Vector3(  0, 4.8, -74)
  ];

  /* ─── Static predefined pollution materials ─────────────────────────────────── */
  var POLLUTION_BAG_MAT_1    = null;
  var POLLUTION_BAG_MAT_2    = null;
  var POLLUTION_BARREL_MAT_1 = null;
  var POLLUTION_BARREL_MAT_2 = null;

  function _initPollutionMaterials() {
    if (POLLUTION_BAG_MAT_1) return;
    POLLUTION_BAG_MAT_1 = new THREE.MeshPhongMaterial({
      color: 0xdde8ff, transparent: true, opacity: 0.52,
      shininess: 90, side: THREE.DoubleSide
    });
    POLLUTION_BAG_MAT_2 = new THREE.MeshPhongMaterial({
      color: 0xfff8f0, transparent: true, opacity: 0.48,
      shininess: 80, side: THREE.DoubleSide
    });
    POLLUTION_BARREL_MAT_1 = new THREE.MeshPhongMaterial({
      color: 0xbb3300, shininess: 18,
      emissive: 0x220800, emissiveIntensity: 0.5
    });
    POLLUTION_BARREL_MAT_2 = new THREE.MeshPhongMaterial({
      color: 0x7a4422, shininess: 12,
      emissive: 0x100500, emissiveIntensity: 0.5
    });
  }

  /* ─── Clownfish stripe texture (canvas 2D) ──────────────────────────────────── */
  function _makeClownTex() {
    var cv = document.createElement('canvas');
    cv.width = 128; cv.height = 256;
    var c   = cv.getContext('2d');
    c.fillStyle = '#ff6000';
    c.fillRect(0, 0, 128, 256);
    c.fillStyle = '#ffffff';
    c.fillRect(0, Math.floor(256 * 0.36), 128, Math.floor(256 * 0.10));
    c.fillStyle = '#ffffff';
    c.fillRect(0, Math.floor(256 * 0.60), 128, Math.floor(256 * 0.08));
    c.fillStyle = '#000';
    [0.35, 0.46, 0.59, 0.68].forEach(function (f) {
      c.fillRect(0, Math.floor(256 * f), 128, 3);
    });
    var tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }

  /* ─── Register fauna group with mandatory userData schema ───────────────────── */
  function _registerFauna(group, type, index) {
    group.userData = {
      id:      type + '_' + index,
      type:    'fauna',
      species: type,
      scanned: false,
      origin:  group.position.clone(),     // immutable spawn anchor
      phase:   index * 1.35,               // unique per instance — NO shared phase
      speed:   0.8 + Math.random() * 0.4
    };

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.faunaGroup = group;
        c.userData.faunaId    = group.userData.id;
        c.userData.species    = type;
      }
    });

    _interactables.push(group);
    _fauna.push(group);
    if (_scene) _scene.add(group);
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     MODULE 2 — SUBSEA RESEARCH HUB TERMINALS
     ═══════════════════════════════════════════════════════════════════════════════ */

  /* ─── TERMINAL 1: O2_REFILL ─────────────────────────────────────────────────── */
  function _buildO2Refill(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);

    // Main tank cylinder — cyan glowing casing
    var tankMat = new THREE.MeshPhongMaterial({
      color:             0x006688,
      emissive:          0x003344,
      emissiveIntensity: 0.5,
      shininess:         90,
      specular:          0x44aacc
    });
    var tank = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 2.2, 10), tankMat);
    tank.position.set(0, 1.1, 0);
    group.add(tank);

    // Intake collar ring
    var collarMat = new THREE.MeshPhongMaterial({
      color: 0x224455, emissive: 0x002233, emissiveIntensity: 0.5, shininess: 60
    });
    var collar = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.45, 8), collarMat);
    collar.position.set(0, 2.42, 0);
    group.add(collar);

    // Intake nozzle
    var nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.6, 6), collarMat);
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.set(0.52, 2.42, 0);
    group.add(nozzle);

    // Gauge ring belt around middle of tank
    var gaugeMat = new THREE.MeshPhongMaterial({
      color:             0x00ffcc,
      emissive:          0x00ffcc,
      emissiveIntensity: 0.5,
      shininess:         120
    });
    var gauge = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.04, 6, 16), gaugeMat);
    gauge.rotation.x = Math.PI / 2;
    gauge.position.set(0, 1.1, 0);
    group.add(gauge);

    // Indicator LED strip
    var ledMat = new THREE.MeshPhongMaterial({
      color: 0x00ffcc, emissive: 0x00ffcc, emissiveIntensity: 0.5
    });
    for (var li = 0; li < 4; li++) {
      var led = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.04), ledMat);
      led.position.set(0.56, 0.5 + li * 0.38, 0);
      group.add(led);
    }

    // Floor base plate
    var baseMat = new THREE.MeshPhongMaterial({ color: 0x1a2a35, shininess: 20 });
    var base    = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.18, 10), baseMat);
    base.position.set(0, 0.09, 0);
    group.add(base);

    // Accent PointLight
    var o2Light = new THREE.PointLight(0x00ffcc, 2.0, 9);
    o2Light.position.set(0, 2.0, 0);
    group.add(o2Light);

    // Interactable root
    group.userData.type          = 'terminal';
    group.userData.id            = 'o2_refill';
    group.userData.cooldown      = false;
    group.userData.cooldownStart = 0;
    group.userData.cooldownSecs  = 30;

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.terminalGroup = group;
        c.userData.terminalId    = 'o2_refill';
      }
    });

    _interactables.push(group);
    if (_scene) _scene.add(group);

    _o2Terminal = group;
    _o2Light    = o2Light;
  }

  /* ─── TERMINAL 2: SPECIMEN_DEPOSIT ──────────────────────────────────────────── */
  function _buildSpecimenDeposit(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);

    // Console base body
    var baseMat = new THREE.MeshPhongMaterial({
      color: 0x0a2a14, emissive: 0x041208, emissiveIntensity: 0.3, shininess: 30
    });
    var consoleBody = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 1.4), baseMat);
    consoleBody.position.set(0, 0.45, 0);
    group.add(consoleBody);

    // Angled top surface
    var surroundMat = new THREE.MeshPhongMaterial({
      color: 0x0d3318, emissive: 0x051a0a, emissiveIntensity: 0.3, shininess: 20
    });
    var surround = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 1.2), surroundMat);
    surround.position.set(0, 0.94, 0);
    group.add(surround);

    // Three screen panels
    var screenMat = new THREE.MeshPhongMaterial({
      color:             0x00ff77,
      emissive:          0x004422,
      emissiveIntensity: 0.5,
      transparent:       true,
      opacity:           0.88,
      shininess:         160
    });
    var screenPositions = [-0.72, 0, 0.72];
    screenPositions.forEach(function (sx) {
      var screen = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.38, 0.04), screenMat);
      screen.position.set(sx, 0.94, -0.42);
      screen.rotation.x = -0.32;
      group.add(screen);
    });

    // Specimen tray slot
    var trayMat = new THREE.MeshPhongMaterial({
      color: 0x001a08, emissive: 0x001a08, emissiveIntensity: 0.5, shininess: 8
    });
    var tray = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.6), trayMat);
    tray.position.set(0, 0.96, 0.25);
    group.add(tray);

    // Tray rim glow strip
    var rimMat = new THREE.MeshPhongMaterial({
      color: 0x00ff77, emissive: 0x00ff77, emissiveIntensity: 0.5
    });
    var rim = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.025, 4, 16), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, 0.98, 0.25);
    group.add(rim);

    // Base legs (4 corners)
    var legMat = new THREE.MeshPhongMaterial({ color: 0x0d1f10, shininess: 10 });
    [[-1.0, 0.55], [1.0, 0.55], [-1.0, -0.55], [1.0, -0.55]].forEach(function (lp) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.38, 5), legMat);
      leg.position.set(lp[0], 0.19, lp[1]);
      group.add(leg);
    });

    // Accent light under jar
    var specLight = new THREE.PointLight(0x00ff77, 1.8, 7);
    specLight.position.set(0, 2.8, 0);
    group.add(specLight);

    // ── Holographic Jar ──
    var jarGroup = new THREE.Group();
    jarGroup.position.set(0, 2.0, 0);

    var jarBodyMat = new THREE.MeshPhongMaterial({
      color:             0x88ffcc,
      emissive:          0x00aa55,
      emissiveIntensity: 0.5,
      transparent:       true,
      opacity:           0.42,
      shininess:         200,
      side:              THREE.DoubleSide
    });
    var jarBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.18, 0.54, 10, 1, true),
      jarBodyMat
    );
    jarGroup.add(jarBody);

    var lidMat = new THREE.MeshPhongMaterial({
      color: 0x44ddaa, emissive: 0x00aa55, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.58, shininess: 180
    });
    var lid = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.04, 10), lidMat);
    lid.position.y = 0.28;
    jarGroup.add(lid);

    var jarBase = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.04, 10), lidMat);
    jarBase.position.y = -0.27;
    jarGroup.add(jarBase);

    var contentMat = new THREE.MeshPhongMaterial({
      color: 0xaaffdd, emissive: 0x00ff88, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.55
    });
    var content = new THREE.Mesh(new THREE.SphereGeometry(0.10, 6, 5), contentMat);
    content.position.y = 0.0;
    jarGroup.add(content);

    group.add(jarGroup);

    group.userData.type      = 'terminal';
    group.userData.id        = 'specimen_deposit';
    group.userData.deposited = 0;
    group.userData.jarGroup  = jarGroup;

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.terminalGroup = group;
        c.userData.terminalId    = 'specimen_deposit';
      }
    });

    _interactables.push(group);
    if (_scene) _scene.add(group);

    _specimenJar   = jarGroup;
    _specimenLight = specLight;
  }

  /* ─── TERMINAL 3: WASTE_DISPOSAL ────────────────────────────────────────────── */
  function _buildWasteDisposal(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);

    var frameMat = new THREE.MeshPhongMaterial({
      color: 0x2a2e2e, emissive: 0x0a0e0e, emissiveIntensity: 0.3, shininess: 18
    });

    var frameOuter = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.14, 8), frameMat);
    frameOuter.position.set(0, 0.07, 0);
    group.add(frameOuter);

    var lipMat = new THREE.MeshPhongMaterial({ color: 0x1a1e1e, shininess: 8 });
    var lip    = new THREE.Mesh(new THREE.CylinderGeometry(0.88, 0.88, 0.08, 8), lipMat);
    lip.position.set(0, 0.14, 0);
    group.add(lip);

    var hazardMat = new THREE.MeshPhongMaterial({
      color: 0xffaa00, emissive: 0x441800, emissiveIntensity: 0.5, shininess: 60
    });
    var hazard = new THREE.Mesh(new THREE.TorusGeometry(1.06, 0.05, 5, 8), hazardMat);
    hazard.rotation.x = Math.PI / 2;
    hazard.position.y = 0.14;
    group.add(hazard);

    for (var hi = 0; hi < 4; hi++) {
      var angle = (hi / 4) * Math.PI * 2;
      var wedge = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.04, 0.12), hazardMat);
      wedge.position.set(Math.cos(angle) * 0.95, 0.15, Math.sin(angle) * 0.95);
      wedge.rotation.y = angle;
      group.add(wedge);
    }

    var hatchGroup = new THREE.Group();
    hatchGroup.position.set(0, 0.14, 0);

    var hatchMat = new THREE.MeshPhongMaterial({
      color: 0x3a4040, emissive: 0x0a0e0e, emissiveIntensity: 0.3, shininess: 40
    });
    var centreDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.06, 8), hatchMat);
    hatchGroup.add(centreDisc);

    var bladeMat = new THREE.MeshPhongMaterial({
      color: 0x3d4545, emissive: 0x0c1010, emissiveIntensity: 0.3, shininess: 30
    });
    for (var bi = 0; bi < 3; bi++) {
      var ba    = (bi / 3) * Math.PI * 2;
      var blade = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, 0.32), bladeMat);
      blade.position.set(Math.cos(ba) * 0.44, 0, Math.sin(ba) * 0.44);
      blade.rotation.y = ba + Math.PI * 0.5;
      hatchGroup.add(blade);

      var edgeMat = new THREE.MeshPhongMaterial({
        color: 0x556666, emissive: 0x112222, emissiveIntensity: 0.3
      });
      var edge = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.03, 0.04), edgeMat);
      edge.position.set(Math.cos(ba) * 0.44, 0.04, Math.sin(ba) * 0.44 + 0.15);
      edge.rotation.y = ba + Math.PI * 0.5;
      hatchGroup.add(edge);
    }

    var lugMat = new THREE.MeshPhongMaterial({
      color: 0x556655, emissive: 0x112211, emissiveIntensity: 0.3, shininess: 60
    });
    var lug = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.08), lugMat);
    lug.position.y = 0.09;
    hatchGroup.add(lug);

    var statusMat = new THREE.MeshPhongMaterial({
      color: 0x00ff44, emissive: 0x00ff44, emissiveIntensity: 0.5
    });
    var statusLED = new THREE.Mesh(new THREE.SphereGeometry(0.055, 5, 4), statusMat);
    statusLED.position.set(1.0, 0.18, 0);
    group.add(statusLED);

    group.add(hatchGroup);

    var pitLight = new THREE.PointLight(0xff6600, 0.0, 5);
    pitLight.position.set(0, -0.5, 0);
    group.add(pitLight);

    group.userData.type       = 'terminal';
    group.userData.id         = 'waste_disposal';
    group.userData.hatchOpen  = false;
    group.userData.targetRot  = 0;
    group.userData.hatchGroup = hatchGroup;
    group.userData.statusLED  = statusLED;
    group.userData.pitLight   = pitLight;
    group.userData.disposed   = 0;

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.terminalGroup = group;
        c.userData.terminalId    = 'waste_disposal';
      }
    });

    _interactables.push(group);
    if (_scene) _scene.add(group);

    _wasteHatch = group;
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     FAUNA BUILDERS (Per-Instance Construction)
     ═══════════════════════════════════════════════════════════════════════════════ */

  /* ─── 1. BIOLUMINESCENT EEL ─────────────────────────────────────────────────── */
  function _buildEel(x, y, z, index) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    var segments = [];
    for (var i = 0; i < 8; i++) {
      var tv     = i / 7;
      var rad    = 0.22 - i * 0.014;
      var segMat = new THREE.MeshPhongMaterial({
        color:             new THREE.Color(0, 0.7 + tv * 0.3, 0.75 + tv * 0.25),
        emissive:          new THREE.Color(0, 0.55, 0.8),
        emissiveIntensity: 0.5,
        transparent:       true,
        opacity:           0.88,
        shininess:         100
      });
      var seg = new THREE.Mesh(new THREE.SphereGeometry(rad, 6, 4), segMat);
      seg.position.set(0, i * 0.33, 0);
      seg.userData.segIdx = i;
      g.add(seg);
      segments.push(seg);
    }

    var finMat = new THREE.MeshPhongMaterial({
      color: 0x00ffcc, emissive: 0x00aa88, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.7
    });
    var fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.5, 0.08), finMat);
    fin.position.set(0.2, 1.2, 0);
    g.add(fin);

    g.userData.segments = segments;
    _registerFauna(g, 'eel', index);
  }

  /* ─── 2. SEA TURTLE ─────────────────────────────────────────────────────────── */
  function _buildTurtle(x, y, z, index) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    var shellMat = new THREE.MeshPhongMaterial({
      color: 0x2d5c20, emissive: 0x0a200a, emissiveIntensity: 0.25, shininess: 40
    });
    var body = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), shellMat);
    body.scale.set(1.2, 0.4, 0.8);
    g.add(body);

    var patMat = new THREE.MeshPhongMaterial({
      color: 0x1a3a10, emissive: 0x051005, emissiveIntensity: 0.1, shininess: 20
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
      color: 0x2d5c20, emissive: 0x091508, emissiveIntensity: 0.15
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

    g.userData.flippers = flippers;
    _registerFauna(g, 'turtle', index);
  }

  /* ─── 3. JELLYFISH ──────────────────────────────────────────────────────────── */
  function _buildJellyfish(x, y, z, index) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    var bellMat = new THREE.MeshPhongMaterial({
      color: 0xaaddff, emissive: 0x224466, emissiveIntensity: 0.5,
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

    g.userData.bell = bell;
    _registerFauna(g, 'jellyfish', index);
  }

  /* ─── 4. CLOWNFISH SCHOOL ───────────────────────────────────────────────────── */
  function _buildClownfish(x, y, z, index) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    var clownTex = _makeClownTex();
    var bodyMat  = new THREE.MeshPhongMaterial({ map: clownTex, shininess: 60 });
    var tailMat  = new THREE.MeshPhongMaterial({
      color: 0xff8800, emissive: 0x441100, emissiveIntensity: 0.5
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

    _registerFauna(g, 'clownfish', index);
  }

  /* ─── 5. MANTA RAY ──────────────────────────────────────────────────────────── */
  function _buildMantaRay(x, y, z, index) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    var topMat = new THREE.MeshPhongMaterial({
      color: 0x151528, emissive: 0x040410, emissiveIntensity: 0.5, shininess: 20
    });
    var bellyMat = new THREE.MeshPhongMaterial({
      color: 0xffffff, emissive: 0x112233, emissiveIntensity: 0.5, shininess: 8
    });

    g.add(new THREE.Mesh(new THREE.BoxGeometry(3, 0.15, 1.5), topMat));

    var belly = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.07, 1.3), bellyMat);
    belly.position.y = -0.04;
    g.add(belly);

    var wings = [];
    [[-2.1, 0.02, 0],[2.1, 0.02, 0]].forEach(function (wp, wi) {
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

    g.userData.wings = wings;
    _registerFauna(g, 'mantaray', index);
  }

  /* ─── 6. PATROL SHARK ───────────────────────────────────────────────────────── */
  function _buildShark(index) {
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

    g.position.copy(SHARK_WAYPOINTS[0]);
    g.userData.tailFin = cf;
    g.userData.isShark = true;

    _registerFauna(g, 'shark', index !== undefined ? index : 0);
    _shark = g;
    return g;
  }

  /* ─── 7. POLLUTION ──────────────────────────────────────────────────────────── */
  function buildPollution(scene) {
    var targetScene = scene || _scene;
    _initPollutionMaterials();

    var defs = [
      { geo: new THREE.PlaneGeometry(0.8, 1.0, 2, 2),      mat: POLLUTION_BAG_MAT_1,    pos: [-5,  -6.5, -16], rot: [0.3, 0.5, 0.1]  },
      { geo: new THREE.PlaneGeometry(0.8, 1.0, 2, 2),      mat: POLLUTION_BAG_MAT_2,    pos: [ 9,  -6.2, -21], rot: [0.1, 1.2, 0.2]  },
      { geo: new THREE.CylinderGeometry(0.4, 0.4, 1.0, 8), mat: POLLUTION_BARREL_MAT_1, pos: [ 5,  -7.2, -23], rot: [0.1, 0.2, 0.05] },
      { geo: new THREE.CylinderGeometry(0.4, 0.4, 1.0, 8), mat: POLLUTION_BARREL_MAT_2, pos: [-13, -7.2, -29], rot: [0.0, 0.8, 0.08] }
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

  /* ═══════════════════════════════════════════════════════════════════════════════
     buildAll — Hardcoded Fauna Dispersion (NO Random Clustering)
     ═══════════════════════════════════════════════════════════════════════════════ */
  function buildAll(scene) {
    _scene         = scene;
    _interactables = [];
    _fauna         = [];
    _pollution     = [];
    _shark         = null;
    _specimenJar   = null;
    _wasteHatch    = null;
    _o2Light       = null;
    _specimenLight = null;
    _o2Terminal    = null;

    /* ── 1. Bioluminescent Eel: 5 instances at Trench Floor ── */
    var EEL_SPAWNS = [
      [ 12, -4.5, -24],
      [-14, -5.2, -32],
      [  6, -3.8, -40],
      [ -8, -4.0, -18],
      [ 15, -6.0, -46]
    ];
    EEL_SPAWNS.forEach(function (pos, i) {
      _buildEel(pos[0], pos[1], pos[2], i);
    });

    /* ── 2. Sea Turtle: 3 instances at Varied Depths ── */
    var TURTLE_SPAWNS = [
      [-18, -1.5, -20],
      [  8, -3.0, -35],
      [ -5, -0.8, -15]
    ];
    TURTLE_SPAWNS.forEach(function (pos, i) {
      _buildTurtle(pos[0], pos[1], pos[2], i);
    });

    /* ── 3. Jellyfish: 4 instances (Y: −1 to +4.5) ── */
    var JELLY_SPAWNS = [
      [-10,  3.5, -22],
      [ 14,  1.8, -18],
      [ -3,  4.2, -30],
      [  9, -0.5, -25]
    ];
    JELLY_SPAWNS.forEach(function (pos, i) {
      _buildJellyfish(pos[0], pos[1], pos[2], i);
    });

    /* ── 4. Clownfish School: 1 instance (Orbits Kelp Cluster) ── */
    _buildClownfish(5, -2.0, -28, 0);

    /* ── 5. Manta Ray: 1 instance (Wide upper-layer sweep) ── */
    _buildMantaRay(0, 2.5, -38, 0);

    /* ── 6. Patrol Shark: 1 instance (Perimeter circuit, radius 44) ── */
    _buildShark(0);

    /* ── 7. Pollution Artifacts (4) ── */
    buildPollution(scene);

    /* ── 8. Subsea Research Hub Terminals ── */
    _buildO2Refill      (-12, -8, -50);
    _buildSpecimenDeposit(14, -7, -52);
    _buildWasteDisposal (  4, -8, -42);
  }

  /* ─── registerConduit — wires environment-built conduit into interactables ──── */
  function registerConduit(conduitMesh) {
    if (!conduitMesh) return;
    conduitMesh.userData.type   = 'terminal';
    conduitMesh.userData.id     = 'power_conduit';
    conduitMesh.userData.active = false;
    if (_interactables.indexOf(conduitMesh) === -1) {
      _interactables.push(conduitMesh);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     ANIMATION LOOP — Independent per-instance motion
     Every position and rotation update reads g.userData.phase and g.userData.origin.
     Never reads or mutates a shared closure variable.
     ═══════════════════════════════════════════════════════════════════════════════ */
  function update(elapsedTime, delta) {
    var now    = performance.now();
    var rigPos = (window.ABYSS && window.ABYSS._rigPosition) ? window.ABYSS._rigPosition : null;

    /* ── O2_REFILL cooldown check & LED pulse ── */
    if (_o2Terminal) {
      var oud = _o2Terminal.userData;
      if (oud.cooldown) {
        var elapsed = (now - oud.cooldownStart) / 1000;
        if (elapsed >= oud.cooldownSecs) {
          oud.cooldown = false;
          if (_o2Light) _o2Light.intensity = 2.0;
        } else {
          if (_o2Light) {
            _o2Light.intensity = 0.4 + 0.3 * Math.abs(Math.sin(elapsedTime * 1.5));
          }
        }
      }
    }

    /* ── SPECIMEN_DEPOSIT: jar hovers (Y bob) + slow spin ── */
    if (_specimenJar) {
      _specimenJar.position.y = 2.0 + Math.sin(elapsedTime * 1.2) * 0.22;
      _specimenJar.rotation.y += delta * 0.55;
      if (_specimenLight) {
        _specimenLight.intensity = 1.8 + 0.25 * Math.sin(elapsedTime * 3.8);
      }
    }

    /* ── WASTE_DISPOSAL: hatch lerp rotation (no AnimationClip) ── */
    if (_wasteHatch) {
      var wd = _wasteHatch.userData;
      var hg = wd.hatchGroup;
      if (hg) {
        var target  = wd.targetRot;
        var current = hg.rotation.y;
        var diff    = target - current;
        if (Math.abs(diff) > 0.002) {
          hg.rotation.y += diff * Math.min(delta * 1.8, 1.0);
        } else {
          hg.rotation.y = target;
        }

        var openFrac = hg.rotation.y / Math.PI;
        if (wd.pitLight) {
          wd.pitLight.intensity = openFrac * 2.2;
        }

        if (wd.statusLED && wd.statusLED.material) {
          var closedFrac = 1.0 - openFrac;
          var rHex = Math.round(closedFrac * 0 + openFrac * 255);
          var gHex = Math.round(closedFrac * 255 + openFrac * 68);
          wd.statusLED.material.emissive.setRGB(rHex / 255, gHex / 255, 0);
          wd.statusLED.material.color.setRGB(rHex / 255, gHex / 255, 0);
        }
      }
    }

    /* ── FAUNA ANIMATIONS (Strictly independent per instance) ── */
    for (var i = 0; i < _fauna.length; i++) {
      var g = _fauna[i];
      if (!g.visible) continue;

      var ud = g.userData;
      var t  = elapsedTime * ud.speed + ud.phase;
      var og = ud.origin;

      /* ── Bioluminescent Eel: sinusoidal slither along Z, Y bob ±0.3 ── */
      if (ud.species === 'eel') {
        g.position.x = og.x + Math.sin(t * 0.25) * 1.5;
        g.position.y = og.y + Math.sin(t * 1.2)  * 0.3;
        g.position.z = og.z + Math.sin(t * 0.5)  * 4.0;

        var edx = Math.cos(t * 0.25) * 1.5 * 0.25;
        var edz = Math.cos(t * 0.5)  * 4.0 * 0.5;
        g.rotation.y = Math.atan2(edx, edz);

        if (ud.segments) {
          for (var si = 0; si < ud.segments.length; si++) {
            var seg = ud.segments[si];
            seg.position.x = Math.sin(t * 2.0 + si * 0.85) * 0.45;
            seg.position.z = Math.cos(t * 1.5 + si * 0.60) * 0.15;

            var wave = (Math.sin(t * 3.0 + si * 0.90) + 1) * 0.5;
            var g_ch = Math.round(0x88 + wave * (0xff - 0x88));
            var b_ch = Math.round(0xff - wave * (0xff - 0x88));
            seg.material.emissive.setHex((g_ch << 8) | b_ch);
          }
        }
      }

      /* ── Sea Turtle: elliptical XZ orbit around origin, gentle Y drift ── */
      else if (ud.species === 'turtle') {
        g.position.x = og.x + Math.sin(t * 0.35) * 7.0;
        g.position.y = og.y + Math.sin(t * 0.60) * 0.4;
        g.position.z = og.z + Math.cos(t * 0.35) * 4.5;

        var tdx =  Math.cos(t * 0.35) * 7.0 * 0.35;
        var tdz = -Math.sin(t * 0.35) * 4.5 * 0.35;
        g.rotation.y = Math.atan2(tdx, -tdz);

        if (ud.flippers) {
          for (var fli = 0; fli < ud.flippers.length; fli++) {
            ud.flippers[fli].rotation.z =
              Math.sin(t * 2.2 + fli * Math.PI * 0.5) * 0.38 * (fli < 2 ? 1 : -0.55);
          }
        }
      }

      /* ── Jellyfish: vertical pulse (Y ±0.6), slow horizontal drift ── */
      else if (ud.species === 'jellyfish') {
        g.position.x = og.x + Math.sin(t * 0.30) * 1.2;
        g.position.y = og.y + Math.sin(t * 1.50) * 0.6;
        g.position.z = og.z + Math.cos(t * 0.25) * 1.2;

        if (ud.bell) {
          ud.bell.scale.y = 1.0 + Math.sin(t * 3.0) * 0.16;
          ud.bell.scale.x = 1.0 - Math.sin(t * 3.0) * 0.08;
          ud.bell.scale.z = 1.0 - Math.sin(t * 3.0) * 0.08;
        }

        for (var ci = 0; ci < g.children.length; ci++) {
          var ch = g.children[ci];
          if (ci > 0 && ch.isMesh) {
            ch.rotation.z = Math.sin(t * 2.0 + ci * 0.9) * 0.22;
          }
        }
      }

      /* ── Clownfish School: orbits kelp cluster ── */
      else if (ud.species === 'clownfish') {
        g.position.x = og.x + Math.sin(t * 0.40) * 2.0;
        g.position.y = og.y + Math.sin(t * 0.80) * 0.3;
        g.position.z = og.z + Math.cos(t * 0.40) * 2.0;

        for (var cfi = 0; cfi < g.children.length; cfi++) {
          var sub     = g.children[cfi];
          var subPh   = sub.userData.phase !== undefined ? sub.userData.phase : cfi * (Math.PI * 2 / 3);
          var tt      = t * 1.1 + subPh;
          sub.position.x = Math.sin(tt) * 1.6 + Math.sin(tt * 2.2) * 0.5;
          sub.position.y = Math.cos(tt * 1.3) * 0.5;
          sub.position.z = Math.cos(tt) * 1.4;
          sub.rotation.y = -tt + Math.PI;
        }
      }

      /* ── Manta Ray: wide figure-8 across upper layer ── */
      else if (ud.species === 'mantaray') {
        g.position.x = og.x + Math.sin(t * 0.22) * 15.0;
        g.position.y = og.y + Math.sin(t * 0.45) *  1.5;
        g.position.z = og.z + Math.sin(t * 0.44) *  8.0;

        var mdx = Math.cos(t * 0.22) * 15.0 * 0.22;
        var mdz = Math.cos(t * 0.44) *  8.0 * 0.44;
        g.rotation.y = Math.atan2(mdx, mdz);
        g.rotation.z = -mdx * 0.06;

        if (ud.wings) {
          for (var wi = 0; wi < ud.wings.length; wi++) {
            ud.wings[wi].rotation.z = (wi === 0 ? 1 : -1) * Math.sin(t * 1.4) * 0.3;
          }
        }
      }

      /* ── Patrol Shark: lerp between 4 perimeter waypoints, face travel direction ── */
      else if (ud.species === 'shark' || ud.isShark) {
        var wpCount   = SHARK_WAYPOINTS.length;
        var cycleT    = (t * 0.08) % wpCount;
        if (cycleT < 0) cycleT += wpCount;
        var curIdx    = Math.floor(cycleT);
        var nextIdx   = (curIdx + 1) % wpCount;
        var segFrac   = cycleT - curIdx;

        var pCur  = SHARK_WAYPOINTS[curIdx];
        var pNext = SHARK_WAYPOINTS[nextIdx];

        g.position.lerpVectors(pCur, pNext, segFrac);
        g.position.y += Math.sin(t * 0.8) * 0.4;

        var dirX = pNext.x - pCur.x;
        var dirZ = pNext.z - pCur.z;
        g.rotation.y = Math.atan2(-dirZ, dirX);
        g.rotation.z = Math.sin(t * 1.5) * 0.05;

        if (ud.tailFin) {
          ud.tailFin.rotation.y = Math.sin(t * 3.5) * 0.28;
        }

        if (rigPos) {
          var distSq = (g.position.x - rigPos.x) * (g.position.x - rigPos.x) +
                       (g.position.z - rigPos.z) * (g.position.z - rigPos.z);
          window.ABYSS._sharkNear = (distSq < 144);
        } else {
          window.ABYSS._sharkNear = false;
        }
      }
    }

    /* ── Pollution bob & slow rotation ── */
    for (var pi = 0; pi < _pollution.length; pi++) {
      var pObj = _pollution[pi];
      if (!pObj.userData.collected) {
        pObj.rotation.y += delta * 0.36;
        pObj.position.y  = pObj.userData.baseY + Math.sin(elapsedTime * 1.15 + pObj.position.x * 0.4) * 0.16;
      }
    }
  }

  /* ─── openWasteHatch / closeWasteHatch — called on dwell commit ─────────────── */
  function openWasteHatch() {
    if (!_wasteHatch) return;
    _wasteHatch.userData.hatchOpen = true;
    _wasteHatch.userData.targetRot = Math.PI;
  }

  function closeWasteHatch() {
    if (!_wasteHatch) return;
    _wasteHatch.userData.hatchOpen = false;
    _wasteHatch.userData.targetRot = 0;
  }

  /* ─── startO2Cooldown — called after successful O2 dwell ────────────────────── */
  function startO2Cooldown() {
    if (!_o2Terminal) return;
    _o2Terminal.userData.cooldown      = true;
    _o2Terminal.userData.cooldownStart = performance.now();

    var idx = _interactables.indexOf(_o2Terminal);
    if (idx !== -1) _interactables.splice(idx, 1);

    var self = _o2Terminal;
    setTimeout(function () {
      if (_interactables.indexOf(self) === -1) {
        _interactables.push(self);
      }
    }, _o2Terminal.userData.cooldownSecs * 1000);
  }

  /* ─── reset — between sessions ──────────────────────────────────────────────── */
  function reset() {
    _fauna.forEach(function (f) {
      if (f && f.userData) {
        f.userData.scanned = false;
        if (f.userData.origin) f.position.copy(f.userData.origin);
      }
    });

    _pollution.forEach(function (p) {
      p.userData.collected = false;
      p.visible = true;
      if (p.userData.origin) p.position.copy(p.userData.origin);
      if (_interactables.indexOf(p) === -1) _interactables.push(p);
    });

    if (_o2Terminal) {
      _o2Terminal.userData.cooldown = false;
      if (_o2Light) _o2Light.intensity = 2.0;
      if (_interactables.indexOf(_o2Terminal) === -1) _interactables.push(_o2Terminal);
    }

    if (_wasteHatch) {
      _wasteHatch.userData.hatchOpen = false;
      _wasteHatch.userData.targetRot = 0;
      _wasteHatch.userData.disposed  = 0;
      if (_interactables.indexOf(_wasteHatch) === -1) _interactables.push(_wasteHatch);
    }

    if (_specimenJar) {
      var sd = _specimenJar.parent;
      if (sd && sd.userData) {
        sd.userData.deposited = 0;
        if (_interactables.indexOf(sd) === -1) _interactables.push(sd);
      }
    }

    window.ABYSS._sharkNear = false;
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     PUBLIC API — window.ABYSS.EntityManager
     ═══════════════════════════════════════════════════════════════════════════════ */
  window.ABYSS.EntityManager = {
    buildAll:         buildAll,
    buildPollution:   buildPollution,
    registerConduit:  registerConduit,
    update:           update,
    reset:            reset,
    spawnAll:         buildAll,
    openWasteHatch:   openWasteHatch,
    closeWasteHatch:  closeWasteHatch,
    startO2Cooldown:  startO2Cooldown,
    get interactables() { return _interactables; },
    getInteractables: function () { return _interactables; },
    getPollution:     function () { return _pollution; },
    getFauna:         function () { return _fauna; }
  };

  // Legacy alias — backward compatible with window.EntityManager references
  window.EntityManager = window.ABYSS.EntityManager;

}());
