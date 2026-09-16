// =============================================================================
// ABYSS: Marine Explorer — environment.js
// Static geometry: seabed, coral, arches, shipwreck, station, particles.
// Exposed on window.ABYSS.Environment.
// =============================================================================

window.ABYSS = window.ABYSS || {};

window.ABYSS.Environment = (function () {
  'use strict';

  var _scene = null;
  var _particleSystem = null;
  var _anemones = [];

  // Shared interactables list — populated by build(), read by main.js
  var _interactables = [];
  var _pollutionObjs = [];
  var _stationAirlockMesh = null;

  // =============================================================================
  // TEXTURE GENERATORS
  // =============================================================================

  function makeSandTexture() {
    var c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    var ctx = c.getContext('2d');

    // Brighter sandy base (v2: hsl(35,30%,28%) instead of near-black)
    ctx.fillStyle = 'hsl(35, 30%, 28%)';
    ctx.fillRect(0, 0, 512, 512);

    // Sand grain speckles
    for (var i = 0; i < 5000; i++) {
      var x = Math.random() * 512;
      var y = Math.random() * 512;
      var r = Math.random() * 2 + 0.3;
      var lum = Math.floor(30 + Math.random() * 22);
      ctx.fillStyle = 'hsl(35, 28%, ' + lum + '%)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Ripple lines
    for (var j = 0; j < 120; j++) {
      ctx.strokeStyle = 'rgba(180,140,80,' + (Math.random() * 0.18) + ')';
      ctx.lineWidth = Math.random() * 2.5;
      ctx.beginPath();
      var sx = Math.random() * 512, sy = Math.random() * 512;
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(
        sx + Math.random() * 40 - 20, sy + Math.random() * 20 - 10,
        sx + Math.random() * 60 - 30, sy + Math.random() * 40 - 20
      );
      ctx.stroke();
    }

    return new THREE.CanvasTexture(c);
  }

  // =============================================================================
  // ARCH
  // =============================================================================

  function buildArch(x, y, z) {
    // v2: hsl(210, 15%, 22%) — dark steel-blue rock
    var mat = new THREE.MeshPhongMaterial({
      color: new THREE.Color('hsl(210, 15%, 22%)'),
      shininess: 5
    });

    var p1 = new THREE.Mesh(new THREE.BoxGeometry(1.5, 8, 1.5), mat);
    p1.position.set(x - 3, y, z);
    _scene.add(p1);

    var p2 = new THREE.Mesh(new THREE.BoxGeometry(1.5, 8, 1.5), mat);
    p2.position.set(x + 3, y, z);
    _scene.add(p2);

    var lintel = new THREE.Mesh(new THREE.BoxGeometry(9, 1.8, 2), mat);
    lintel.position.set(x, y + 4.9, z);
    _scene.add(lintel);
  }

  // =============================================================================
  // CORAL CLUSTER
  // =============================================================================

  function buildCoralCluster(x, y, z, hue, sat, lig) {
    var group = new THREE.Group();

    // v2: vivid coral — hsl(hue, 70%, 55%)
    var vivLig = 55;
    var stemMat = new THREE.MeshPhongMaterial({
      color: new THREE.Color('hsl(' + hue + ', 70%, ' + vivLig + '%)'),
      emissive: new THREE.Color('hsl(' + hue + ', 70%, ' + Math.floor(vivLig * 0.3) + '%)'),
      emissiveIntensity: 0.45,
      shininess: 35
    });

    var count = 5 + Math.floor(Math.random() * 4);
    for (var i = 0; i < count; i++) {
      var h = 1.5 + Math.random() * 2.5;
      var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.18, h, 6), stemMat);
      var sx = (Math.random() - 0.5) * 2.5;
      var sz = (Math.random() - 0.5) * 2.5;
      stem.position.set(sx, y + h / 2 + 8, sz);
      stem.rotation.z = (Math.random() - 0.5) * 0.5;
      stem.rotation.x = (Math.random() - 0.5) * 0.3;
      group.add(stem);

      var tipMat = new THREE.MeshPhongMaterial({
        color: new THREE.Color('hsl(' + (hue + 20) + ', 70%, ' + (vivLig + 15) + '%)'),
        emissive: new THREE.Color('hsl(' + hue + ', 70%, ' + Math.floor(vivLig * 0.5) + '%)'),
        emissiveIntensity: 0.75
      });
      var tip = new THREE.Mesh(new THREE.SphereGeometry(0.22 + Math.random() * 0.18, 6, 4), tipMat);
      tip.position.set(sx, y + h + 8, sz);
      group.add(tip);
    }

    group.position.set(x, 0, z);
    _scene.add(group);
  }

  // =============================================================================
  // ANEMONE
  // =============================================================================

  function buildAnemone(x, y, z) {
    var group = new THREE.Group();
    var mat = new THREE.MeshPhongMaterial({
      color: 0x880020,
      emissive: 0x3a0010,
      emissiveIntensity: 0.4
    });

    for (var i = 0; i < 8; i++) {
      var angle = (i / 8) * Math.PI * 2;
      var t = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.7 + Math.random() * 0.5, 4), mat);
      t.position.set(Math.cos(angle) * 0.14, 0.35, Math.sin(angle) * 0.14);
      t.rotation.z = Math.cos(angle) * 0.55;
      t.rotation.x = Math.sin(angle) * 0.55;
      group.add(t);
    }

    group.position.set(x, y, z);
    group.userData.isAnemone = true;
    _scene.add(group);
    _anemones.push(group);
  }

  // =============================================================================
  // SHIPWRECK
  // =============================================================================

  function buildShipwreck(x, y, z) {
    var mat = new THREE.MeshPhongMaterial({ color: 0x252525, shininess: 8 });

    var hull = new THREE.Mesh(new THREE.BoxGeometry(12, 3, 4), mat);
    hull.position.set(x, y, z);
    hull.rotation.z = 0.27;
    _scene.add(hull);

    var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 9, 6), mat);
    mast.position.set(x + 2, y + 5.5, z);
    mast.rotation.z = 0.27;
    _scene.add(mast);

    var cabin = new THREE.Mesh(
      new THREE.BoxGeometry(4, 2, 3.5),
      new THREE.MeshPhongMaterial({ color: 0x1a1a1a })
    );
    cabin.position.set(x - 1.5, y + 2.5, z);
    cabin.rotation.z = 0.27;
    _scene.add(cabin);

    // Algae accent light near wreck
    var wreckGlow = new THREE.PointLight(0x00ff88, 0.7, 20);
    wreckGlow.position.set(x, y + 2, z);
    _scene.add(wreckGlow);
  }

  // =============================================================================
  // RESEARCH STATION
  // =============================================================================

  function buildResearchStation(x, y, z) {
    var bodyMat = new THREE.MeshPhongMaterial({
      color: 0x1e3048,
      emissive: 0x081020,
      emissiveIntensity: 0.3
    });

    var body = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 8), bodyMat);
    body.position.set(x, y, z);
    _scene.add(body);

    // Airlock — interactable
    _stationAirlockMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.2, 3, 8),
      new THREE.MeshPhongMaterial({
        color: 0x445566,
        emissive: 0x002244,
        emissiveIntensity: 0.5
      })
    );
    _stationAirlockMesh.position.set(x, y - 1.5, z + 4.5);
    _stationAirlockMesh.rotation.x = Math.PI / 2;
    _stationAirlockMesh.userData.type = 'station';
    _stationAirlockMesh.userData.id = 'station_airlock';
    _scene.add(_stationAirlockMesh);
    _interactables.push(_stationAirlockMesh);

    // Viewports — v2: 4× PointLight(0x00aaff, 2.2, 10) per spec
    var vpPos = [
      [-3, 0.5, 4.1],
      [ 3, 0.5, 4.1],
      [-3, -1.5, 4.1],
      [ 3, -1.5, 4.1]
    ];
    vpPos.forEach(function (p) {
      var vpMat = new THREE.MeshPhongMaterial({
        color: 0x00aaff,
        emissive: 0x0044aa,
        emissiveIntensity: 0.8,
        transparent: true,
        opacity: 0.85
      });
      var vp = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 0.05), vpMat);
      vp.position.set(x + p[0], y + p[1], z + p[2]);
      _scene.add(vp);

      // v2 spec: 2.2 intensity, range 10
      var pl = new THREE.PointLight(0x00aaff, 2.2, 10);
      pl.position.set(x + p[0], y + p[1], z + p[2] + 0.3);
      _scene.add(pl);
    });

    // Station legs
    var legMat = new THREE.MeshPhongMaterial({ color: 0x2a3d50 });
    [
      [x - 3, z - 3],
      [x + 3, z - 3],
      [x - 3, z + 3],
      [x + 3, z + 3]
    ].forEach(function (lp) {
      var legH = Math.abs(y) + 2;
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, legH, 6), legMat);
      leg.position.set(lp[0], y - legH / 2, lp[1]);
      _scene.add(leg);
    });
  }

  // =============================================================================
  // PARTICLES (marine snow / plankton drift)
  // =============================================================================

  function buildParticles() {
    var count = 150;
    var geo = new THREE.BufferGeometry();
    var positions = new Float32Array(count * 3);
    var velocities = new Float32Array(count);

    for (var i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 80;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 25;
      positions[i * 3 + 2] = -Math.random() * 65;
      velocities[i] = 0.02 + Math.random() * 0.04;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var mat = new THREE.PointsMaterial({
      color: 0x88ccff,
      size: 0.12,
      transparent: true,
      opacity: 0.65,
      sizeAttenuation: true
    });

    _particleSystem = new THREE.Points(geo, mat);
    _particleSystem.userData.velocities = velocities;
    _scene.add(_particleSystem);
  }

  // =============================================================================
  // POLLUTION OBJECTS
  // =============================================================================

  function buildPollution() {
    var bagMat1 = new THREE.MeshPhongMaterial({
      color: 0xdde8ff,
      transparent: true,
      opacity: 0.52,
      shininess: 90,
      side: THREE.DoubleSide
    });
    var bagMat2 = new THREE.MeshPhongMaterial({
      color: 0xfff8f0,
      transparent: true,
      opacity: 0.48,
      shininess: 80,
      side: THREE.DoubleSide
    });
    var barrelMat1 = new THREE.MeshPhongMaterial({
      color: 0xbb3300,
      shininess: 18,
      emissive: 0x220800,
      emissiveIntensity: 0.3
    });
    var barrelMat2 = new THREE.MeshPhongMaterial({
      color: 0x7a4422,
      shininess: 12,
      emissive: 0x100500,
      emissiveIntensity: 0.2
    });

    var defs = [
      { geo: new THREE.PlaneGeometry(0.8, 1.0, 2, 2), mat: bagMat1,    pos: [-5, -6.5, -16], rot: [0.3, 0.5, 0.1] },
      { geo: new THREE.PlaneGeometry(0.8, 1.0, 2, 2), mat: bagMat2,    pos: [ 9, -6.2, -21], rot: [0.1, 1.2, 0.2] },
      { geo: new THREE.CylinderGeometry(0.4, 0.4, 1.0, 8), mat: barrelMat1, pos: [5, -7.2, -23], rot: [0.1, 0.2, 0.05] },
      { geo: new THREE.CylinderGeometry(0.4, 0.4, 1.0, 8), mat: barrelMat2, pos: [-13, -7.2, -29], rot: [0, 0.8, 0.08] }
    ];

    defs.forEach(function (d, i) {
      var mesh = new THREE.Mesh(d.geo, d.mat);
      mesh.position.set(d.pos[0], d.pos[1], d.pos[2]);
      mesh.rotation.set(d.rot[0], d.rot[1], d.rot[2]);
      mesh.userData.type = 'pollution';
      mesh.userData.id = 'pollution_' + i;
      mesh.userData.collected = false;
      mesh.userData.baseY = d.pos[1];
      _pollutionObjs.push(mesh);
      _interactables.push(mesh);
      _scene.add(mesh);
    });
  }

  // =============================================================================
  // BUILD — main entry point, assembles the full scene
  // =============================================================================

  function build(scene) {
    _scene = scene;
    _interactables = [];
    _pollutionObjs = [];
    _stationAirlockMesh = null;
    _anemones = [];
    _particleSystem = null;

    // --- Scene settings (v2 visibility upgrades) ---
    scene.fog = new THREE.FogExp2(0x041b33, 0.022);
    scene.background = new THREE.Color(0x041b33);

    // --- Lighting ---
    // v2: brighter ambient + richer hue
    var ambient = new THREE.AmbientLight(0x14325c, 1.4);
    scene.add(ambient);

    // v2: sun column — filtered caustic light from above
    var sun = new THREE.DirectionalLight(0x5599cc, 0.9);
    sun.position.set(5, 30, -10);
    scene.add(sun);

    // v2: coral accent point lights (near 2 coral clusters)
    var coralGlow1 = new THREE.PointLight(0x00ffaa, 1.2, 18);
    coralGlow1.position.set(-8, -4, -18);
    scene.add(coralGlow1);

    var coralGlow2 = new THREE.PointLight(0xff6688, 1.0, 14);
    coralGlow2.position.set(15, -4, -22);
    scene.add(coralGlow2);

    // --- Seabed ---
    var sandTex = makeSandTexture();
    sandTex.wrapS = sandTex.wrapT = THREE.RepeatWrapping;
    sandTex.repeat.set(8, 8);

    var bed = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200, 4, 4),
      new THREE.MeshPhongMaterial({ map: sandTex, color: 0xffffff })
    );
    bed.rotation.x = -Math.PI / 2;
    bed.position.y = -8;
    scene.add(bed);

    // --- Rocky arches ---
    buildArch(0, 0, -20);
    buildArch(18, -1, -38);

    // --- Coral clusters ---
    buildCoralCluster(-8,  -7, -18,   0, 70, 50);
    buildCoralCluster( 7,  -7, -15, 340, 70, 50);
    buildCoralCluster(15,  -7, -22,  20, 70, 50);
    buildCoralCluster(-16, -7, -26, 280, 70, 50);
    buildCoralCluster(  2, -7, -32, 350, 70, 50);
    buildCoralCluster( -4, -7, -11,  30, 70, 50);

    // --- Sea anemones ---
    var anPos = [
      [-6, -7.5, -13],
      [10, -7.5, -19],
      [-14, -7.5, -22],
      [4,  -7.5, -28],
      [-2, -7.5, -17]
    ];
    anPos.forEach(function (p) { buildAnemone(p[0], p[1], p[2]); });

    // --- Shipwreck ---
    buildShipwreck(-22, -5, -48);

    // --- Research station ---
    buildResearchStation(0, -4, -58);

    // --- Marine snow particles ---
    buildParticles();

    // --- Pollution objects ---
    buildPollution();

    return {
      interactables:       _interactables,
      pollutionObjs:       _pollutionObjs,
      stationAirlockMesh:  _stationAirlockMesh
    };
  }

  // =============================================================================
  // UPDATE — called each frame
  // =============================================================================

  function update(elapsedTime) {
    var t = elapsedTime;

    // Particle drift (marine snow rising)
    if (_particleSystem) {
      var pos  = _particleSystem.geometry.attributes.position.array;
      var vels = _particleSystem.userData.velocities;
      for (var i = 0; i < 150; i++) {
        pos[i * 3 + 1] += vels[i];
        if (pos[i * 3 + 1] > 20) pos[i * 3 + 1] = -15;
      }
      _particleSystem.geometry.attributes.position.needsUpdate = true;
    }

    // Anemone sway
    for (var j = 0; j < _anemones.length; j++) {
      var obj = _anemones[j];
      obj.rotation.z = Math.sin(t * 1.1 + obj.position.x * 0.5) * 0.09;
      obj.rotation.x = Math.cos(t * 0.85 + obj.position.z * 0.4) * 0.07;
    }

    // Pollution bob
    for (var k = 0; k < _pollutionObjs.length; k++) {
      var pobj = _pollutionObjs[k];
      if (!pobj.userData.collected) {
        pobj.rotation.y += 0.006;
        pobj.position.y = pobj.userData.baseY + Math.sin(t * 1.15 + pobj.position.x * 0.4) * 0.16;
      }
    }
  }

  // =============================================================================
  // Public API
  // =============================================================================

  return {
    build:  build,
    update: update
  };

}());
