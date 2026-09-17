/* =============================================================================
   ABYSS: Marine Explorer — js/environment.js
   Static geometry: seabed, arches, coral, anemones, shipwreck, station, particles.
   Exposes window.EnvironmentBuilder.
   ============================================================================= */

(function () {
  'use strict';

  /* ─── Module state ─────────────────────────────────────────────────────────── */
  var _scene        = null;
  var _particles    = null;       // THREE.Points
  var _anemones     = [];         // THREE.Group[]
  var _interactable = null;       // station airlock mesh (returned to main.js)

  /* ─────────────────────────────────────────────────────────────────────────
     PROCEDURAL SAND TEXTURE  (512 × 512)
     Base: hsl(35,30%,28%) — noticeably brighter than v1 near-black.
     ───────────────────────────────────────────────────────────────────────── */
  function _makeSandTex() {
    var cv  = document.createElement('canvas');
    cv.width = 512; cv.height = 512;
    var c   = cv.getContext('2d');

    // Warm sandy base
    c.fillStyle = 'hsl(35, 30%, 28%)';
    c.fillRect(0, 0, 512, 512);

    // Speckle grains
    for (var i = 0; i < 5000; i++) {
      var lum = 30 + Math.random() * 22;
      c.fillStyle = 'hsl(35, 28%, ' + lum + '%)';
      c.beginPath();
      c.arc(Math.random() * 512, Math.random() * 512, Math.random() * 2 + 0.3, 0, Math.PI * 2);
      c.fill();
    }

    // Subtle ripple strokes
    for (var j = 0; j < 120; j++) {
      c.strokeStyle = 'rgba(180, 140, 80, ' + (Math.random() * 0.16) + ')';
      c.lineWidth   = Math.random() * 2.5;
      c.beginPath();
      var sx = Math.random() * 512, sy = Math.random() * 512;
      c.moveTo(sx, sy);
      c.quadraticCurveTo(
        sx + Math.random() * 40 - 20, sy + Math.random() * 20 - 10,
        sx + Math.random() * 60 - 30, sy + Math.random() * 40 - 20
      );
      c.stroke();
    }

    var tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SEABED PLANE  220 × 220 at Y = -8
     ───────────────────────────────────────────────────────────────────────── */
  function _buildSeabed() {
    var tex = _makeSandTex();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(9, 9);

    var bed = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 220, 4, 4),
      new THREE.MeshPhongMaterial({ map: tex, color: 0xffffff })
    );
    bed.rotation.x = -Math.PI / 2;
    bed.position.y = -8;
    _scene.add(bed);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     ROCKY BASALT ARCHES
     Rock colour: hsl(210, 15%, 22%) — dark steel-blue instead of near-black.
     ───────────────────────────────────────────────────────────────────────── */
  function _buildArch(x, y, z) {
    var mat = new THREE.MeshPhongMaterial({
      color: new THREE.Color('hsl(210, 15%, 22%)'),
      shininess: 4
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

  /* ─────────────────────────────────────────────────────────────────────────
     CORAL CLUSTERS — vivid HSL(hue, 70%, 55%)
     ───────────────────────────────────────────────────────────────────────── */
  function _buildCoral(x, y, z, hue) {
    var group = new THREE.Group();

    var stemMat = new THREE.MeshPhongMaterial({
      color:    new THREE.Color('hsl(' + hue + ', 70%, 55%)'),
      emissive: new THREE.Color('hsl(' + hue + ', 70%, 18%)'),
      emissiveIntensity: 0.5,
      shininess: 32
    });

    var count = 5 + Math.floor(Math.random() * 4);
    for (var i = 0; i < count; i++) {
      var h  = 1.5 + Math.random() * 2.5;
      var sx = (Math.random() - 0.5) * 2.5;
      var sz = (Math.random() - 0.5) * 2.5;

      var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.18, h, 6), stemMat);
      stem.position.set(sx, y + h / 2 + 8, sz);
      stem.rotation.z = (Math.random() - 0.5) * 0.5;
      stem.rotation.x = (Math.random() - 0.5) * 0.3;
      group.add(stem);

      var tipMat = new THREE.MeshPhongMaterial({
        color:    new THREE.Color('hsl(' + (hue + 22) + ', 70%, 68%)'),
        emissive: new THREE.Color('hsl(' + hue + ', 70%, 30%)'),
        emissiveIntensity: 0.75,
        shininess: 20
      });
      var tip = new THREE.Mesh(new THREE.SphereGeometry(0.22 + Math.random() * 0.18, 6, 4), tipMat);
      tip.position.set(sx, y + h + 8, sz);
      group.add(tip);
    }

    group.position.set(x, 0, z);
    _scene.add(group);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SEA ANEMONES — collected in array for oscillation update
     ───────────────────────────────────────────────────────────────────────── */
  function _buildAnemone(x, y, z) {
    var group = new THREE.Group();
    var mat   = new THREE.MeshPhongMaterial({
      color: 0x880020, emissive: 0x3a0010, emissiveIntensity: 0.5
    });

    for (var i = 0; i < 8; i++) {
      var angle = (i / 8) * Math.PI * 2;
      var t     = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.65 + Math.random() * 0.5, 4), mat);
      t.position.set(Math.cos(angle) * 0.14, 0.32, Math.sin(angle) * 0.14);
      t.rotation.z = Math.cos(angle) * 0.55;
      t.rotation.x = Math.sin(angle) * 0.55;
      group.add(t);
    }

    group.position.set(x, y, z);
    _scene.add(group);
    _anemones.push(group);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SUNKEN SHIPWRECK
     ───────────────────────────────────────────────────────────────────────── */
  function _buildShipwreck(x, y, z) {
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

    // Wreck glow
    var wl = new THREE.PointLight(0x00ff88, 0.65, 18);
    wl.position.set(x, y + 1, z);
    _scene.add(wl);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     UNDERWATER RESEARCH STATION
     Returns the airlock mesh (interactable for main.js)
     ───────────────────────────────────────────────────────────────────────── */
  function _buildStation(x, y, z) {
    var bodyMat = new THREE.MeshPhongMaterial({
      color: 0x1e3048, emissive: 0x081020, emissiveIntensity: 0.3
    });

    var body = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 8), bodyMat);
    body.position.set(x, y, z);
    _scene.add(body);

    // Interactable airlock cylinder
    var airlock = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.2, 3, 8),
      new THREE.MeshPhongMaterial({
        color: 0x445566, emissive: 0x002244, emissiveIntensity: 0.5
      })
    );
    airlock.position.set(x, y - 1.5, z + 4.5);
    airlock.rotation.x      = Math.PI / 2;
    airlock.userData.type   = 'station';
    airlock.userData.id     = 'station_airlock';
    _scene.add(airlock);
    _interactable = airlock;

    // Illuminated viewports — 4× PointLight(0x00aaff, 2.2, 10) per spec
    var vpPos = [[-3, 0.5, 4.1],[3, 0.5, 4.1],[-3, -1.5, 4.1],[3, -1.5, 4.1]];
    vpPos.forEach(function (p) {
      var vpMat = new THREE.MeshPhongMaterial({
        color: 0x00aaff, emissive: 0x0044aa,
        emissiveIntensity: 0.85,
        transparent: true, opacity: 0.85
      });
      var vp = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 0.05), vpMat);
      vp.position.set(x + p[0], y + p[1], z + p[2]);
      _scene.add(vp);

      var pl = new THREE.PointLight(0x00aaff, 2.2, 10);
      pl.position.set(x + p[0], y + p[1], z + p[2] + 0.3);
      _scene.add(pl);
    });

    // Support legs
    var legMat = new THREE.MeshPhongMaterial({ color: 0x2a3d50 });
    [[x - 3, z - 3],[x + 3, z - 3],[x - 3, z + 3],[x + 3, z + 3]].forEach(function (lp) {
      var legH = Math.abs(y) + 2;
      var leg  = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, legH, 6), legMat);
      leg.position.set(lp[0], y - legH / 2, lp[1]);
      _scene.add(leg);
    });

    return airlock;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PLANKTON PARTICLES — 160 upward-drifting points
     ───────────────────────────────────────────────────────────────────────── */
  function _buildParticles() {
    var COUNT = 160;
    var geo   = new THREE.BufferGeometry();
    var pos   = new Float32Array(COUNT * 3);
    var vel   = new Float32Array(COUNT);

    for (var i = 0; i < COUNT; i++) {
      pos[i * 3]     = (Math.random() - 0.5) * 90;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 26;
      pos[i * 3 + 2] = -Math.random() * 68;
      vel[i]         = 0.018 + Math.random() * 0.042;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    var mat = new THREE.PointsMaterial({
      color: 0x88ccff, size: 0.12,
      transparent: true, opacity: 0.65,
      sizeAttenuation: true
    });

    _particles = new THREE.Points(geo, mat);
    _particles.userData.vel = vel;
    _scene.add(_particles);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     build — main entry point, assembles scene, returns station airlock
     ───────────────────────────────────────────────────────────────────────── */
  function build(scene) {
    _scene       = scene;
    _anemones    = [];
    _particles   = null;
    _interactable = null;

    // ── Fog & background (v2 teal-navy) ──
    scene.fog        = new THREE.FogExp2(0x041b33, 0.022);
    scene.background = new THREE.Color(0x041b33);

    // ── Lighting ──
    scene.add(new THREE.AmbientLight(0x14325c, 1.4));

    var sun = new THREE.DirectionalLight(0x5599cc, 0.9);
    sun.position.set(5, 30, -10);
    scene.add(sun);

    // Coral accent lights
    var ca1 = new THREE.PointLight(0x00ffaa, 1.2, 18);
    ca1.position.set(-8, -4, -18);
    scene.add(ca1);

    var ca2 = new THREE.PointLight(0xff6688, 1.0, 14);
    ca2.position.set(15, -4, -22);
    scene.add(ca2);

    // ── Geometry ──
    _buildSeabed();

    _buildArch(0,   0, -20);
    _buildArch(18, -1, -38);

    _buildCoral(-8,  -7, -18,   0);
    _buildCoral( 7,  -7, -15, 340);
    _buildCoral(15,  -7, -22,  22);
    _buildCoral(-16, -7, -26, 280);
    _buildCoral(  2, -7, -32, 350);
    _buildCoral( -4, -7, -11,  30);

    var anPos = [[-6,-7.5,-13],[10,-7.5,-19],[-14,-7.5,-22],[4,-7.5,-28],[-2,-7.5,-17]];
    anPos.forEach(function (p) { _buildAnemone(p[0], p[1], p[2]); });

    _buildShipwreck(-22, -5, -48);
    _buildStation(0, -4, -58);
    _buildParticles();

    return _interactable; // station airlock
  }

  /* ─────────────────────────────────────────────────────────────────────────
     update — particle drift + anemone sway, called every frame
     ───────────────────────────────────────────────────────────────────────── */
  function update(t) {
    // Particle drift — wrap-around at Y +20
    if (_particles) {
      var pos = _particles.geometry.attributes.position.array;
      var vel = _particles.userData.vel;
      for (var i = 0; i < 160; i++) {
        pos[i * 3 + 1] += vel[i];
        if (pos[i * 3 + 1] > 20) pos[i * 3 + 1] = -16;
      }
      _particles.geometry.attributes.position.needsUpdate = true;
    }

    // Anemone tentacle sway
    for (var j = 0; j < _anemones.length; j++) {
      var an = _anemones[j];
      an.rotation.z = Math.sin(t * 1.1 + an.position.x * 0.5) * 0.09;
      an.rotation.x = Math.cos(t * 0.85 + an.position.z * 0.4) * 0.07;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     reset — called between sessions
     ───────────────────────────────────────────────────────────────────────── */
  function reset() {
    _scene       = null;
    _particles   = null;
    _anemones    = [];
    _interactable = null;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
     ───────────────────────────────────────────────────────────────────────── */
  window.EnvironmentBuilder = {
    build:  build,
    update: update,
    reset:  reset
  };

}());
