/* =============================================================================
   ABYSS: Marine Explorer — js/entities.js  v4
   MODULE 2: Subsea Research Hub — 3 dwell terminals added:
     O2_REFILL       — Cyan cylindrical O₂ intake tank with cooldown state.
     SPECIMEN_DEPOSIT— Green flat console + hovering holographic jar.
     WASTE_DISPOSAL  — Industrial hatch mesh with simple lerp rotation.
   Plus all existing fauna (5 scannable + shark), 4 pollution items, power conduit.

   CONSTRAINTS:
   - emissiveIntensity set ONCE at construction, never mutated post-init.
   - Scan highlight: emissive.setHex() only — zero shader recompilation.
   - THREE.AnimationClip NOT used — waste hatch animated via lerp in update().
   - Shark proximity flag → window.ABYSS._sharkNear for main.js O₂ drain.
   - All 3 new terminals registered in _interactables[] at build time.
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
  var _sharkAngle    = 0;

  // Subsea terminal refs (needed by update() for animation)
  var _specimenJar   = null;   // holographic jar mesh — hovers above SPECIMEN_DEPOSIT
  var _wasteHatch    = null;   // hatch mesh — lerp rotation target
  var _o2Light       = null;   // PointLight inside O2 tank — dims during cooldown
  var _specimenLight = null;   // PointLight above jar
  var _o2Terminal    = null;   // O2_REFILL terminal mesh ref (for cooldown visual)

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

  /* ─── Register fauna group — tag meshes for gaze raycasting ────────────────── */
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

  /* ═══════════════════════════════════════════════════════════════════════════════
     MODULE 2 — SUBSEA RESEARCH HUB TERMINALS
     ═══════════════════════════════════════════════════════════════════════════════

     ────────────────────────────────────────────────────────────────────────────
     TERMINAL 1: O2_REFILL
     Cyan cylindrical pressurised tank with intake collar, gauge ring, and
     a PointLight whose intensity is halved during cooldown state.
     Cooldown: 30 seconds after a successful dwell, indicated by emissive drop.
     userData.cooldown = false  → available (bright cyan glow)
     userData.cooldown = true   → unavailable (dim, no interaction)
     userData.cooldownStart = performance.now() timestamp when cooldown began
     ──────────────────────────────────────────────────────────────────────────── */
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

    // Intake collar ring — narrower cylinder on top
    var collarMat = new THREE.MeshPhongMaterial({
      color: 0x224455, emissive: 0x002233, emissiveIntensity: 0.5, shininess: 60
    });
    var collar = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.45, 8), collarMat);
    collar.position.set(0, 2.42, 0);
    group.add(collar);

    // Intake nozzle (horizontal pipe stub)
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

    // Indicator LED strip on front face
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

    // Accent PointLight — halved during cooldown
    var o2Light = new THREE.PointLight(0x00ffcc, 2.0, 9);
    o2Light.position.set(0, 2.0, 0);
    group.add(o2Light);

    // Interactable root — userData registration
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
    _scene.add(group);

    // Store refs for update() animation
    _o2Terminal = group;
    _o2Light    = o2Light;
  }

  /* ────────────────────────────────────────────────────────────────────────────
     TERMINAL 2: SPECIMEN_DEPOSIT
     Flat green console with three screen panels, specimen tray slot, and a
     hovering holographic glass jar above it that bobs and rotates in update().
     The jar rotates continuously and bobs on a sine wave — no AnimationClip.
  ──────────────────────────────────────────────────────────────────────────── */
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

    // Angled top surface / screen surround
    var surroundMat = new THREE.MeshPhongMaterial({
      color: 0x0d3318, emissive: 0x051a0a, emissiveIntensity: 0.3, shininess: 20
    });
    var surround = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 1.2), surroundMat);
    surround.position.set(0, 0.94, 0);
    group.add(surround);

    // Three screen panels (green holo-display)
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

    // Specimen tray slot — recessed darker panel on top centre
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

    // Accent light under the jar position
    var specLight = new THREE.PointLight(0x00ff77, 1.8, 7);
    specLight.position.set(0, 2.8, 0);
    group.add(specLight);

    // ── Holographic Jar ──
    // Thin-walled glass jar geometry: outer cylinder + inner cavity illusion
    var jarGroup = new THREE.Group();
    jarGroup.position.set(0, 2.0, 0);   // starts above tray

    var jarBodyMat = new THREE.MeshPhongMaterial({
      color:             0x88ffcc,
      emissive:          0x00aa55,
      emissiveIntensity: 0.5,
      transparent:       true,
      opacity:           0.42,
      shininess:         200,
      side:              THREE.DoubleSide
    });

    // Jar body (cylinder, open top implied by opacity)
    var jarBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.18, 0.54, 10, 1, true),
      jarBodyMat
    );
    jarGroup.add(jarBody);

    // Jar lid (thin disk)
    var lidMat = new THREE.MeshPhongMaterial({
      color: 0x44ddaa, emissive: 0x00aa55, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.58, shininess: 180
    });
    var lid = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.04, 10), lidMat);
    lid.position.y = 0.28;
    jarGroup.add(lid);

    // Jar base disk
    var jarBase = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.04, 10), lidMat);
    jarBase.position.y = -0.27;
    jarGroup.add(jarBase);

    // Content glow sphere (simulates specimen inside)
    var contentMat = new THREE.MeshPhongMaterial({
      color: 0xaaffdd, emissive: 0x00ff88, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.55
    });
    var content = new THREE.Mesh(new THREE.SphereGeometry(0.10, 6, 5), contentMat);
    content.position.y = 0.0;
    jarGroup.add(content);

    group.add(jarGroup);

    // Interactable root
    group.userData.type         = 'terminal';
    group.userData.id           = 'specimen_deposit';
    group.userData.deposited    = 0;   // specimens deposited count
    group.userData.jarGroup     = jarGroup;

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.terminalGroup = group;
        c.userData.terminalId    = 'specimen_deposit';
      }
    });

    _interactables.push(group);
    _scene.add(group);

    // Store refs for update()
    _specimenJar   = jarGroup;
    _specimenLight = specLight;
  }

  /* ────────────────────────────────────────────────────────────────────────────
     TERMINAL 3: WASTE_DISPOSAL
     Industrial floor-mounted hatch (round iris plate) recessed into the
     seabed surface. Dwell interaction lerps the hatch open (rotation on Y).
     Simple lerp — no THREE.AnimationClip, no mixer, no action.
     userData.hatchOpen = false    → hatch closed (rotation.y = 0)
     userData.hatchOpen = true     → hatch opened (rotation.y = Math.PI)
     _wasteHatch.rotation.y lerps toward target each frame in update().
  ──────────────────────────────────────────────────────────────────────────── */
  function _buildWasteDisposal(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);

    // Floor frame — octagonal recessed collar
    var frameMat = new THREE.MeshPhongMaterial({
      color: 0x2a2e2e, emissive: 0x0a0e0e, emissiveIntensity: 0.3, shininess: 18
    });

    // Frame ring outer
    var frameOuter = new THREE.Mesh(
      new THREE.CylinderGeometry(1.05, 1.05, 0.14, 8),
      frameMat
    );
    frameOuter.position.set(0, 0.07, 0);
    group.add(frameOuter);

    // Frame ring inner lip (darker)
    var lipMat = new THREE.MeshPhongMaterial({
      color: 0x1a1e1e, shininess: 8
    });
    var lip = new THREE.Mesh(new THREE.CylinderGeometry(0.88, 0.88, 0.08, 8), lipMat);
    lip.position.set(0, 0.14, 0);
    group.add(lip);

    // Hazard warning stripe ring
    var hazardMat = new THREE.MeshPhongMaterial({
      color: 0xffaa00, emissive: 0x441800, emissiveIntensity: 0.5, shininess: 60
    });
    var hazard = new THREE.Mesh(new THREE.TorusGeometry(1.06, 0.05, 5, 8), hazardMat);
    hazard.rotation.x = Math.PI / 2;
    hazard.position.y = 0.14;
    group.add(hazard);

    // Hazard wedge markers (4 alternating stripes painted on as thin boxes)
    for (var hi = 0; hi < 4; hi++) {
      var angle    = (hi / 4) * Math.PI * 2;
      var wedge    = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.04, 0.12), hazardMat);
      wedge.position.set(Math.cos(angle) * 0.95, 0.15, Math.sin(angle) * 0.95);
      wedge.rotation.y = angle;
      group.add(wedge);
    }

    // Hatch plate — iris segment assembly (3 interlocking arcs approximated as boxes)
    // The whole hatch group lerp-rotates around Y-axis in update()
    var hatchGroup = new THREE.Group();
    hatchGroup.position.set(0, 0.14, 0);

    var hatchMat = new THREE.MeshPhongMaterial({
      color: 0x3a4040, emissive: 0x0a0e0e, emissiveIntensity: 0.3, shininess: 40
    });

    // Central disc
    var centreDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.06, 8), hatchMat);
    hatchGroup.add(centreDisc);

    // 3 iris blade segments radiating outward
    var bladeMat = new THREE.MeshPhongMaterial({
      color: 0x3d4545, emissive: 0x0c1010, emissiveIntensity: 0.3, shininess: 30
    });
    for (var bi = 0; bi < 3; bi++) {
      var ba = (bi / 3) * Math.PI * 2;

      // Blade body
      var blade = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, 0.32), bladeMat);
      blade.position.set(Math.cos(ba) * 0.44, 0, Math.sin(ba) * 0.44);
      blade.rotation.y = ba + Math.PI * 0.5;
      hatchGroup.add(blade);

      // Blade edge highlight strip
      var edgeMat = new THREE.MeshPhongMaterial({
        color: 0x556666, emissive: 0x112222, emissiveIntensity: 0.3
      });
      var edge = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.03, 0.04), edgeMat);
      edge.position.set(Math.cos(ba) * 0.44, 0.04, Math.sin(ba) * 0.44 + 0.15);
      edge.rotation.y = ba + Math.PI * 0.5;
      hatchGroup.add(edge);
    }

    // Hatch handle lug (small box protruding upward on centre)
    var lugMat = new THREE.MeshPhongMaterial({
      color: 0x556655, emissive: 0x112211, emissiveIntensity: 0.3, shininess: 60
    });
    var lug = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.08), lugMat);
    lug.position.y = 0.09;
    hatchGroup.add(lug);

    // Status light on frame edge (red when open / green when closed)
    var statusMat = new THREE.MeshPhongMaterial({
      color: 0x00ff44, emissive: 0x00ff44, emissiveIntensity: 0.5
    });
    var statusLED = new THREE.Mesh(new THREE.SphereGeometry(0.055, 5, 4), statusMat);
    statusLED.position.set(1.0, 0.18, 0);
    group.add(statusLED);

    group.add(hatchGroup);

    // Accent light inside the hatch pit (visible when open)
    var pitLight = new THREE.PointLight(0xff6600, 0.0, 5);   // intensity 0 → starts hidden
    pitLight.position.set(0, -0.5, 0);
    group.add(pitLight);

    // Interactable root
    group.userData.type         = 'terminal';
    group.userData.id           = 'waste_disposal';
    group.userData.hatchOpen    = false;
    group.userData.targetRot    = 0;         // target hatch rotation Y (radians)
    group.userData.hatchGroup   = hatchGroup;
    group.userData.statusLED    = statusLED;
    group.userData.pitLight     = pitLight;
    group.userData.disposed     = 0;         // pollution items disposed count

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.terminalGroup = group;
        c.userData.terminalId    = 'waste_disposal';
      }
    });

    _interactables.push(group);
    _scene.add(group);

    // Store hatch ref for update() lerp
    _wasteHatch = group;
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     EXISTING FAUNA
  ═══════════════════════════════════════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────────────────────────────────
     SEA TURTLE
  ───────────────────────────────────────────────────────────────────────── */
  function _buildTurtle(x, y, z) {
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
    g.userData.startPos = new THREE.Vector3(x, y, z);
    _registerFauna(g, 'turtle');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     JELLYFISH
  ───────────────────────────────────────────────────────────────────────── */
  function _buildJellyfish(x, y, z) {
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

    g.userData.bell  = bell;
    g.userData.baseY = y;
    _registerFauna(g, 'jellyfish');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     CLOWNFISH SCHOOL (3 fish orbiting shared centre)
  ───────────────────────────────────────────────────────────────────────── */
  function _buildClownfish(x, y, z) {
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

    _registerFauna(g, 'clownfish');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     MANTA RAY — dark top, white belly, wing flap via update()
  ───────────────────────────────────────────────────────────────────────── */
  function _buildMantaRay(x, y, z) {
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

    g.userData.wings    = wings;
    g.userData.startPos = new THREE.Vector3(x, y, z);
    _registerFauna(g, 'mantaray');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BIOLUMINESCENT EEL — 8-segment spine, emissive colour chase via setHex.
     Called 5× with unique positions / phase offsets.
  ───────────────────────────────────────────────────────────────────────── */
  function _buildEel(x, y, z, indexOffset) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    var segments = [];
    for (var i = 0; i < 8; i++) {
      var tv    = i / 7;
      var rad   = 0.22 - i * 0.014;
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
    g.userData.startPos = new THREE.Vector3(x, y, z);
    g.userData.phaseOff = (indexOffset || 0) * 1.3;
    _registerFauna(g, 'eel');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     REEF SHARK — circular outer-perimeter patrol. NOT in interactables.
     Writes window.ABYSS._sharkNear per frame for main.js O₂ drain.
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
    _shark = g;
    return g;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     POLLUTION — 4 artifacts (2 plastic bags, 2 chemical barrels)
  ───────────────────────────────────────────────────────────────────────── */
  function buildPollution(scene) {
    var targetScene = scene || _scene;
    _initPollutionMaterials();

    var defs = [
      { geo: new THREE.PlaneGeometry(0.8, 1.0, 2, 2),       mat: POLLUTION_BAG_MAT_1,    pos: [-5,  -6.5, -16], rot: [0.3, 0.5, 0.1]  },
      { geo: new THREE.PlaneGeometry(0.8, 1.0, 2, 2),       mat: POLLUTION_BAG_MAT_2,    pos: [ 9,  -6.2, -21], rot: [0.1, 1.2, 0.2]  },
      { geo: new THREE.CylinderGeometry(0.4, 0.4, 1.0, 8),  mat: POLLUTION_BARREL_MAT_1, pos: [ 5,  -7.2, -23], rot: [0.1, 0.2, 0.05] },
      { geo: new THREE.CylinderGeometry(0.4, 0.4, 1.0, 8),  mat: POLLUTION_BARREL_MAT_2, pos: [-13, -7.2, -29], rot: [0.0, 0.8, 0.08] }
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
    _shark         = null;
    _specimenJar   = null;
    _wasteHatch    = null;
    _o2Light       = null;
    _specimenLight = null;
    _o2Terminal    = null;

    // ── 5 scannable fauna species ──
    _buildTurtle(3,   -2, -18);
    _buildJellyfish(-6,  1, -14);
    _buildClownfish(8,  -1, -20);
    _buildMantaRay(-4,   3, -30);

    // ── 5 bioluminescent eels ──
    _buildEel( 10, -3, -25, 0);
    _buildEel(-14, -2, -32, 1);
    _buildEel(  6, -4, -38, 2);
    _buildEel( -8, -1, -20, 3);
    _buildEel( 18, -3, -28, 4);

    _buildShark();
    buildPollution(scene);

    // ── MODULE 2: Subsea Research Hub Terminals ──
    // Positioned around the research station at (0, -4, -58):
    //   O2_REFILL      : left flank   (-12, -8, -50) — near seabed floor
    //   SPECIMEN_DEPOSIT: right flank  ( 14, -7, -52) — slightly elevated shelf
    //   WASTE_DISPOSAL  : front-centre (  4, -8, -42) — recessed in seabed
    _buildO2Refill      (-12, -8, -50);
    _buildSpecimenDeposit(14, -7, -52);
    _buildWasteDisposal (  4, -8, -42);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     registerConduit — wires environment-built conduit into interactables.
  ───────────────────────────────────────────────────────────────────────── */
  function registerConduit(conduitMesh) {
    if (!conduitMesh) return;
    conduitMesh.userData.type   = 'terminal';
    conduitMesh.userData.id     = 'power_conduit';
    conduitMesh.userData.active = false;
    if (_interactables.indexOf(conduitMesh) === -1) {
      _interactables.push(conduitMesh);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     update — per-frame animation for all entities + terminal animations.

     Terminal animations:
       O2_REFILL:        LED pulse dims while cooldown active.
       SPECIMEN_DEPOSIT: holographic jar hovers (sine Y-bob) and slow-rotates.
       WASTE_DISPOSAL:   hatch lerps toward targetRot on Y-axis (no AnimationClip).
  ───────────────────────────────────────────────────────────────────────── */
  function update(t, delta) {
    var now    = performance.now();
    var rigPos = (window.ABYSS && window.ABYSS._rigPosition) ? window.ABYSS._rigPosition : null;

    /* ── O2_REFILL cooldown check & LED pulse ── */
    if (_o2Terminal) {
      var ud = _o2Terminal.userData;
      if (ud.cooldown) {
        var elapsed = (now - ud.cooldownStart) / 1000;
        if (elapsed >= ud.cooldownSecs) {
          // Cooldown expired — restore
          ud.cooldown = false;
          if (_o2Light) _o2Light.intensity = 2.0;
        } else {
          // Dim pulsing while cooling down
          if (_o2Light) {
            _o2Light.intensity = 0.4 + 0.3 * Math.abs(Math.sin(t * 1.5));
          }
        }
      }
    }

    /* ── SPECIMEN_DEPOSIT: jar hovers (Y bob) + slow Y-rotation ── */
    if (_specimenJar) {
      // Bob: sine wave, amplitude 0.22u, frequency 1.2 rad/s
      _specimenJar.position.y = 2.0 + Math.sin(t * 1.2) * 0.22;
      // Slow spin on Y
      _specimenJar.rotation.y += delta * 0.55;
      // Specimen light flicker (subtle)
      if (_specimenLight) {
        _specimenLight.intensity = 1.8 + 0.25 * Math.sin(t * 3.8);
      }
    }

    /* ── WASTE_DISPOSAL: hatch lerp rotation (no AnimationClip) ── */
    if (_wasteHatch) {
      var wd       = _wasteHatch.userData;
      var hg       = wd.hatchGroup;
      if (hg) {
        var target  = wd.targetRot;       // 0 = closed, Math.PI = open
        var current = hg.rotation.y;
        var diff    = target - current;
        // Lerp at speed 1.8 rad/s — stops naturally when close
        if (Math.abs(diff) > 0.002) {
          hg.rotation.y += diff * Math.min(delta * 1.8, 1.0);
        } else {
          hg.rotation.y = target;
        }

        // Pit light fades in/out proportional to hatch open angle
        var openFrac = hg.rotation.y / Math.PI;   // 0..1
        if (wd.pitLight) {
          wd.pitLight.intensity = openFrac * 2.2;
        }

        // Status LED colour: green=closed, red=open
        if (wd.statusLED && wd.statusLED.material) {
          var closedFrac = 1.0 - openFrac;
          var rHex = Math.round(closedFrac * 0 + openFrac * 255);   // 0→255
          var gHex = Math.round(closedFrac * 255 + openFrac * 68);  // 255→68
          wd.statusLED.material.emissive.setRGB(rHex / 255, gHex / 255, 0);
          wd.statusLED.material.color.setRGB(rHex / 255, gHex / 255, 0);
        }
      }
    }

    /* ── FAUNA ANIMATIONS ── */
    _fauna.forEach(function (g) {
      if (!g.visible) return;

      var id = g.userData.id;
      var sp = g.userData.startPos;

      /* Turtle */
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

      /* Jellyfish */
      if (id === 'jellyfish') {
        var bell = g.userData.bell;
        if (bell) bell.scale.y = 1 + Math.sin(t * 2.8) * 0.14;
        g.position.y = g.userData.baseY + Math.sin(t * 1.4) * 1.4;
        g.children.forEach(function (c, ci) {
          if (ci > 0) c.rotation.z = Math.sin(t * 2.2 + ci * 0.9) * 0.22;
        });
      }

      /* Clownfish school */
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

      /* Manta ray */
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

      /* Bioluminescent eel — emissive setHex only (no intensity mutation) */
      if (id === 'eel') {
        var segs     = g.userData.segments;
        var phaseOff = g.userData.phaseOff || 0;
        if (segs) {
          segs.forEach(function (seg, si) {
            seg.position.x = Math.sin(t * 2.0 + si * 0.85 + phaseOff) * 0.45;
            seg.position.z = Math.cos(t * 1.5 + si * 0.6  + phaseOff) * 0.15;

            var wave  = (Math.sin(t * 3.0 + si * 0.9 + phaseOff) + 1) * 0.5;
            var g_ch  = Math.round(0x88 + wave * (0xff - 0x88));
            var b_ch  = Math.round(0xff - wave * (0xff - 0x88));
            seg.material.emissive.setHex((g_ch << 8) | b_ch);
          });
        }
        g.position.y = sp.y + Math.sin(t * 0.55 + phaseOff) * 1.8;
        g.position.x = sp.x + Math.sin(t * 0.35 + phaseOff * 0.5) * 5;
      }

      /* Shark — perimeter patrol + proximity flag */
      if (g.userData.isShark) {
        _sharkAngle += delta * 0.065;
        g.position.x = Math.cos(_sharkAngle) * 44;
        g.position.z = -20 + Math.sin(_sharkAngle) * 44;
        g.position.y = 5 + Math.sin(t * 0.28) * 1.8;
        g.rotation.y = -_sharkAngle + Math.PI * 0.5;

        if (rigPos) {
          var dx2  = g.position.x - rigPos.x;
          var dz2  = g.position.z - rigPos.z;
          var dist = Math.sqrt(dx2 * dx2 + dz2 * dz2);
          window.ABYSS._sharkNear = (dist < 12);
        } else {
          window.ABYSS._sharkNear = false;
        }
      }
    });

    /* Pollution bob */
    _pollution.forEach(function (obj) {
      if (!obj.userData.collected) {
        obj.rotation.y += delta * 0.36;
        obj.position.y = obj.userData.baseY + Math.sin(t * 1.15 + obj.position.x * 0.4) * 0.16;
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     openWasteHatch / closeWasteHatch — called by main.js on dwell commit
  ───────────────────────────────────────────────────────────────────────── */
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

  /* ─────────────────────────────────────────────────────────────────────────
     startO2Cooldown — called by main.js after successful O₂ refill dwell
  ───────────────────────────────────────────────────────────────────────── */
  function startO2Cooldown() {
    if (!_o2Terminal) return;
    _o2Terminal.userData.cooldown      = true;
    _o2Terminal.userData.cooldownStart = performance.now();
    // Remove from interactables for the cooldown duration
    var idx = _interactables.indexOf(_o2Terminal);
    if (idx !== -1) _interactables.splice(idx, 1);

    // Re-add after cooldown
    var self = _o2Terminal;
    setTimeout(function () {
      if (_interactables.indexOf(self) === -1) {
        _interactables.push(self);
      }
    }, _o2Terminal.userData.cooldownSecs * 1000);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     reset — between sessions
  ───────────────────────────────────────────────────────────────────────── */
  function reset() {
    _fauna.forEach(function (f) {
      if (f && f.userData) f.userData.scanned = false;
    });

    _pollution.forEach(function (p) {
      p.userData.collected = false;
      p.visible = true;
      if (p.userData.origin) p.position.copy(p.userData.origin);
      if (_interactables.indexOf(p) === -1) _interactables.push(p);
    });

    // Reset O2 terminal
    if (_o2Terminal) {
      _o2Terminal.userData.cooldown = false;
      if (_o2Light) _o2Light.intensity = 2.0;
      if (_interactables.indexOf(_o2Terminal) === -1) _interactables.push(_o2Terminal);
    }

    // Reset waste hatch
    if (_wasteHatch) {
      _wasteHatch.userData.hatchOpen = false;
      _wasteHatch.userData.targetRot = 0;
      _wasteHatch.userData.disposed  = 0;
      if (_interactables.indexOf(_wasteHatch) === -1) _interactables.push(_wasteHatch);
    }

    // Reset specimen deposit
    if (_specimenJar) {
      var sd = _specimenJar.parent;
      if (sd && sd.userData) {
        sd.userData.deposited = 0;
        if (_interactables.indexOf(sd) === -1) _interactables.push(sd);
      }
    }

    _sharkAngle = 0;
    window.ABYSS._sharkNear = false;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API — window.ABYSS.EntityManager
  ───────────────────────────────────────────────────────────────────────── */
  window.ABYSS.EntityManager = {
    buildAll:         buildAll,
    buildPollution:   buildPollution,
    registerConduit:  registerConduit,
    update:           update,
    reset:            reset,
    spawnAll:         buildAll,          // alias per namespace contract
    openWasteHatch:   openWasteHatch,
    closeWasteHatch:  closeWasteHatch,
    startO2Cooldown:  startO2Cooldown,
    get interactables() { return _interactables; },
    getInteractables: function () { return _interactables; },
    getPollution:     function () { return _pollution; }
  };

  // Legacy alias — backward compatible with window.EntityManager references
  window.EntityManager = window.ABYSS.EntityManager;

}());
