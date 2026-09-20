/* =============================================================================
   ABYSS: Marine Explorer — js/entities.js
   MODULE 4: Living Marine Ecosystem, Interactive Objectives & Bounding System

   CRITICAL RUNTIME ARCHITECTURE:
   - Namespace: window.ABYSS.EntityManager (with legacy window.EntityManager)
   - Fauna Speed Scale & Motion Pacing:
       const FAUNA_SPEED_SCALE = 0.65 (35% reduction from baseline).
       Applied across all orbital paths, swimming sine waves, and turning transitions.
       Smooth angular interpolation prevents abrupt direction snaps.
   - 6 Distinct Scannable Fauna Species:
       1. Green Sea Turtle (gliding, periodic flipper sweeps)
       2. Bioluminescent Jellyfish (pulsing bell displacement)
       3. Clownfish School (localized flocking around coral coordinates)
       4. Pelagic Manta Ray (undulating fin wingtips)
       5. Bioluminescent Moray Eel (undulating spine curve)
       6. Reef Octopus (hovering near lower terrain crevices, breathing mantle, curling arms)
       + Ambient Territorial Hazard: Patrol Shark (waypoint perimeter circuit)
   - Interactive Mission Objectives:
       * Exactly 6 scannable fauna instances (1 per species).
       * Exactly 6 pollution hazards anchored to the seabed (crates, drums, nets).
       * 2 power conduit terminals near the subsea base footprint.
       * All interactable meshes contain valid .entityType ('fauna'|'pollution'|'terminal')
         and .entityId.
   - Raycast Bounding Padding:
       const SCAN_SPHERE_RADIUS_SCALE = 1.4 applied across all scannable and
       interactable geometries and collision proxies for responsive mobile gaze dwell.
   - Shader Stability:
       Zero runtime material recompilations: all materials constructed with final
       transparency, opacity, and depth settings.
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  /* ─── Architectural Constants ───────────────────────────────────────────── */
  var FAUNA_SPEED_SCALE        = 0.65; // 35% speed reduction from baseline
  var SCAN_SPHERE_RADIUS_SCALE = 1.40; // 40% expanded gaze hit tolerance

  /* ─── Module State ──────────────────────────────────────────────────────── */
  var _scene         = null;
  var _interactables = [];
  var _fauna         = [];
  var _pollution     = [];
  var _shark         = null;

  // Subsea Research Hub Terminals
  var _specimenJar   = null;
  var _wasteHatch    = null;
  var _o2Light       = null;
  var _specimenLight = null;
  var _o2Terminal    = null;
  var _conduits      = [];

  /* ─── Shark Patrol Waypoints (Radius ~44 Around Hub) ────────────────────── */
  var SHARK_WAYPOINTS = [
    new THREE.Vector3( 44, 4.5, -30),
    new THREE.Vector3(  0, 5.0,  14),
    new THREE.Vector3(-44, 4.0, -30),
    new THREE.Vector3(  0, 4.8, -74)
  ];

  /* ─── Pre-Allocated Static Materials (Zero Runtime Recompilation) ────────── */
  var MAT_CRATE_PLASTIC_1 = null;
  var MAT_CRATE_PLASTIC_2 = null;
  var MAT_BARREL_TOXIC_1  = null;
  var MAT_BARREL_TOXIC_2  = null;
  var MAT_NET_GHOST_1     = null;
  var MAT_NET_GHOST_2     = null;

  function _initStaticMaterials() {
    if (MAT_CRATE_PLASTIC_1) return;

    MAT_CRATE_PLASTIC_1 = new THREE.MeshPhongMaterial({
      color: 0x0088cc, emissive: 0x002244, emissiveIntensity: 0.35,
      shininess: 40, side: THREE.DoubleSide
    });

    MAT_CRATE_PLASTIC_2 = new THREE.MeshPhongMaterial({
      color: 0xdd9900, emissive: 0x442200, emissiveIntensity: 0.35,
      shininess: 35, side: THREE.DoubleSide
    });

    MAT_BARREL_TOXIC_1 = new THREE.MeshPhongMaterial({
      color: 0xbb3311, emissive: 0x330800, emissiveIntensity: 0.45,
      shininess: 25
    });

    MAT_BARREL_TOXIC_2 = new THREE.MeshPhongMaterial({
      color: 0x2e6633, emissive: 0x0a220e, emissiveIntensity: 0.45,
      shininess: 30
    });

    MAT_NET_GHOST_1 = new THREE.MeshPhongMaterial({
      color: 0x88bb99, emissive: 0x113322, emissiveIntensity: 0.25,
      transparent: true, opacity: 0.65, wireframe: true
    });

    MAT_NET_GHOST_2 = new THREE.MeshPhongMaterial({
      color: 0xaaccbb, emissive: 0x1a3328, emissiveIntensity: 0.25,
      transparent: true, opacity: 0.60, wireframe: true
    });
  }

  /* ─── Procedural Clownfish Texture ───────────────────────────────────────── */
  function _makeClownTex() {
    var cv = document.createElement('canvas');
    cv.width = 128; cv.height = 256;
    var c = cv.getContext('2d');
    c.fillStyle = '#ff6000';
    c.fillRect(0, 0, 128, 256);
    c.fillStyle = '#ffffff';
    c.fillRect(0, Math.floor(256 * 0.36), 128, Math.floor(256 * 0.10));
    c.fillStyle = '#ffffff';
    c.fillRect(0, Math.floor(256 * 0.60), 128, Math.floor(256 * 0.08));
    c.fillStyle = '#000000';
    [0.35, 0.46, 0.59, 0.68].forEach(function (f) {
      c.fillRect(0, Math.floor(256 * f), 128, 3);
    });
    var tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }

  /* ─── Raycast Bounding Sphere Padding Helper ─────────────────────────────── */
  function _applyScanPadding(group, approxRadius, entityType, entityId) {
    // 1. Expand existing mesh geometries' bounding spheres by 1.4
    group.traverse(function (child) {
      if (child.isMesh && child.geometry) {
        if (!child.geometry.boundingSphere) {
          child.geometry.computeBoundingSphere();
        }
        if (child.geometry.boundingSphere) {
          child.geometry.boundingSphere.radius *= SCAN_SPHERE_RADIUS_SCALE;
        }
      }
    });

    // 2. Add an invisible dilated spherical hit-proxy for forgiving mobile gaze dwell
    var hitRadius = (approxRadius || 1.2) * SCAN_SPHERE_RADIUS_SCALE;
    var proxyGeo  = new THREE.SphereGeometry(hitRadius, 6, 4);
    proxyGeo.computeBoundingSphere();
    if (proxyGeo.boundingSphere) {
      proxyGeo.boundingSphere.radius *= SCAN_SPHERE_RADIUS_SCALE;
    }
    var proxyMat = new THREE.MeshBasicMaterial({
      visible:     false,
      transparent: true,
      opacity:     0,
      depthWrite:  false
    });
    var proxyMesh = new THREE.Mesh(proxyGeo, proxyMat);
    proxyMesh.userData.faunaGroup    = group;
    proxyMesh.userData.terminalGroup = group;
    proxyMesh.userData.type          = entityType;
    proxyMesh.userData.id            = entityId;
    proxyMesh.userData.entityType    = entityType;
    proxyMesh.userData.entityId      = entityId;
    group.add(proxyMesh);
  }

  /* ─── Fauna Registration & Schema Enforcement ───────────────────────────── */
  function _registerFauna(group, species, index, approxRadius) {
    var entityId = species + '_' + index;
    group.userData = {
      id:         entityId,
      entityId:   entityId,
      type:       'fauna',
      entityType: 'fauna',
      species:    species,
      scanned:    false,
      origin:     group.position.clone(),
      phase:      index * 1.45,
      speed:      0.85 + Math.random() * 0.35,
      currentYaw: group.rotation.y
    };

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.faunaGroup = group;
        c.userData.faunaId    = entityId;
        c.userData.species    = species;
        c.userData.entityType = 'fauna';
        c.userData.entityId   = entityId;
        c.userData.type       = 'fauna';
        c.userData.id         = entityId;
      }
    });

    _applyScanPadding(group, approxRadius || 1.2, 'fauna', entityId);

    _interactables.push(group);
    _fauna.push(group);
    if (_scene) _scene.add(group);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SUBSEA RESEARCH HUB TERMINALS & CONDUITS
     ═══════════════════════════════════════════════════════════════════════════ */

  /* ─── TERMINAL 1: O2_REFILL ──────────────────────────────────────────────── */
  function _buildO2Refill(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);

    var tankMat = new THREE.MeshPhongMaterial({
      color: 0x006688, emissive: 0x003344, emissiveIntensity: 0.5,
      shininess: 90, specular: 0x44aacc
    });
    var tank = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 2.2, 10), tankMat);
    tank.position.set(0, 1.1, 0);
    group.add(tank);

    var collarMat = new THREE.MeshPhongMaterial({
      color: 0x224455, emissive: 0x002233, emissiveIntensity: 0.5, shininess: 60
    });
    var collar = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.45, 8), collarMat);
    collar.position.set(0, 2.42, 0);
    group.add(collar);

    var nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.6, 6), collarMat);
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.set(0.52, 2.42, 0);
    group.add(nozzle);

    var gaugeMat = new THREE.MeshPhongMaterial({
      color: 0x00ffcc, emissive: 0x00ffcc, emissiveIntensity: 0.5, shininess: 120
    });
    var gauge = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.04, 6, 16), gaugeMat);
    gauge.rotation.x = Math.PI / 2;
    gauge.position.set(0, 1.1, 0);
    group.add(gauge);

    var base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.72, 0.72, 0.18, 10),
      new THREE.MeshPhongMaterial({ color: 0x1a2a35, shininess: 20 })
    );
    base.position.set(0, 0.09, 0);
    group.add(base);

    var o2Light = new THREE.PointLight(0x00ffcc, 2.0, 9);
    o2Light.position.set(0, 2.0, 0);
    group.add(o2Light);

    group.userData.type          = 'terminal';
    group.userData.entityType    = 'terminal';
    group.userData.id            = 'o2_refill';
    group.userData.entityId      = 'o2_refill';
    group.userData.cooldown      = false;
    group.userData.cooldownStart = 0;
    group.userData.cooldownSecs  = 30;

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.terminalGroup = group;
        c.userData.terminalId    = 'o2_refill';
        c.userData.entityType    = 'terminal';
        c.userData.entityId      = 'o2_refill';
        c.userData.type          = 'terminal';
        c.userData.id            = 'o2_refill';
      }
    });

    _applyScanPadding(group, 1.5, 'terminal', 'o2_refill');
    _interactables.push(group);
    if (_scene) _scene.add(group);

    _o2Terminal = group;
    _o2Light    = o2Light;
  }

  /* ─── TERMINAL 2: SPECIMEN_DEPOSIT ───────────────────────────────────────── */
  function _buildSpecimenDeposit(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);

    var baseMat = new THREE.MeshPhongMaterial({
      color: 0x0a2a14, emissive: 0x041208, emissiveIntensity: 0.3, shininess: 30
    });
    var consoleBody = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 1.4), baseMat);
    consoleBody.position.set(0, 0.45, 0);
    group.add(consoleBody);

    var screenMat = new THREE.MeshPhongMaterial({
      color: 0x00ff77, emissive: 0x004422, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.88, shininess: 160
    });
    [-0.72, 0, 0.72].forEach(function (sx) {
      var screen = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.38, 0.04), screenMat);
      screen.position.set(sx, 0.94, -0.42);
      screen.rotation.x = -0.32;
      group.add(screen);
    });

    var jarGroup = new THREE.Group();
    jarGroup.position.set(0, 2.0, 0);

    var jarBodyMat = new THREE.MeshPhongMaterial({
      color: 0x88ffcc, emissive: 0x00aa55, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.42, shininess: 200, side: THREE.DoubleSide
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

    group.add(jarGroup);

    var specLight = new THREE.PointLight(0x00ff77, 1.8, 7);
    specLight.position.set(0, 2.8, 0);
    group.add(specLight);

    group.userData.type       = 'terminal';
    group.userData.entityType = 'terminal';
    group.userData.id         = 'specimen_deposit';
    group.userData.entityId   = 'specimen_deposit';
    group.userData.deposited  = 0;
    group.userData.jarGroup   = jarGroup;

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.terminalGroup = group;
        c.userData.terminalId    = 'specimen_deposit';
        c.userData.entityType    = 'terminal';
        c.userData.entityId      = 'specimen_deposit';
        c.userData.type          = 'terminal';
        c.userData.id            = 'specimen_deposit';
      }
    });

    _applyScanPadding(group, 1.8, 'terminal', 'specimen_deposit');
    _interactables.push(group);
    if (_scene) _scene.add(group);

    _specimenJar   = jarGroup;
    _specimenLight = specLight;
  }

  /* ─── TERMINAL 3: WASTE_DISPOSAL ─────────────────────────────────────────── */
  function _buildWasteDisposal(x, y, z) {
    var group = new THREE.Group();
    group.position.set(x, y, z);

    var frameMat = new THREE.MeshPhongMaterial({
      color: 0x2a2e2e, emissive: 0x0a0e0e, emissiveIntensity: 0.3, shininess: 18
    });
    var frameOuter = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.14, 8), frameMat);
    frameOuter.position.set(0, 0.07, 0);
    group.add(frameOuter);

    var hazardMat = new THREE.MeshPhongMaterial({
      color: 0xffaa00, emissive: 0x441800, emissiveIntensity: 0.5, shininess: 60
    });
    var hazard = new THREE.Mesh(new THREE.TorusGeometry(1.06, 0.05, 5, 8), hazardMat);
    hazard.rotation.x = Math.PI / 2;
    hazard.position.y = 0.14;
    group.add(hazard);

    var hatchGroup = new THREE.Group();
    hatchGroup.position.set(0, 0.14, 0);

    var hatchMat = new THREE.MeshPhongMaterial({
      color: 0x3a4040, emissive: 0x0a0e0e, emissiveIntensity: 0.3, shininess: 40
    });
    var centreDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.06, 8), hatchMat);
    hatchGroup.add(centreDisc);

    for (var bi = 0; bi < 3; bi++) {
      var ba    = (bi / 3) * Math.PI * 2;
      var blade = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, 0.32), hatchMat);
      blade.position.set(Math.cos(ba) * 0.44, 0, Math.sin(ba) * 0.44);
      blade.rotation.y = ba + Math.PI * 0.5;
      hatchGroup.add(blade);
    }

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
    group.userData.entityType = 'terminal';
    group.userData.id         = 'waste_disposal';
    group.userData.entityId   = 'waste_disposal';
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
        c.userData.entityType    = 'terminal';
        c.userData.entityId      = 'waste_disposal';
        c.userData.type          = 'terminal';
        c.userData.id            = 'waste_disposal';
      }
    });

    _applyScanPadding(group, 1.4, 'terminal', 'waste_disposal');
    _interactables.push(group);
    if (_scene) _scene.add(group);

    _wasteHatch = group;
  }

  /* ─── TERMINALS 4 & 5: TWO POWER CONDUIT TERMINALS ───────────────────────── */
  function _buildPowerConduit(x, y, z, index) {
    var conduitId = 'power_conduit' + (index === 0 ? '' : '_' + index);
    var group = new THREE.Group();
    group.position.set(x, y, z);

    // Foundation pad
    var padMat = new THREE.MeshPhongMaterial({
      color: 0x18242c, emissive: 0x060c12, emissiveIntensity: 0.3, shininess: 20
    });
    var pad = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.25, 2.0), padMat);
    pad.position.y = 0.125;
    group.add(pad);

    // Power core pillar
    var pillarMat = new THREE.MeshPhongMaterial({
      color: 0x223644, emissive: 0x0b151e, emissiveIntensity: 0.4, shininess: 50
    });
    var pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, 1.8, 8), pillarMat);
    pillar.position.y = 1.0;
    group.add(pillar);

    // Glowing energy plasma coil
    var coilMat = new THREE.MeshPhongMaterial({
      color: 0x00ffee, emissive: 0x0088aa, emissiveIntensity: 0.65, shininess: 120
    });
    var coil = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.05, 6, 16), coilMat);
    coil.rotation.x = Math.PI / 2;
    coil.position.y = 1.25;
    group.add(coil);

    var coil2 = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.04, 6, 16), coilMat);
    coil2.rotation.x = Math.PI / 2;
    coil2.position.y = 0.85;
    group.add(coil2);

    // Terminal terminal light
    var tLight = new THREE.PointLight(0x00ffee, 2.2, 10);
    tLight.position.set(0, 1.6, 0);
    group.add(tLight);

    group.userData.type       = 'terminal';
    group.userData.entityType = 'terminal';
    group.userData.id         = conduitId;
    group.userData.entityId   = conduitId;
    group.userData.active     = false;
    group.userData.coil       = coil;
    group.userData.coil2      = coil2;
    group.userData.tLight     = tLight;

    group.traverse(function (c) {
      if (c.isMesh) {
        c.userData.terminalGroup = group;
        c.userData.terminalId    = conduitId;
        c.userData.entityType    = 'terminal';
        c.userData.entityId      = conduitId;
        c.userData.type          = 'terminal';
        c.userData.id            = conduitId;
      }
    });

    _applyScanPadding(group, 1.6, 'terminal', conduitId);
    _interactables.push(group);
    _conduits.push(group);
    if (_scene) _scene.add(group);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     6 DISTINCT SCANNABLE FAUNA SPECIES
     ═══════════════════════════════════════════════════════════════════════════ */

  /* ─── 1. GREEN SEA TURTLE ────────────────────────────────────────────────── */
  function _buildTurtle(x, y, z, index) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    var shellMat = new THREE.MeshPhongMaterial({
      color: 0x2d5c20, emissive: 0x0a200a, emissiveIntensity: 0.25, shininess: 40
    });
    var body = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), shellMat);
    body.scale.set(1.2, 0.4, 0.8);
    g.add(body);

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
    var flippers = [];
    [
      { pos: [ 1.15, 0,  0.15], sz: [0.75, 0.08, 0.32] },
      { pos: [-1.15, 0,  0.15], sz: [0.75, 0.08, 0.32] },
      { pos: [ 0.85, 0, -0.50], sz: [0.52, 0.07, 0.24] },
      { pos: [-0.85, 0, -0.50], sz: [0.52, 0.07, 0.24] }
    ].forEach(function (fd) {
      var f = new THREE.Mesh(new THREE.BoxGeometry(fd.sz[0], fd.sz[1], fd.sz[2]), flipMat);
      f.position.set(fd.pos[0], fd.pos[1], fd.pos[2]);
      g.add(f);
      flippers.push(f);
    });

    g.userData.flippers = flippers;
    _registerFauna(g, 'turtle', index, 1.8);
  }

  /* ─── 2. BIOLUMINESCENT JELLYFISH ────────────────────────────────────────── */
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
    for (var i = 0; i < 8; i++) {
      var angle = (i / 8) * Math.PI * 2;
      var len   = 1.4 + (i % 3) * 0.3;
      var t     = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.007, len, 4), tendMat);
      t.position.set(Math.cos(angle) * 0.44, -0.9 - len * 0.5, Math.sin(angle) * 0.44);
      g.add(t);
    }

    g.userData.bell = bell;
    _registerFauna(g, 'jellyfish', index, 1.6);
  }

  /* ─── 3. CLOWNFISH SCHOOL ────────────────────────────────────────────────── */
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

    _registerFauna(g, 'clownfish', index, 1.4);
  }

  /* ─── 4. PELAGIC MANTA RAY ───────────────────────────────────────────────── */
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

    g.userData.wings = wings;
    _registerFauna(g, 'mantaray', index, 3.2);
  }

  /* ─── 5. BIOLUMINESCENT MORAY EEL ────────────────────────────────────────── */
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
    _registerFauna(g, 'eel', index, 1.8);
  }

  /* ─── 6. REEF OCTOPUS (NEW 6TH SPECIES) ──────────────────────────────────── */
  function _buildOctopus(x, y, z, index) {
    var g = new THREE.Group();
    g.position.set(x, y, z);

    // Bulbous mantle / head
    var skinMat = new THREE.MeshPhongMaterial({
      color: 0xb84a39, emissive: 0x3d140e, emissiveIntensity: 0.45,
      shininess: 45
    });
    var mantle = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), skinMat);
    mantle.scale.set(0.9, 1.2, 0.95);
    mantle.position.y = 0.55;
    g.add(mantle);

    // Expressive gold-flecked eyes with horizontal slits
    var eyeBaseMat = new THREE.MeshPhongMaterial({ color: 0x221100, shininess: 80 });
    var irisMat    = new THREE.MeshPhongMaterial({ color: 0xffcc33, emissive: 0x664400, emissiveIntensity: 0.5 });
    [-0.26, 0.26].forEach(function (ex) {
      var eyeBase = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), eyeBaseMat);
      eyeBase.position.set(ex, 0.35, 0.38);
      var pupil = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.03, 0.04), irisMat);
      pupil.position.set(0, 0, 0.1);
      eyeBase.add(pupil);
      g.add(eyeBase);
    });

    // Siphon exhaust tube
    var siphon = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.32, 6), skinMat);
    siphon.rotation.x = -0.6;
    siphon.position.set(0, 0.22, -0.42);
    g.add(siphon);

    // 8 Pre-curled crawling & swaying arms
    var arms = [];
    for (var a = 0; a < 8; a++) {
      var ang     = (a / 8) * Math.PI * 2;
      var armRoot = new THREE.Group();
      armRoot.position.set(Math.cos(ang) * 0.30, 0.15, Math.sin(ang) * 0.30);
      armRoot.rotation.y = -ang;

      var armJoints = [];
      var segCount = 4;
      var lastParent = armRoot;

      for (var s = 0; s < segCount; s++) {
        var segLen = 0.34 - s * 0.04;
        var segRad = 0.09 - s * 0.016;
        var segMesh = new THREE.Mesh(new THREE.CylinderGeometry(segRad * 0.8, segRad, segLen, 5), skinMat);
        segMesh.position.y = -segLen * 0.5;

        var joint = new THREE.Group();
        if (s > 0) joint.position.y = -segLen;
        joint.add(segMesh);
        lastParent.add(joint);
        armJoints.push(joint);
        lastParent = joint;
      }

      g.add(armRoot);
      arms.push(armJoints);
    }

    g.userData.mantle = mantle;
    g.userData.arms   = arms;
    _registerFauna(g, 'octopus', index, 1.8);
  }

  /* ─── TERRITORIAL HAZARD: AMBIENT PATROL SHARK ───────────────────────────── */
  function _buildShark(index) {
    var g = new THREE.Group();
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

    _registerFauna(g, 'shark', index !== undefined ? index : 0, 3.8);
    _shark = g;
    return g;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     6 ANCHORED SEABED POLLUTION HAZARDS
     ═══════════════════════════════════════════════════════════════════════════ */
  function buildPollution(scene) {
    var targetScene = scene || _scene;
    _initStaticMaterials();

    var pollutionDefs = [
      // 1. Plastic Crate A
      {
        id: 'pollution_0', pos: [-5, -7.2, -18],
        build: function () {
          var grp = new THREE.Group();
          var box = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.85), MAT_CRATE_PLASTIC_1);
          grp.add(box);
          var rim = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.1, 0.92), MAT_CRATE_PLASTIC_1);
          rim.position.y = 0.32;
          grp.add(rim);
          return grp;
        }
      },
      // 2. Chemical Drum A
      {
        id: 'pollution_1', pos: [8, -7.3, -22],
        build: function () {
          var grp = new THREE.Group();
          var drum = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 8), MAT_BARREL_TOXIC_1);
          drum.rotation.z = 0.25;
          grp.add(drum);
          return grp;
        }
      },
      // 3. Discarded Ghost Net A
      {
        id: 'pollution_2', pos: [-14, -7.0, -28],
        build: function () {
          var grp = new THREE.Group();
          var net = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.4, 4, 4), MAT_NET_GHOST_1);
          net.rotation.x = -Math.PI * 0.35;
          grp.add(net);
          return grp;
        }
      },
      // 4. Heavy Cargo Crate B
      {
        id: 'pollution_3', pos: [11, -7.4, -33],
        build: function () {
          var grp = new THREE.Group();
          var box = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.8, 1.0), MAT_CRATE_PLASTIC_2);
          box.rotation.y = 0.45;
          grp.add(box);
          return grp;
        }
      },
      // 5. Toxic Waste Drum B
      {
        id: 'pollution_4', pos: [-3, -7.3, -37],
        build: function () {
          var grp = new THREE.Group();
          var drum = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.15, 8), MAT_BARREL_TOXIC_2);
          drum.rotation.x = 0.3;
          drum.rotation.z = 0.15;
          grp.add(drum);
          return grp;
        }
      },
      // 6. Discarded Ghost Net B
      {
        id: 'pollution_5', pos: [16, -6.9, -43],
        build: function () {
          var grp = new THREE.Group();
          var net = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.6, 4, 4), MAT_NET_GHOST_2);
          net.rotation.x = -Math.PI * 0.4;
          net.rotation.y = 0.2;
          grp.add(net);
          return grp;
        }
      }
    ];

    pollutionDefs.forEach(function (d) {
      var m = d.build();
      m.position.set(d.pos[0], d.pos[1], d.pos[2]);

      m.userData.type       = 'pollution';
      m.userData.entityType = 'pollution';
      m.userData.id         = d.id;
      m.userData.entityId   = d.id;
      m.userData.collected  = false;
      m.userData.baseY      = d.pos[1];
      m.userData.origin     = m.position.clone();

      m.traverse(function (child) {
        if (child.isMesh) {
          child.userData.type       = 'pollution';
          child.userData.entityType = 'pollution';
          child.userData.id         = d.id;
          child.userData.entityId   = d.id;
        }
      });

      _applyScanPadding(m, 1.4, 'pollution', d.id);
      _pollution.push(m);
      _interactables.push(m);
      if (targetScene) targetScene.add(m);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     buildAll — Hardcoded Ecological Spawns (NO Clustering)
     ═══════════════════════════════════════════════════════════════════════════ */
  function buildAll(scene) {
    _scene         = scene;
    _interactables = [];
    _fauna         = [];
    _pollution     = [];
    _conduits      = [];
    _shark         = null;
    _specimenJar   = null;
    _wasteHatch    = null;
    _o2Light       = null;
    _specimenLight = null;
    _o2Terminal    = null;

    /* ── EXACTLY 6 SCANNABLE FAUNA INSTANCES (1 per Species) ── */
    // 1. Green Sea Turtle: Mid-depth reef crossing
    _buildTurtle   (-14, -2.0, -22, 0);

    // 2. Bioluminescent Jellyfish: Sunlit shallows buoyant drift
    _buildJellyfish( 12,  2.5, -26, 0);

    // 3. Clownfish School: Localized flocking near coral mound
    _buildClownfish(  6, -3.2, -28, 0);

    // 4. Pelagic Manta Ray: Wide sweep through upper pelagic layer
    _buildMantaRay (  0,  3.8, -36, 0);

    // 5. Bioluminescent Moray Eel: Lower trench crevice
    _buildEel      (-10, -5.5, -32, 0);

    // 6. Reef Octopus: Anchored near deep seabed boulders
    _buildOctopus  ( -6, -6.8, -24, 0);

    /* ── Ambient Territorial Hazard: Patrol Shark (Perimeter Radius 44) ── */
    _buildShark(0);

    /* ── EXACTLY 6 SEABED POLLUTION HAZARDS ── */
    buildPollution(scene);

    /* ── SUBSEA RESEARCH HUB: 2 POWER CONDUITS + 3 TERMINALS ── */
    _buildPowerConduit(-7, -7.6, -46, 0); // Conduit Terminal 1 (North-West Hub)
    _buildPowerConduit( 7, -7.6, -48, 1); // Conduit Terminal 2 (North-East Hub)

    _buildO2Refill      (-12, -8, -50);
    _buildSpecimenDeposit( 14, -7, -52);
    _buildWasteDisposal (  4, -8, -42);

    return _interactables;
  }

  /* ─── registerConduit — Legacy environment hook compatibility ───────────── */
  function registerConduit(conduitMesh) {
    if (!conduitMesh) return;
    conduitMesh.userData.type       = 'terminal';
    conduitMesh.userData.entityType = 'terminal';
    conduitMesh.userData.id         = 'power_conduit';
    conduitMesh.userData.entityId   = 'power_conduit';
    conduitMesh.userData.active     = false;

    _applyScanPadding(conduitMesh, 1.5, 'terminal', 'power_conduit');
    if (_interactables.indexOf(conduitMesh) === -1) {
      _interactables.push(conduitMesh);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     ANIMATION LOOP — Paced with FAUNA_SPEED_SCALE & Smooth Turns
     ═══════════════════════════════════════════════════════════════════════════ */
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

    /* ── SPECIMEN_DEPOSIT jar hovering + rotation ── */
    if (_specimenJar) {
      _specimenJar.position.y = 2.0 + Math.sin(elapsedTime * 1.2) * 0.22;
      _specimenJar.rotation.y += delta * 0.55;
      if (_specimenLight) {
        _specimenLight.intensity = 1.8 + 0.25 * Math.sin(elapsedTime * 3.8);
      }
    }

    /* ── WASTE_DISPOSAL hatch lerp ── */
    if (_wasteHatch) {
      var wd = _wasteHatch.userData;
      var hg = wd.hatchGroup;
      if (hg) {
        var target  = wd.targetRot;
        var diff    = target - hg.rotation.y;
        if (Math.abs(diff) > 0.002) {
          hg.rotation.y += diff * Math.min(delta * 1.8, 1.0);
        } else {
          hg.rotation.y = target;
        }

        var openFrac = hg.rotation.y / Math.PI;
        if (wd.pitLight) {
          wd.pitLight.intensity = openFrac * 2.2;
        }
      }
    }

    /* ── CONDUIT TERMINALS: Ambient Energy Pulse ── */
    for (var ci = 0; ci < _conduits.length; ci++) {
      var cObj = _conduits[ci];
      if (cObj && cObj.userData.coil) {
        cObj.userData.coil.rotation.z += delta * 0.6;
        cObj.userData.coil2.rotation.z -= delta * 0.4;
      }
    }

    /* ── FAUNA MOTION LOOP WITH FAUNA_SPEED_SCALE & SMOOTH TURNING ── */
    for (var i = 0; i < _fauna.length; i++) {
      var g  = _fauna[i];
      var ud = g.userData;
      if (!g.visible || !ud) continue;

      // Paced continuous time factor
      var t  = (elapsedTime * ud.speed * FAUNA_SPEED_SCALE) + ud.phase;
      var og = ud.origin;

      /* ── 1. Green Sea Turtle: Elliptical Glide & Flipper Sweeps ── */
      if (ud.species === 'turtle') {
        var prevX = g.position.x;
        var prevZ = g.position.z;

        g.position.x = og.x + Math.sin(t * 0.32) * 7.5;
        g.position.y = og.y + Math.sin(t * 0.55) * 0.45;
        g.position.z = og.z + Math.cos(t * 0.32) * 5.0;

        var tdx = g.position.x - prevX;
        var tdz = g.position.z - prevZ;
        if (Math.hypot(tdx, tdz) > 0.001) {
          var targetYaw = Math.atan2(tdx, -tdz);
          var diffYaw   = targetYaw - g.rotation.y;
          while (diffYaw >  Math.PI) diffYaw -= Math.PI * 2;
          while (diffYaw < -Math.PI) diffYaw += Math.PI * 2;
          g.rotation.y += diffYaw * Math.min(delta * 2.0 * FAUNA_SPEED_SCALE, 1.0);
        }

        if (ud.flippers) {
          for (var fli = 0; fli < ud.flippers.length; fli++) {
            ud.flippers[fli].rotation.z =
              Math.sin(t * 2.0 + fli * Math.PI * 0.5) * 0.35 * (fli < 2 ? 1 : -0.5);
          }
        }
      }

      /* ── 2. Bioluminescent Jellyfish: Pulsing Bell Displacement ── */
      else if (ud.species === 'jellyfish') {
        g.position.x = og.x + Math.sin(t * 0.28) * 1.4;
        g.position.y = og.y + Math.sin(t * 1.40) * 0.7;
        g.position.z = og.z + Math.cos(t * 0.22) * 1.4;

        if (ud.bell) {
          var pulse = Math.sin(t * 2.8);
          ud.bell.scale.y = 1.0 + pulse * 0.18;
          ud.bell.scale.x = 1.0 - pulse * 0.09;
          ud.bell.scale.z = 1.0 - pulse * 0.09;
        }

        for (var tIdx = 0; tIdx < g.children.length; tIdx++) {
          var ch = g.children[tIdx];
          if (tIdx > 0 && ch.isMesh && ch !== ud.bell) {
            ch.rotation.z = Math.sin(t * 1.8 + tIdx * 0.8) * 0.22;
          }
        }
      }

      /* ── 3. Clownfish School: Localized Flocking Orbit ── */
      else if (ud.species === 'clownfish') {
        g.position.x = og.x + Math.sin(t * 0.38) * 2.2;
        g.position.y = og.y + Math.sin(t * 0.75) * 0.35;
        g.position.z = og.z + Math.cos(t * 0.38) * 2.2;

        for (var cfi = 0; cfi < g.children.length; cfi++) {
          var sub = g.children[cfi];
          if (sub.userData && sub.userData.phase !== undefined) {
            var subT = t * 1.2 + sub.userData.phase;
            sub.position.x = Math.sin(subT) * 1.5 + Math.sin(subT * 2.0) * 0.4;
            sub.position.y = Math.cos(subT * 1.2) * 0.45;
            sub.position.z = Math.cos(subT) * 1.3;
            sub.rotation.y = -subT + Math.PI;
          }
        }
      }

      /* ── 4. Pelagic Manta Ray: Undulating Wingtips & Stately S-Curve ── */
      else if (ud.species === 'mantaray') {
        var mPrevX = g.position.x;
        var mPrevZ = g.position.z;

        g.position.x = og.x + Math.sin(t * 0.20) * 16.0;
        g.position.y = og.y + Math.sin(t * 0.40) *  1.6;
        g.position.z = og.z + Math.sin(t * 0.40) *  8.5;

        var mdx = g.position.x - mPrevX;
        var mdz = g.position.z - mPrevZ;
        if (Math.hypot(mdx, mdz) > 0.001) {
          var mTargetYaw = Math.atan2(mdx, mdz);
          var mDiffYaw   = mTargetYaw - g.rotation.y;
          while (mDiffYaw >  Math.PI) mDiffYaw -= Math.PI * 2;
          while (mDiffYaw < -Math.PI) mDiffYaw += Math.PI * 2;
          g.rotation.y += mDiffYaw * Math.min(delta * 1.6 * FAUNA_SPEED_SCALE, 1.0);
          g.rotation.z = -mdx * 0.08;
        }

        if (ud.wings) {
          for (var wi = 0; wi < ud.wings.length; wi++) {
            ud.wings[wi].rotation.z = (wi === 0 ? 1 : -1) * Math.sin(t * 1.3) * 0.32;
          }
        }
      }

      /* ── 5. Bioluminescent Moray Eel: Undulating Spine Slither ── */
      else if (ud.species === 'eel') {
        g.position.x = og.x + Math.sin(t * 0.24) * 1.8;
        g.position.y = og.y + Math.sin(t * 1.10) * 0.32;
        g.position.z = og.z + Math.sin(t * 0.48) * 4.2;

        var edx = Math.cos(t * 0.24) * 1.8 * 0.24;
        var edz = Math.cos(t * 0.48) * 4.2 * 0.48;
        g.rotation.y = Math.atan2(edx, edz);

        if (ud.segments) {
          for (var si = 0; si < ud.segments.length; si++) {
            var seg = ud.segments[si];
            seg.position.x = Math.sin(t * 1.8 + si * 0.85) * 0.42;
            seg.position.z = Math.cos(t * 1.4 + si * 0.60) * 0.14;

            var wave = (Math.sin(t * 2.8 + si * 0.9) + 1) * 0.5;
            var g_ch = Math.round(0x88 + wave * 0x77);
            var b_ch = Math.round(0xff - wave * 0x66);
            seg.material.emissive.setHex((g_ch << 8) | b_ch);
          }
        }
      }

      /* ── 6. Reef Octopus: Hovering Crevice Drift, Breathing & Curling Arms ── */
      else if (ud.species === 'octopus') {
        // Slow buoyant hovering above boulder crevice
        g.position.x = og.x + Math.sin(t * 0.35) * 0.8;
        g.position.y = og.y + Math.sin(t * 0.70) * 0.25;
        g.position.z = og.z + Math.cos(t * 0.35) * 0.8;

        // Mantle breathing / pulsing
        if (ud.mantle) {
          var breath = Math.sin(t * 1.5) * 0.08;
          ud.mantle.scale.set(0.9 + breath, 1.2 + breath * 1.2, 0.95 + breath);
        }

        // Tentacle curling & undulating waves
        if (ud.arms) {
          for (var ai = 0; ai < ud.arms.length; ai++) {
            var arm = ud.arms[ai];
            for (var ji = 0; ji < arm.length; ji++) {
              var joint = arm[ji];
              var wavePhase = t * 1.4 + ai * 0.75 + ji * 0.55;
              joint.rotation.z = Math.sin(wavePhase) * (0.18 + ji * 0.08);
              joint.rotation.x = Math.cos(wavePhase * 0.8) * 0.12;
            }
          }
        }
      }

      /* ── Patrol Shark: Circuit Navigation with Pacing ── */
      else if (ud.species === 'shark' || ud.isShark) {
        var wpCount = SHARK_WAYPOINTS.length;
        var cycleT  = (t * 0.075) % wpCount;
        if (cycleT < 0) cycleT += wpCount;
        var curIdx  = Math.floor(cycleT);
        var nextIdx = (curIdx + 1) % wpCount;
        var segFrac = cycleT - curIdx;

        var pCur  = SHARK_WAYPOINTS[curIdx];
        var pNext = SHARK_WAYPOINTS[nextIdx];

        g.position.lerpVectors(pCur, pNext, segFrac);
        g.position.y += Math.sin(t * 0.75) * 0.38;

        var dirX = pNext.x - pCur.x;
        var dirZ = pNext.z - pCur.z;
        var sharkTargetYaw = Math.atan2(-dirZ, dirX);
        var sDiffYaw       = sharkTargetYaw - g.rotation.y;
        while (sDiffYaw >  Math.PI) sDiffYaw -= Math.PI * 2;
        while (sDiffYaw < -Math.PI) sDiffYaw += Math.PI * 2;
        g.rotation.y += sDiffYaw * Math.min(delta * 2.0 * FAUNA_SPEED_SCALE, 1.0);
        g.rotation.z = Math.sin(t * 1.4) * 0.04;

        if (ud.tailFin) {
          ud.tailFin.rotation.y = Math.sin(t * 3.2) * 0.26;
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

    /* ── Pollution Gentle Seabed Current Drift ── */
    for (var pi = 0; pi < _pollution.length; pi++) {
      var pObj = _pollution[pi];
      if (!pObj.userData.collected) {
        pObj.rotation.y += delta * 0.28 * FAUNA_SPEED_SCALE;
        pObj.position.y  = pObj.userData.baseY + Math.sin(elapsedTime * 0.9 + pObj.position.x * 0.3) * 0.12;
      }
    }
  }

  /* ─── openWasteHatch / closeWasteHatch — Hatch Dwell Commit ───────────────── */
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

  /* ─── startO2Cooldown — Successful O2 Terminal Refill Dwell ──────────────── */
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

  /* ─── reset — Inter-session state clean ──────────────────────────────────── */
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

    _conduits.forEach(function (c) {
      c.userData.active = false;
      if (_interactables.indexOf(c) === -1) _interactables.push(c);
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

  /* ═══════════════════════════════════════════════════════════════════════════
     PUBLIC API — window.ABYSS.EntityManager
     ═══════════════════════════════════════════════════════════════════════════ */
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
    getFauna:         function () { return _fauna; },
    getConduits:      function () { return _conduits; }
  };

  // Legacy alias for backward compatibility
  window.EntityManager = window.ABYSS.EntityManager;

}());
