/* =============================================================================
   ABYSS: Marine Explorer — js/environment.js  v4
   MODULE 3: Organic procedural seabed (vertex-displaced 200×200 plane),
   450-particle marine snow (AdditiveBlending, depthWrite:false),
   4-pass canvas caustic UV drift, GPU kelp ShaderMaterial sway,
   bioluminescent fog 0x041a2e / 0.018.

   ZERO SHADER RECOMPILATION RULE:
   - Caustics animate via emissiveMap.offset (standard UV drift) — no GPU rebuild.
   - Kelp sway: uTime uniform drives GLSL vertex shader entirely on GPU.
   - emissiveIntensity never mutated post material construction.
   - Marine snow: PointsMaterial with AdditiveBlending / depthWrite:false.
     Y-drift handled CPU-side (no ShaderMaterial needed after size cap to 450).
   - Seabed vertex displacement: applied ONCE at build time via BufferAttribute
     write, then geometry.computeVertexNormals(). Never re-displaced at runtime.
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  /* ─── Module state ──────────────────────────────────────────────────────────── */
  var _scene = null;
  var _particles = null;      // THREE.Points — marine snow (450 cap)
  var _bubbles   = null;      // THREE.Points — rising bubble system (200 cap)
  var _anemones = [];        // THREE.Group[] for tentacle sway
  var _kelpMaterials = [];        // ShaderMaterial[] needing uTime uniform update
  var _causticMat = null;      // MeshStandardMaterial on seabed
  var _causticReefMat = null;      // MeshStandardMaterial on secondary reef geo
  var _interactable = null;      // station airlock mesh (returned to main.js)
  var _conduitMesh = null;      // power conduit terminal mesh (returned)

  /* ─────────────────────────────────────────────────────────────────────────
     PROCEDURAL SAND TEXTURE  (512 × 512, canvas 2D)
     Warm base + 5000 speckle grains + 120 ripple stroke passes.
  ───────────────────────────────────────────────────────────────────────── */
  function _makeSandTex() {
    var cv = document.createElement('canvas');
    cv.width = 512; cv.height = 512;
    var c = cv.getContext('2d');

    // Abyssal silt base — dark blue-grey, suits deep-sea depth
    c.fillStyle = 'hsl(220, 20%, 12%)';
    c.fillRect(0, 0, 512, 512);

    // Fine sediment speckles — varied dark luminance for micro-relief texture
    for (var i = 0; i < 6000; i++) {
      var lum = 10 + Math.random() * 16;
      c.fillStyle = 'hsl(215, 18%, ' + lum + '%)';
      c.beginPath();
      c.arc(Math.random() * 512, Math.random() * 512, Math.random() * 1.8 + 0.2, 0, Math.PI * 2);
      c.fill();
    }

    // Subtle current ripple strokes — cooler grey-blue tones
    for (var j = 0; j < 150; j++) {
      c.strokeStyle = 'rgba(80, 110, 150, ' + (Math.random() * 0.14) + ')';
      c.lineWidth = Math.random() * 2.2;
      c.beginPath();
      var sx = Math.random() * 512, sy = Math.random() * 512;
      c.moveTo(sx, sy);
      c.quadraticCurveTo(
        sx + Math.random() * 44 - 22, sy + Math.random() * 22 - 11,
        sx + Math.random() * 65 - 32, sy + Math.random() * 42 - 21
      );
      c.stroke();
    }

    var tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }


  /* ─────────────────────────────────────────────────────────────────────────
     PROCEDURAL CAUSTIC TEXTURE  (512 × 512, offscreen canvas 2D)
     4 sine-wave interference passes at varied frequency / amplitude / phase.
     Baked ONCE at startup. Animated at runtime via emissiveMap.offset UV drift
     — standard canvas 2D approach, zero shader recompilation.
  ───────────────────────────────────────────────────────────────────────── */
  function _makeCausticTex() {
    var cv = document.createElement('canvas');
    cv.width = 512; cv.height = 512;
    var c = cv.getContext('2d');

    c.fillStyle = 'rgba(0,0,0,1)';
    c.fillRect(0, 0, 512, 512);

    var passes = [
      { freqX: 0.042, freqY: 0.038, amp: 0.50, phase: 0.0 },
      { freqX: 0.031, freqY: 0.055, amp: 0.40, phase: 1.2 },
      { freqX: 0.068, freqY: 0.024, amp: 0.30, phase: 2.5 },
      { freqX: 0.022, freqY: 0.071, amp: 0.24, phase: 4.1 }
    ];

    passes.forEach(function (p) {
      var imgData = c.getImageData(0, 0, 512, 512);
      var px = imgData.data;
      for (var py = 0; py < 512; py++) {
        for (var px2 = 0; px2 < 512; px2++) {
          var wave = Math.sin(px2 * p.freqX + p.phase) * Math.sin(py * p.freqY + p.phase * 1.3);
          wave = (wave + 1) * 0.5;
          if (wave > 0.52) {
            var alpha = wave * p.amp * 255;
            var idx = (py * 512 + px2) * 4;
            px[idx] = Math.min(255, px[idx] + alpha * 0.25);
            px[idx + 1] = Math.min(255, px[idx + 1] + alpha * 0.88);
            px[idx + 2] = Math.min(255, px[idx + 2] + alpha);
            px[idx + 3] = 255;
          }
        }
      }
      c.putImageData(imgData, 0, 0);
    });

    // Soft blur pass for organic feathered edges
    c.filter = 'blur(3px)';
    c.drawImage(cv, 0, 0);
    c.filter = 'none';

    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    tex.needsUpdate = true;
    return tex;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PHOTOREALISTIC SEABED — 200×200 PlaneGeometry, 120×120 segments.
     (121×121 = 14,641 vertices — displaced ONCE at build time, no per-frame cost)

     Five displacement layers for abyssal topography:
       Layer A: Macro shelf rolls       (very low  freq, highest amp  ≈ ±2.4 u)
       Layer B: Rocky ridge crests      (low-mid   freq, mid    amp  ≈ ±1.1 u)
       Layer C: Sand ripple detail      (mid-high  freq, small  amp  ≈ ±0.4 u)
       Layer D: Per-vertex micro-noise  (deterministic hash     ≈ ±0.14 u)
       Layer E: Deep trench macro slope (very low  freq, large  amp  ≈ ±3.2 u)
                ↳ Adds abyssal troughs and elevated plateaus to the playfield.

     Vertex colour shading — hollow vs crest:
       After computing the total displacement each vertex is assigned an RGB
       colour via smoothstep:  dark blue silt (hollows)  →  lighter grey-blue
       (crests). Material uses vertexColors:true so the per-vertex colour
       multiplies the sandTex map for combined micro-detail + macro shading.
       Zero extra draw call. Zero shader recompilation.

     After displacement: computeVertexNormals() for physically correct shading.
  ───────────────────────────────────────────────────────────────────────── */
  // ── Terrain height helper for clamping ──
  function getElevation(worldX, worldZ) {
    // Plane is rotated -90 deg on X.
    // So Plane Y = -World Z. Plane Z = World Y - (-8)
    var wx = worldX;
    var wy = -worldZ;
    var dA = Math.sin(wx * 0.045 + 0.7) * Math.cos(wy * 0.038 + 1.1) * 2.4;
    var dB = Math.sin(wx * 0.095 + wy * 0.078 + 2.4) * 1.1;
    var dC = Math.cos(wx * 0.22 - wy * 0.19 + 3.7) * 0.4;
    var seed = Math.sin(wx * 127.1 + wy * 311.7) * 43758.5453;
    var dD   = (seed - Math.floor(seed) - 0.5) * 0.28;
    var dE = Math.sin(wx * 0.018 + 1.9) * Math.cos(wy * 0.014 + 0.6) * 3.2;
    return -8 + (dA + dB + dC + dD + dE);
  }

  function _buildSeabed() {
    var sandTex = _makeSandTex();
    sandTex.wrapS = sandTex.wrapT = THREE.RepeatWrapping;
    sandTex.repeat.set(14, 14);

    var causticTex = _makeCausticTex();
    var geo = new THREE.PlaneGeometry(200, 200, 120, 120);
    var positions = geo.attributes.position;
    var vertCount = positions.count;
    var colors    = new Float32Array(vertCount * 3);

    for (var vi = 0; vi < vertCount; vi++) {
      var wx = positions.getX(vi);
      var wy = positions.getY(vi);
      
      // We can use the math directly inline here for speed instead of calling function.
      var dA = Math.sin(wx * 0.045 + 0.7) * Math.cos(wy * 0.038 + 1.1) * 2.4;
      var dB = Math.sin(wx * 0.095 + wy * 0.078 + 2.4) * 1.1;
      var dC = Math.cos(wx * 0.22 - wy * 0.19 + 3.7) * 0.4;
      var seed = Math.sin(wx * 127.1 + wy * 311.7) * 43758.5453;
      var dD   = (seed - Math.floor(seed) - 0.5) * 0.28;
      var dE = Math.sin(wx * 0.018 + 1.9) * Math.cos(wy * 0.014 + 0.6) * 3.2;
      var disp = dA + dB + dC + dD + dE;

      positions.setZ(vi, disp);

      var t = Math.max(0, Math.min(1, (disp + 7) / 14));
      t = t * t * (3 - 2 * t);
      colors[vi * 3]     = 0.07 + t * 0.13;
      colors[vi * 3 + 1] = 0.10 + t * 0.12;
      colors[vi * 3 + 2] = 0.15 + t * 0.12;
    }

    positions.needsUpdate = true;
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    _causticMat = new THREE.MeshStandardMaterial({
      map:          sandTex,
      vertexColors: true,
      emissiveMap:  causticTex,
      emissive:     new THREE.Color(0x001220),
      roughness:    0.94,
      metalness:    0.0
    });

    var bed = new THREE.Mesh(geo, _causticMat);
    bed.rotation.x    = -Math.PI / 2;
    bed.position.y    = -8;
    bed.receiveShadow = false;
    _scene.add(bed);
  }


  /* ─────────────────────────────────────────────────────────────────────────
     KELP STALK — GPU sinusoidal current sway via GLSL vertex shader.
     uTime uniform is updated each frame (uniform update ≠ shader recompile).
     Fresnel rim highlight computed in fragment shader.
  ───────────────────────────────────────────────────────────────────────── */
  var KELP_VERT = [
    'uniform float uTime;',
    'uniform float uStalkIndex;',
    'varying vec3 vNormal;',
    'varying vec3 vViewDir;',
    '',
    'void main() {',
    '  vec3 pos = position;',
    '  // Primary sway — varies frequency per stalk via uStalkIndex',
    '  float sway  = sin(uTime * 2.0 + pos.y * 0.5 + uStalkIndex * 1.37) * 0.18 * (pos.y / 4.0);',
    '  float swayZ = cos(uTime * 1.6 + pos.y * 0.4 + uStalkIndex * 0.85) * 0.10 * (pos.y / 4.0);',
    '  pos.x += sway;',
    '  pos.z += swayZ;',
    '  vNormal  = normalize(normalMatrix * normal);',
    '  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);',
    '  vViewDir   = -normalize(mvPos.xyz);',
    '  gl_Position = projectionMatrix * mvPos;',
    '}'
  ].join('\n');

  var KELP_FRAG = [
    'uniform vec3 uColor;',
    'uniform vec3 uEmissive;',
    'varying vec3 vNormal;',
    'varying vec3 vViewDir;',
    '',
    'void main() {',
    '  float diff    = max(dot(vNormal, normalize(vec3(0.3, 1.0, 0.5))), 0.0);',
    '  // Fresnel rim highlight at grazing angles',
    '  float fresnel = 1.0 - max(dot(vNormal, vViewDir), 0.0);',
    '  fresnel = pow(fresnel, 2.8);',
    '  vec3 col = uColor * (0.25 + diff * 0.75);',
    '  col += uEmissive * (0.55 + fresnel * 1.45);',
    '  gl_FragColor  = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function _buildKelp(x, z, hue, stalkIndex, y) {
    var group = new THREE.Group();
    group.position.set(x, y !== undefined ? y : -8, z);

    var count = 4 + Math.floor(Math.random() * 3);
    for (var i = 0; i < count; i++) {
      var height = 3.5 + Math.random() * 3.2;
      var ox = (Math.random() - 0.5) * 0.6;
      var oz = (Math.random() - 0.5) * 0.6;

      var curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(ox, 0, oz),
        new THREE.Vector3(ox + (Math.random() - 0.5) * 0.5, height * 0.33, 0),
        new THREE.Vector3(ox + (Math.random() - 0.5) * 0.8, height * 0.66, 0),
        new THREE.Vector3(ox + (Math.random() - 0.5) * 0.5, height, 0)
      ]);

      var geo = new THREE.TubeGeometry(curve, 12, 0.055, 5, false);
      var kelpColor = new THREE.Color('hsl(' + hue + ', 75%, 31%)');
      var kelpEmissive = new THREE.Color('hsl(' + ((hue + 140) % 360) + ', 80%, 24%)');

      var mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0.0 },
          uStalkIndex: { value: stalkIndex + i * 0.31 },
          uColor: { value: kelpColor },
          uEmissive: { value: kelpEmissive }
        },
        vertexShader: KELP_VERT,
        fragmentShader: KELP_FRAG,
        side: THREE.DoubleSide
      });

      group.add(new THREE.Mesh(geo, mat));
      _kelpMaterials.push(mat);
    }

    _scene.add(group);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     ROCKY BASALT ARCHES
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
     SEA ANEMONES  (Phong, collected in _anemones[] for sway in update)
  ───────────────────────────────────────────────────────────────────────── */
  function _buildAnemone(x, y, z) {
    var group = new THREE.Group();
    var mat = new THREE.MeshPhongMaterial({
      color: 0x880020, emissive: 0x3a0010, emissiveIntensity: 0.5
    });

    for (var i = 0; i < 8; i++) {
      var angle = (i / 8) * Math.PI * 2;
      var t = new THREE.Mesh(
        new THREE.ConeGeometry(0.06, 0.65 + Math.random() * 0.5, 4),
        mat
      );
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

    var wl = new THREE.PointLight(0x00ff88, 0.65, 18);
    wl.position.set(x, y + 1, z);
    _scene.add(wl);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     UNDERWATER RESEARCH STATION
     Returns { airlock, conduit } — both forwarded to main.js for interactables.
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
    airlock.rotation.x = Math.PI / 2;
    airlock.userData.type = 'station';
    airlock.userData.id = 'station_airlock';
    _scene.add(airlock);

    // Illuminated viewports — 4 panels with PointLights
    var vpPositions = [
      [-3, 0.5, 4.1],
      [3, 0.5, 4.1],
      [-3, -1.5, 4.1],
      [3, -1.5, 4.1]
    ];
    vpPositions.forEach(function (p) {
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

    // Power Conduit Terminal — near base, slightly lateral
    var conduitMat = new THREE.MeshPhongMaterial({
      color: 0x334455, emissive: 0x002233, emissiveIntensity: 0.5, shininess: 60
    });
    var conduit = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.8, 0.6), conduitMat);
    conduit.position.set(x + 6, y - 1, z);
    conduit.userData.type = 'terminal';
    conduit.userData.id = 'power_conduit';
    conduit.userData.active = false;
    _scene.add(conduit);

    // Conduit panel glow strips (3 horizontal bars)
    var panelMat = new THREE.MeshPhongMaterial({
      color: 0x00aaff, emissive: 0x00aaff, emissiveIntensity: 0.5
    });
    for (var pi = 0; pi < 3; pi++) {
      var panel = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.05), panelMat);
      panel.position.set(x + 6, y - 0.5 + pi * 0.4, z + 0.32);
      _scene.add(panel);
    }

    var conduitLight = new THREE.PointLight(0x0055ff, 1.2, 8);
    conduitLight.position.set(x + 6, y + 1, z);
    _scene.add(conduitLight);

    _conduitMesh = conduit;
    _interactable = airlock;

    return { airlock: airlock, conduit: conduit };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     MARINE SNOW — 450 particles (hard cap per spec).
     PointsMaterial: AdditiveBlending + depthWrite:false for correct layering.
     Per-particle velocity stored in userData.vel; Y drift updated in update().
     Phase stored in userData.phase for lateral CPU oscillation.
     Size stored in userData.sizes for per-point sizing via PointsMaterial.size
     (single global size — varied by scaling positions slightly instead of
     ShaderMaterial to honour the PointsMaterial + AdditiveBlending constraint).
  ───────────────────────────────────────────────────────────────────────── */
  function _buildParticles() {
    var COUNT = 450;
    var geo = new THREE.BufferGeometry();
    var pos = new Float32Array(COUNT * 3);
    var vel = new Float32Array(COUNT);
    var phase = new Float32Array(COUNT);
    var scale = new Float32Array(COUNT);   // per-particle logical scale 0.5–1.6

    for (var i = 0; i < COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 110;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 32;
      pos[i * 3 + 2] = -Math.random() * 85;
      vel[i] = 0.012 + Math.random() * 0.030;   // 0.012–0.042 u/frame
      phase[i] = Math.random() * Math.PI * 2;
      scale[i] = 0.5 + Math.random() * 1.1;       // 0.5–1.6 size factor
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    var mat = new THREE.PointsMaterial({
      color: 0xaaddff,
      size: 0.22,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.68,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    _particles = new THREE.Points(geo, mat);
    _particles.userData.vel = vel;
    _particles.userData.phase = phase;
    _particles.userData.scale = scale;
    _particles.userData.count = COUNT;
    _scene.add(_particles);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SPHERICAL BUBBLES — Procedural Radial Texture
     Creates a soft circular gradient: transparent center, refractive rim glow,
     and soft outer fade. Maps to a standard PointsMaterial to render perfect
     spheres without writing custom fragment shaders or using cubes.
  ───────────────────────────────────────────────────────────────────────── */
  function _makeBubbleTex() {
    var cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    var c = cv.getContext('2d');

    var cx = 32, cy = 32, r = 32;
    var grad = c.createRadialGradient(cx, cy, r * 0.4, cx, cy, r);
    // Center is almost fully transparent (liquid inside)
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.05)');
    // Refractive rim glow
    grad.addColorStop(0.7, 'rgba(255, 255, 255, 0.6)');
    // Soft outer feathering
    grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');

    c.fillStyle = grad;
    c.fillRect(0, 0, 64, 64);

    var tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BUBBLE SYSTEM — 200 particles
     Uses the radial texture to draw soft spheres.
  ───────────────────────────────────────────────────────────────────────── */
  function _buildBubbles() {
    var COUNT = 200; // TUNE: 80-400 bubbles based on desired density
    var geo = new THREE.BufferGeometry();
    var pos = new Float32Array(COUNT * 3);
    var vel = new Float32Array(COUNT);
    var phase = new Float32Array(COUNT);
    var wobble = new Float32Array(COUNT);

    // Spawn bubbles in a localized volume (player view area)
    for (var i = 0; i < COUNT; i++) {
      pos[i * 3]     = (Math.random() - 0.5) * 40;     // X span
      pos[i * 3 + 1] = -8 + Math.random() * 28;        // Y height (floor to +20)
      pos[i * 3 + 2] = -10 - Math.random() * 60;       // Z depth

      // Buoyancy / rise speed (u/frame)
      vel[i] = 0.025 + Math.random() * 0.035;          // TUNE: rise speed
      phase[i] = Math.random() * Math.PI * 2;
      wobble[i] = 0.006 + Math.random() * 0.010;       // TUNE: lateral drift
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    var mat = new THREE.PointsMaterial({
      color: 0xccffff,
      size: 0.55,           // TUNE: bubble scale
      map: _makeBubbleTex(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    _bubbles = new THREE.Points(geo, mat);
    _bubbles.userData.vel = vel;
    _bubbles.userData.phase = phase;
    _bubbles.userData.wobble = wobble;
    _bubbles.userData.count = COUNT;
    _scene.add(_bubbles);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     build — scene assembly entry point
     Returns { airlock, conduit } for main.js to wire into interactables.
  ───────────────────────────────────────────────────────────────────────── */
  function build(scene) {
    _scene = scene;
    _anemones = [];
    _kelpMaterials = [];
    _particles = null;
    _bubbles = null;
    _interactable = null;
    _conduitMesh = null;
    _causticMat = null;
    _causticReefMat = null;

    // Bioluminescent deep-water fog — denser, darker abyssal blue
    scene.fog = new THREE.FogExp2(0x021324, 0.020);
    scene.background = new THREE.Color(0x021324);

    // Lighting rig
    scene.add(new THREE.AmbientLight(0x0b2540, 1.8));

    // Surface light attenuation / weak god-rays
    var sun = new THREE.DirectionalLight(0x3377aa, 0.6);
    sun.position.set(5, 30, -10);
    scene.add(sun);

    // Downward fill light (softly illuminates seabed hollows from depth)
    var fill = new THREE.DirectionalLight(0x0a2035, 0.3);
    fill.position.set(0, -1, 0); // pointing straight down
    scene.add(fill);

    var ca1 = new THREE.PointLight(0x00ffaa, 1.2, 18);
    ca1.position.set(-8, -4, -18);
    scene.add(ca1);

    var ca2 = new THREE.PointLight(0xff6688, 1.0, 14);
    ca2.position.set(15, -4, -22);
    scene.add(ca2);

    // Organic displaced seabed
    _buildSeabed();

    // Helper to clamp hardcoded Y values to the procedural terrain + offset
    function clampY(x, hardY, z, offset) {
      offset = offset || 0;
      return Math.max(hardY, getElevation(x, z) + offset);
    }

    // Rocky arches
    _buildArch(0, clampY(0, 0, -20), -20);
    _buildArch(18, clampY(18, -1, -38), -38);

    // Kelp forest clusters (hue, stalkIndex varied for diversity)
    var kelpDefs = [
      [-8, -18, 140, 0],
      [7, -15, 162, 1],
      [15, -22, 118, 2],
      [-16, -26, 178, 3],
      [2, -32, 132, 4],
      [-4, -11, 155, 5],
      [12, -18, 147, 6],
      [-10, -34, 168, 7],
      [20, -24, 125, 8],
      [-20, -16, 172, 9]
    ];
    kelpDefs.forEach(function (k) {
      // Kelp roots planted on seabed
      var ky = clampY(k[0], -8, k[1], 0);
      _buildKelp(k[0], k[1], k[2], k[3], ky); // wait, _buildKelp takes x, z, hue, stalkIndex. I need to pass y.
    });

    // Anemone patches
    var anPos = [
      [-6, -13],
      [10, -19],
      [-14, -22],
      [4, -28],
      [-2, -17],
      [8, -35]
    ];
    anPos.forEach(function (p) { 
      _buildAnemone(p[0], clampY(p[0], -7.5, p[1], 0.2), p[1]); 
    });

    _buildShipwreck(-22, clampY(-22, -5, -48, 1.5), -48);
    var stationResult = _buildStation(0, clampY(0, -4, -58, 0.5), -58);
    _buildParticles();
    _buildBubbles();

    return stationResult;   // { airlock, conduit }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     updateCaustics — standard canvas 2D UV offset drift.
     Two independent drift directions create a shimmering parallax.
     No shader property mutations — safe from GPU recompilation.
  ───────────────────────────────────────────────────────────────────────── */
  function updateCaustics(time) {
    if (_causticMat && _causticMat.emissiveMap) {
      _causticMat.emissiveMap.offset.x = Math.sin(time * 0.068) * 0.20;
      _causticMat.emissiveMap.offset.y = Math.cos(time * 0.052) * 0.16;
    }
    if (_causticReefMat && _causticReefMat.emissiveMap) {
      _causticReefMat.emissiveMap.offset.x = Math.sin(time * 0.058 + 1.2) * 0.14;
      _causticReefMat.emissiveMap.offset.y = Math.cos(time * 0.075 + 0.8) * 0.12;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     update — called every frame from main.js _loop
     Handles: caustic UV drift · kelp uTime · snow drift · anemone sway
  ───────────────────────────────────────────────────────────────────────── */
  function update(t) {
    // Caustic UV drift (canvas 2D offset — zero shader recompile)
    updateCaustics(t);

    // Kelp GPU sway — uniform write only, never recompiles shader program
    for (var k = 0; k < _kelpMaterials.length; k++) {
      _kelpMaterials[k].uniforms.uTime.value = t;
    }

    // Marine snow — Y drift (upward) with lateral CPU sinusoidal oscillation
    if (_particles) {
      var pos = _particles.geometry.attributes.position.array;
      var vel = _particles.userData.vel;
      var phase = _particles.userData.phase;
      var COUNT = _particles.userData.count;

      for (var i = 0; i < COUNT; i++) {
        // Upward Y drift
        pos[i * 3 + 1] += vel[i];
        // Lateral sinusoidal oscillation driven by phase offset (CPU, cheap at 450 pts)
        pos[i * 3] += Math.sin(t * 0.55 + phase[i]) * 0.004;
        pos[i * 3 + 2] += Math.cos(t * 0.42 + phase[i] * 1.3) * 0.003;
        // Wrap-around: reset to bottom when reaching ceiling
        if (pos[i * 3 + 1] > 20) {
          pos[i * 3 + 1] = -18;
          pos[i * 3] = (Math.random() - 0.5) * 110;
          pos[i * 3 + 2] = -Math.random() * 85;
        }
      }
      _particles.geometry.attributes.position.needsUpdate = true;
    }

    // Bubbles — upward buoyancy + lateral wobble
    if (_bubbles) {
      var bPos = _bubbles.geometry.attributes.position.array;
      var bVel = _bubbles.userData.vel;
      var bPhase = _bubbles.userData.phase;
      var bWobble = _bubbles.userData.wobble;
      var BCOUNT = _bubbles.userData.count;

      for (var bi = 0; bi < BCOUNT; bi++) {
        // Buoyancy
        bPos[bi * 3 + 1] += bVel[bi];
        // Lateral wobble (X/Z sine drift)
        bPos[bi * 3]     += Math.sin(t * 1.2 + bPhase[bi]) * bWobble[bi];
        bPos[bi * 3 + 2] += Math.cos(t * 0.9 + bPhase[bi] * 1.4) * bWobble[bi];

        // Wrap-around
        if (bPos[bi * 3 + 1] > 20) {
          bPos[bi * 3 + 1] = -8 - Math.random() * 4;
          bPos[bi * 3]     = (Math.random() - 0.5) * 40;
          bPos[bi * 3 + 2] = -10 - Math.random() * 60;
        }
      }
      _bubbles.geometry.attributes.position.needsUpdate = true;
    }

    // Anemone tentacle sway
    for (var j = 0; j < _anemones.length; j++) {
      var an = _anemones[j];
      an.rotation.z = Math.sin(t * 1.1 + an.position.x * 0.5) * 0.09;
      an.rotation.x = Math.cos(t * 0.85 + an.position.z * 0.4) * 0.07;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     reset — purge all module-level state between sessions
  ───────────────────────────────────────────────────────────────────────── */
  function reset() {
    _scene = null;
    _particles = null;
    _bubbles = null;
    _anemones = [];
    _kelpMaterials = [];
    _interactable = null;
    _conduitMesh = null;
    _causticMat = null;
    _causticReefMat = null;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API — window.ABYSS.EnvironmentBuilder
  ───────────────────────────────────────────────────────────────────────── */
  window.ABYSS.EnvironmentBuilder = {
    build: build,
    update: update,
    updateCaustics: updateCaustics,
    reset: reset,
    getElevation: getElevation
  };

  // Legacy alias — backward compatible with any remaining window.EnvironmentBuilder references
  window.EnvironmentBuilder = window.ABYSS.EnvironmentBuilder;

}());
