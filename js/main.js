/* =============================================================================
   ABYSS: Marine Explorer — js/main.js  v4
   MODULE 4: Game Loop, Oxygen & Canvas 2D Dual HUD.
   Orchestrator: stereoscopic renderer, dive torch, gaze/dwell system,
   hudCanvas 2D HUD, mission state machine, O₂/depth/swim-state systems.

   LOAD ORDER: audio.js → environment.js → entities.js → controls.js → main.js

   RULES:
   - window.ABYSS.Audio is CONSUMED here, never defined — audio.js owns it.
   - All HUD output (O₂ bar, depth, swim state, dwell arc, mission list)
     drawn via hudCanvas 2D context — ZERO DOM reflow dependencies.
   - No shader recompilation: no emissiveIntensity mutation, no opacity mutation
     on Three.js materials. Fauna scan: emissive.setHex() only. Pollution:
     visible=false + position offscreen + splice from interactables.
   - commitInteraction dispatches cleanly across all 5 interaction types:
       'fauna', 'pollution', 'terminal' (power_conduit / o2_refill /
       specimen_deposit / waste_disposal), 'station'.
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     STATE MACHINE
  ───────────────────────────────────────────────────────────────────────── */
  var STATE  = { START: 'START', PLAYING: 'PLAYING', SUCCESS: 'SUCCESS', DEAD: 'DEAD' };
  var _state = STATE.START;

  /* ─────────────────────────────────────────────────────────────────────────
     GLOBALS
  ───────────────────────────────────────────────────────────────────────── */
  var _renderer, _scene;
  var _rig, _pitchObj, _camL, _camR;
  var _clock, _raycaster;
  var _W, _H;

  // HUD canvas
  var _hud, _hctx;

  // O2 system - ~333s baseline (~0.3% drain per sec)
  var _oxygen        = 333;
  var OXYGEN_SECS    = 333;
  // ── TUNE: drain constants ─────────────────────────────────────────────────
  // Worst-case math (max-depth + shark + scanning):
  //   O2_DRAIN_BASE × (1 + O2_DEPTH_EXTRA) × O2_SHARK_MULT + O2_DRAIN_SCAN
  //   = 0.50 × 1.30 × 1.50 + 0.15  ≈ 1.13 u/s  → ~160 s on a full tank
  var O2_DRAIN_BASE  = 0.50;  // TUNE: units/sec at surface (was 0.85) — range 0.35–0.75
  var O2_DEPTH_EXTRA = 0.30;  // TUNE: extra fraction at max depth (was 0.45) — range 0.15–0.50
  var O2_DRAIN_SCAN  = 0.15;  // TUNE: extra u/s while dwelling (was 0.30) — range 0.0–0.25
  var O2_SHARK_MULT  = 1.50;  // TUNE: panic multiplier when shark near (was 1.75) — max 1.5 per spec

  // Scanner — uniform 3D radius + hysteresis (prevents edge flicker)
  // TUNE: SCAN_RADIUS governs raycaster far-clip and interaction range.
  // TUNE: SCAN_HYSTERESIS adds a soft outer band so contacts don't flicker at the edge.
  var SCAN_RADIUS      = 26;   // TUNE: interaction/gaze-lock radius (world units) — range 18–30
                               //       Widened from 22 → 26 to match SCAN_CONE_RADIUS in controls.js.
                               //       More forgiving of target drift during pitch-driven locomotion.
  var SCAN_HYSTERESIS  = 3;    // TUNE: hysteresis band width — range 2–5
  var _scanLock        = false;
  var _scanFalloff     = 0;

  // Radar — separate range so the minimap shows the broader environment
  var RADAR_RANGE      = 60;   // TUNE: radar visibility radius (world units) — range 40–90


  // Mission counters
  var _speciesScanned  = 0;     // 0..5
  var _pollutionDone   = 0;     // 0..4
  var _conduitDone     = false;
  var _stationDone     = false;
  var _o2RefillDone    = false; // O2_REFILL terminal — counted toward success
  var _specimensDone   = 0;     // specimens deposited into SPECIMEN_DEPOSIT
  var _wasteDone       = false; // WASTE_DISPOSAL hatch opened

  // Gaze / dwell system
  // ── TUNE: dwell constants ─────────────────────────────────────────────────
  var GAZE_REQ      = 1.5;   // TUNE: seconds of dwell to complete a scan (was 2.0) — range 1.0–3.0
  var GAZE_GRACE    = 0.65;  // TUNE: seconds of lock retention after gaze leaves target — range 0.3–1.0
                             //       Prevents fast-moving animals from resetting the bar on 1-frame escapes.
  var _gazeTarget   = null;
  var _gazeTime     = 0;
  var _gazeProgress = 0;
  var _gazeLostTime = 0;     // seconds since gaze last left the target (0 = on target)
  var _interactables = [];


  // Dive torch
  var _torch       = null;
  var _torchTarget = null;

  // Timing
  var _lastTS = 0;

  // Depth bounds — must match controls.js and environment.js
  var FLOOR_Y    = -8;
  var SURFACE_Y  = 20;
  var DEPTH_RANGE = SURFACE_Y - FLOOR_Y;   // 28 units → 80m display

  // Shark audio throttle
  var _lastSharkAlert = 0;

  /* ─────────────────────────────────────────────────────────────────────────
     START-SCREEN BACKGROUND PARTICLES
  ───────────────────────────────────────────────────────────────────────── */
  function _initBgParticles() {
    var cv = document.getElementById('bgParticles');
    if (!cv) return;
    var c  = cv.getContext('2d');

    function resize() {
      if (cv) {
        cv.width  = window.innerWidth || 800;
        cv.height = window.innerHeight || 600;
      }
    }
    resize();
    window.addEventListener('resize', resize);

    var pts = [];
    for (var i = 0; i < 80; i++) {
      pts.push({
        x:  Math.random() * window.innerWidth,
        y:  Math.random() * window.innerHeight,
        r:  Math.random() * 2 + 0.4,
        vy: -(Math.random() * 0.28 + 0.08),
        op: Math.random()
      });
    }

    (function draw() {
      c.clearRect(0, 0, cv.width, cv.height);
      pts.forEach(function (p) {
        p.y += p.vy;
        if (p.y < 0) p.y = cv.height;
        c.beginPath();
        c.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        c.fillStyle = 'rgba(0,255,204,' + (0.22 + p.op * 0.38) + ')';
        c.fill();
      });
      requestAnimationFrame(draw);
    }());
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RENDERER + DUAL CAMERAS + RIG
     Rig hierarchy: _rig (yaw + position) → _pitchObj (pitch) → _camL / _camR
  ───────────────────────────────────────────────────────────────────────── */
  function _initRenderer() {
    _W = window.innerWidth || 800;
    _H = window.innerHeight || 600;

    var canvas = document.getElementById('vrCanvas') || document.getElementById('webgl-canvas') || document.querySelector('canvas');
    if (!canvas || canvas.id === 'bgParticles' || canvas.id === 'hudCanvas') {
      canvas = document.createElement('canvas');
      canvas.id = 'vrCanvas';
      canvas.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 1; outline: none;';
      document.body.appendChild(canvas);
    }
    
    _renderer  = new THREE.WebGLRenderer({
      canvas:                canvas,
      antialias:             false,
      powerPreference:       'high-performance',
      preserveDrawingBuffer: false
    });
    _renderer.autoClear         = false;
    _renderer.shadowMap.enabled = false;
    _renderer.setClearColor(0x041a2e, 1);
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    _renderer.setSize(_W, _H);

    _clock     = new THREE.Clock();
    _raycaster = new THREE.Raycaster();
    // TUNE: raycaster far = SCAN_RADIUS * 1.5 (was SCAN_RADIUS + SCAN_HYSTERESIS = 25u).
    // Extended so fast entities that briefly dart beyond the nominal radius still register.
    _raycaster.far = SCAN_RADIUS * 1.5;


    _rig      = new THREE.Group();
    _pitchObj = new THREE.Group();
    _rig.add(_pitchObj);

    // IPD = 60mm — offset cameras ±30mm on X from rig pivot
    var IPD = 0.060;
    _camL = new THREE.PerspectiveCamera(80, 1, 0.1, 500);
    _camL.position.x = -IPD / 2;
    _pitchObj.add(_camL);

    _camR = new THREE.PerspectiveCamera(80, 1, 0.1, 500);
    _camR.position.x =  IPD / 2;
    _pitchObj.add(_camR);

    _updateCameraAspect();
    _rig.position.set(0, 0, 0);
  }

  function _updateCameraAspect() {
    _W = window.innerWidth || 800;
    _H = window.innerHeight || 600;
    var aspect = (_W / 2) / _H;
    if (_camL) { _camL.aspect = aspect; _camL.fov = 80; _camL.updateProjectionMatrix(); }
    if (_camR) { _camR.aspect = aspect; _camR.fov = 80; _camR.updateProjectionMatrix(); }
    if (_renderer) _renderer.setSize(_W, _H);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     DIVE TORCH + HELMET GLOW
  ───────────────────────────────────────────────────────────────────────── */
  function _attachTorch() {
    if (!_rig || typeof _rig.add !== 'function') {
      console.warn("Rig not ready for torch");
      return;
    }
    _torch           = new THREE.SpotLight(0xcceeff, 2.8);
    _torch.distance  = 45;
    _torch.angle     = Math.PI / 5.5;
    _torch.penumbra  = 0.45;
    _torch.decay     = 1.2;
    _torch.position.set(0, 0, 0);

    _torchTarget = new THREE.Object3D();
    _torchTarget.position.set(0, 0, -1);

    _rig.add(_torch);
    _rig.add(_torchTarget);
    _torch.target = _torchTarget;

    // Helmet rim glow — subtle cyan point under the rig
    var glow = new THREE.PointLight(0x00e5ff, 0.9, 8);
    glow.position.set(0, -0.5, 0);
    _rig.add(glow);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     HUD CANVAS INIT
  ───────────────────────────────────────────────────────────────────────── */
  function _initHUD() {
    _hud = document.getElementById('hudCanvas');
    if (!_hud) return;
    _hctx = _hud.getContext('2d');
    _hud.width  = _W || 800;
    _hud.height = _H || 600;
  }

  /* ─── Rounded rect helper ─────────────────────────────────────────────────── */
  function _roundRect(ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     _drawEyeHUD — all dynamic HUD on hudCanvas (ZERO DOM reflow)
     Called twice per frame: once for the left eye viewport, once for right.
       ox   = x-pixel offset of this viewport (0 for left, _W/2 for right)
       eyeW = _W/2
       eyeH = _H
  ───────────────────────────────────────────────────────────────────────── */
  function _drawEyeHUD(ctx, ox, eyeW, eyeH) {
    var t      = _clock.getElapsedTime();
    var cx     = ox + eyeW / 2;
    var cy     = eyeH / 2;
    var oxyPct = Math.max(0, Math.min(1, _oxygen / OXYGEN_SECS));
    var oxyLow = oxyPct <= 0.20;   // flash red if below 20%
    var swimSt = (window.ABYSS && window.ABYSS.Controls)
      ? ABYSS.Controls.getSwimState() : 'HOVERING';
    var pitchDeg = (window.ABYSS && window.ABYSS.Controls && ABYSS.Controls.getPitchDeg)
      ? ABYSS.Controls.getPitchDeg().toFixed(1) : '--';

    /* ── Deep water vignette gradients (top + bottom edges) ── */
    var topG = ctx.createLinearGradient(ox, 0, ox, eyeH * 0.18);
    topG.addColorStop(0, 'rgba(4,26,46,0.72)');
    topG.addColorStop(1, 'rgba(4,26,46,0)');
    ctx.fillStyle = topG;
    ctx.fillRect(ox, 0, eyeW, eyeH * 0.18);

    var botG = ctx.createLinearGradient(ox, eyeH * 0.82, ox, eyeH);
    botG.addColorStop(0, 'rgba(4,26,46,0)');
    botG.addColorStop(1, 'rgba(4,26,46,0.72)');
    ctx.fillStyle = botG;
    ctx.fillRect(ox, eyeH * 0.82, eyeW, eyeH * 0.18);

    /* ─── TOP-CENTER: HEADING & O₂ BAR ─────────────────────────────── */
    var fsz  = Math.max(10, Math.round(eyeW * 0.019));
    var barW = 140; // Fixed width per prompt
    var barH = 8;
    var barX = cx - barW / 2;
    var barY = 32;

    // Heading indicator text
    var yawDeg = (window.ABYSS && typeof ABYSS._rigYaw === 'number') ? (ABYSS._rigYaw * 180 / Math.PI) : 0;
    yawDeg = (yawDeg % 360 + 360) % 360;
    var hdgTxt = 'HDG: ' + yawDeg.toFixed(0) + '\u00B0';
    
    ctx.font      = 'bold ' + fsz + 'px "Share Tech Mono",monospace';
    ctx.fillStyle = '#00ffcc';
    ctx.textAlign = 'center';
    ctx.fillText(hdgTxt, cx, barY - 18);
    
    // Compass tick slider bar (simple representation)
    ctx.strokeStyle = 'rgba(0,255,204,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 30, barY - 12);
    ctx.lineTo(cx + 30, barY - 12);
    ctx.moveTo(cx, barY - 16);
    ctx.lineTo(cx, barY - 12);
    ctx.stroke();

    // Colour: green → amber → pulsing red
    var oxyColor;
    if (oxyLow) {
      oxyColor = (Math.sin(t * 6) > 0) ? '#ff4444' : '#ff0000';
    } else if (oxyPct <= 0.334) {
      oxyColor = '#ffaa00';
    } else {
      oxyColor = '#00ffcc';
    }

    ctx.font = 'bold ' + Math.max(9, fsz-1) + 'px "Share Tech Mono",monospace';
    ctx.fillStyle = oxyColor;
    ctx.textAlign = 'left';
    ctx.fillText('O\u2082 RESERVES:', cx - barW / 2 - 90, barY + barH - 1);

    // Track background
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    _roundRect(ctx, barX, barY, barW, barH, 3);
    ctx.fill();

    // Filled bar segment
    if (oxyPct > 0) {
      if (oxyLow) { ctx.shadowBlur = 12; ctx.shadowColor = oxyColor; }
      ctx.fillStyle = oxyColor;
      _roundRect(ctx, barX + 2, barY + 2,
        Math.max(0, (barW - 4) * oxyPct), barH - 4, 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Percentage readout
    ctx.fillStyle = oxyLow ? oxyColor : 'rgba(255,255,255,0.82)';
    ctx.fillText(Math.ceil(oxyPct * 100) + '%', barX + barW + 8, barY + barH - 1);

    /* ─── TOP-RIGHT: DEPTH METER ──────────────────────────────── */
    var rigY  = _rig ? _rig.position.y : 0;
    var depth = Math.max(0, ((SURFACE_Y - rigY) / DEPTH_RANGE) * 80);
    var dTxt  = 'DEPTH ' + depth.toFixed(0) + 'm';

    ctx.font      = 'bold ' + fsz + 'px "Share Tech Mono",monospace';
    ctx.textAlign = 'right';
    var dW = ctx.measureText(dTxt).width + 18;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    _roundRect(ctx, ox + eyeW - dW - 12, barY, dW, barH + 2, 3);
    ctx.fill();
    ctx.fillStyle = '#00ffcc';
    ctx.fillText(dTxt, ox + eyeW - 15, barY + barH - 1);

    /* ─── SWIM STATE — below depth readout, top-right ─────────── */
    var stateY = barY + barH + 14;
    ctx.font = 'bold ' + Math.max(9, Math.round(eyeW * 0.016)) + 'px "Share Tech Mono",monospace';
    ctx.textAlign = 'right';
    var stateColors = {
      'HOVERING':  'rgba(0,255,204,0.5)',
      'SWIMMING':  '#00ffcc',
      'ASCENDING': '#00eeff',
      'DIVING':    '#ff9900'
    };
    ctx.fillStyle = stateColors[swimSt] || '#00ffcc';
    ctx.fillText(swimSt, ox + eyeW - 15, stateY);

    // Pitch angle readout (small, below swim state)
    var pitchY = stateY + Math.max(9, Math.round(eyeW * 0.016)) + 4;
    ctx.font      = Math.max(8, Math.round(eyeW * 0.013)) + 'px "Share Tech Mono",monospace';
    ctx.fillStyle = 'rgba(0,255,204,0.4)';
    ctx.fillText('PITCH ' + pitchDeg + '\u00B0', ox + eyeW - 15, pitchY);

    /* ─── SHARK WARNING — left side, blinking ─────────────────── */
    if (window.ABYSS && window.ABYSS._sharkNear) {
      var sharkAlpha = 0.6 + 0.4 * Math.abs(Math.sin(t * 5));
      ctx.fillStyle  = 'rgba(255,40,40,' + sharkAlpha + ')';
      ctx.font       = 'bold ' + Math.max(10, Math.round(eyeW * 0.018)) + 'px "Share Tech Mono",monospace';
      ctx.textAlign  = 'left';
      ctx.fillText('\u26A0 SHARK PROXIMITY', barX, stateY);
    }

    /* ─── O₂ REFILL STATUS (left, below shark warning) ─────────── */
    if (_o2Terminal) {
      var o2ud = _o2Terminal.userData;
      if (o2ud && o2ud.cooldown) {
        var elapsed    = (performance.now() - o2ud.cooldownStart) / 1000;
        var remaining  = Math.max(0, o2ud.cooldownSecs - elapsed);
        var refillY    = stateY + 18;
        ctx.font      = Math.max(8, Math.round(eyeW * 0.013)) + 'px "Share Tech Mono",monospace';
        ctx.fillStyle = 'rgba(0,255,204,0.55)';
        ctx.textAlign = 'left';
        ctx.fillText('\u21BA O\u2082 REFILL COOLDOWN ' + remaining.toFixed(0) + 's', barX, refillY);
      }
    }

    /* ─── CENTER: DWELL RETICLE + GAZE ARC ───────────────────── */
    var rR = Math.round(eyeW * 0.030);

    // Outer static ring — brightens with scan-lock falloff (no edge flicker)
    var ringA = 0.45 + 0.55 * _scanFalloff;
    ctx.strokeStyle = _gazeProgress > 0 ? '#00ffcc' : 'rgba(255,255,255,' + ringA + ')';
    ctx.lineWidth   = _gazeProgress > 0 ? 2.5 : (1.4 + _scanFalloff);
    if (_gazeProgress > 0 || _scanFalloff > 0.35) { ctx.shadowBlur = 14; ctx.shadowColor = '#00ffcc'; }
    ctx.beginPath();
    ctx.arc(cx, cy, rR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Centre dot
    ctx.fillStyle = _gazeProgress > 0 ? 'rgba(0,255,204,0.95)' : 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.8, 0, Math.PI * 2);
    ctx.fill();

    // Crosshair tick marks
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(cx - rR - 10, cy); ctx.lineTo(cx - rR + 6, cy);
    ctx.moveTo(cx + rR - 6,  cy); ctx.lineTo(cx + rR + 10, cy);
    ctx.moveTo(cx, cy - rR - 10); ctx.lineTo(cx, cy - rR + 6);
    ctx.moveTo(cx, cy + rR - 6);  ctx.lineTo(cx, cy + rR + 10);
    ctx.stroke();

    // Dwell arc — 2.0s sweep drawn directly on canvas, clockwise from 12 o'clock.
    // Equivalent to stroke-dashoffset but via canvas arc — ZERO DOM dependency.
    if (_gazeProgress > 0) {
      ctx.strokeStyle = '#00ffcc';
      ctx.lineWidth   = 4;
      ctx.shadowBlur  = 22;
      ctx.shadowColor = '#00ffcc';
      ctx.beginPath();
      ctx.arc(cx, cy, rR,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * _gazeProgress);
      ctx.stroke();
      ctx.shadowBlur  = 0;

      // Countdown percentage inside ring
      var pctTxt = Math.ceil(_gazeProgress * 100) + '%';
      ctx.font      = 'bold ' + Math.max(8, Math.round(eyeW * 0.012)) + 'px "Share Tech Mono",monospace';
      ctx.fillStyle = 'rgba(0,255,204,0.82)';
      ctx.textAlign = 'center';
      ctx.fillText(pctTxt, cx, cy - rR - 7);
    }

    // Target label below reticle
    if (_gazeTarget && _gazeTarget.userData) {
      var LABELS = {
        turtle:            'SEA TURTLE',
        jellyfish:         'JELLYFISH',
        clownfish:         'CLOWNFISH',
        mantaray:          'MANTA RAY',
        eel:               'BIOLUM. EEL',
        power_conduit:     'POWER CONDUIT \u2014 ACTIVATE',
        station_airlock:   'AIRLOCK \u2014 PRESSURIZE',
        o2_refill:         'O\u2082 REFILL \u2014 INHALE',
        specimen_deposit:  'SPECIMEN DEPOSIT \u2014 STORE',
        waste_disposal:    'WASTE DISPOSAL \u2014 OPEN HATCH'
      };
      var lbl = '';
      var tud = _gazeTarget.userData;
      if (tud.type === 'fauna')     lbl = LABELS[tud.id] || 'SCANNING';
      if (tud.type === 'pollution') lbl = 'POLLUTION \u2014 COLLECT';
      if (tud.type === 'terminal')  lbl = LABELS[tud.id] || 'ACTIVATE TERMINAL';
      if (tud.type === 'station')   lbl = LABELS[tud.id] || 'SCAN';

      if (lbl) {
        ctx.font = 'bold ' + Math.round(eyeW * 0.021) + 'px "Share Tech Mono",monospace';
        var lbW  = ctx.measureText(lbl).width + 28;
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        _roundRect(ctx, cx - lbW / 2, cy + rR + 14, lbW, 30, 5);
        ctx.fill();
        ctx.fillStyle = '#00ffcc';
        ctx.textAlign = 'center';
        ctx.fillText(lbl, cx, cy + rR + 33);
      }
    }

    /* ─── BOTTOM-LEFT: MISSION CHECKLIST (Beside Radar) ───────── */
    /* --- BOTTOM-LEFT: MISSION CHECKLIST (DOM Elements) --- */
    var missions = [
      { label: 'FAUNA CATALOG (5 species)',    done: _speciesScanned >= 5,  count: _speciesScanned + '/5' },
      { label: 'POLLUTION RETRIEVAL (4)',       done: _pollutionDone  >= 4,  count: _pollutionDone  + '/4' },
      { label: 'POWER CONDUIT ACTIVATED',       done: _conduitDone,          count: _conduitDone    ? '1/1' : '0/1' },
      { label: 'O\u2082 REFILL STATION',        done: _o2RefillDone,         count: _o2RefillDone   ? '1/1' : '0/1' },
      { label: 'SPECIMEN DEPOSIT',              done: _specimensDone >= 1,   count: _specimensDone  + '/1' },
      { label: 'WASTE DISPOSAL HATCH',          done: _wasteDone,            count: _wasteDone      ? '1/1' : '0/1' },
      { label: 'AIRLOCK PRESSURIZED',           done: _stationDone,          count: _stationDone    ? '1/1' : '0/1' }
    ];

    var html = '<div class="mission-header">MISSIONS</div>' + missions.map(function(m) {
      var cls = m.done ? 'mission-item mission-done' : 'mission-item';
      var icon = m.done ? '&#10003;' : '&#9675;';
      return '<div class="' + cls + '"><span class="mission-icon">' + icon + '</span> ' + m.label + ' <span class="mission-count">' + m.count + '</span></div>';
    }).join('');

    var el = document.getElementById(ox === 0 ? 'mission-hud-left' : 'mission-hud-right');
    if (el && el.innerHTML !== html) {
      el.innerHTML = html;
    }

    _drawRadar(ctx, ox, eyeW, eyeH);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     Bottom-CENTER sonar radar — blips in player-relative XZ, both eyes.
     Coordinate space: XZ only (Y is depth — not mapped to 2D radar).
     Soft alpha falloff near RADAR_RANGE edge so contacts don't pop.
     Player rendered as a small forward-direction arrow at radar centre.
  ───────────────────────────────────────────────────────────────────────── */
  function _drawRadar(ctx, ox, eyeW, eyeH) {
    var rigPos = (window.ABYSS && window.ABYSS._rigPosition) ? ABYSS._rigPosition : null;
    if (!rigPos) return;

    var yaw = (window.ABYSS && typeof ABYSS._rigYaw === 'number') ? ABYSS._rigYaw : 0;
    var contacts = (window.ABYSS && window.ABYSS.EntityManager &&
                    ABYSS.EntityManager.getRadarContacts)
      ? ABYSS.EntityManager.getRadarContacts() : [];

    // ── Layout ────────────────────────────────────────────────────────────
    // TUNE: fixed diameter (~75px-80px)
    var rad  = 34;
    // Bottom-LEFT of each eye viewport
    var cx   = ox + 12 + rad;
    var cy   = eyeH - rad - 12;

    ctx.save();

    // ── Background disc ───────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0, 8, 18, 0.68)';
    ctx.beginPath();
    ctx.arc(cx, cy, rad + 7, 0, Math.PI * 2);
    ctx.fill();

    // ── Outer ring + mid ring ─────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(0,255,204,0.38)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, rad * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // ── Cross-hair lines ──────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(0,255,204,0.18)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(cx - rad, cy); ctx.lineTo(cx + rad, cy);
    ctx.moveTo(cx, cy - rad); ctx.lineTo(cx, cy + rad);
    ctx.stroke();

    // ── Rotating sonar sweep line ─────────────────────────────────────────
    var t = _clock.getElapsedTime();
    var sweep = (t * 1.4) % (Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,255,204,0.25)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(sweep) * rad, cy - Math.cos(sweep) * rad);
    ctx.stroke();

    // ── Blips — world-space XZ mapped to radar, yaw-rotated ──────────────
    // TUNE: RADAR_RANGE defines how many world units map to the radar edge.
    var range  = RADAR_RANGE;
    var cosY   = Math.cos(yaw);
    var sinY   = Math.sin(yaw);
    // Soft-falloff starts at inner 85% of radar range to prevent edge pop
    var fadeStart = range * 0.85;

    for (var i = 0; i < contacts.length; i++) {
      var c  = contacts[i];
      var dx = c.x - rigPos.x;
      var dz = c.z - rigPos.z;
      // XZ-only distance for radar (depth/Y is ignored — shown as depth meter)
      var dist2D = Math.hypot(dx, dz);
      if (dist2D > range) continue;           // outside radar range — skip

      // Rotate relative vector by player yaw so "up on radar = forward"
      var lx =  dx * cosY - dz * sinY;
      var lz =  dx * sinY + dz * cosY;
      var px = cx + (lx / range) * rad;
      var pz = cy + (lz / range) * rad;       // note: Z maps to screen-Y

      // Alpha falloff near edge — smooth contact appearance
      var fall = 1 - Math.max(0, Math.min(1, (dist2D - fadeStart) / (range - fadeStart)));

      var col;
      if (c.kind === 'shark') {
        col = 'rgba(255,60,60,'   + (0.6 + 0.4 * fall) + ')';
      } else if (c.kind === 'pollution') {
        col = 'rgba(255,170,0,'   + (0.5 + 0.5 * fall) + ')';
      } else if (c.kind === 'terminal' || c.kind === 'station') {
        col = 'rgba(80,180,255,'  + (0.5 + 0.5 * fall) + ')';
      } else {
        // fauna: cyan if unscanned, green if already scanned
        col = c.scanned
          ? 'rgba(0,255,136,' + (0.4 + 0.5 * fall) + ')'
          : 'rgba(0,255,204,' + (0.55 + 0.45 * fall) + ')';
      }

      var blipR = c.kind === 'shark' ? 3.4 : 2.4;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(px, pz, blipR, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Player arrow — points in the rig's forward direction ─────────────
    // Arrow tip always points to the top of the radar (forward = screen-up).
    // The world is already rotated by yaw above, so player arrow is fixed north.
    var aLen = rad * 0.14;   // TUNE: arrow length fraction of radar radius
    var aWid = rad * 0.07;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,255,204,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx,           cy - aLen);          // tip  (forward / north)
    ctx.lineTo(cx + aWid,    cy + aLen * 0.5);    // right base
    ctx.lineTo(cx - aWid,    cy + aLen * 0.5);    // left base
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // ── Label ────────────────────────────────────────────────────────────
    ctx.font = 'bold ' + Math.max(7, Math.round(eyeW * 0.011)) + 'px "Share Tech Mono",monospace';
    ctx.fillStyle = 'rgba(0,255,204,0.50)';
    ctx.textAlign = 'center';
    ctx.fillText('SONAR', cx, cy + rad + 13);

    ctx.restore();
  }


  /* ─────────────────────────────────────────────────────────────────────────
     _drawHUDFrame — clear full canvas + render both eye viewports.
     FIX (Task 1 — ghosting): each eye pass is isolated with ctx.save() /
     ctx.restore() so accumulated canvas state (shadowBlur, lineWidth,
     fillStyle, textAlign, font) from the left-eye draw cannot bleed into
     the right-eye draw and produce a static duplicate artifact.
  ───────────────────────────────────────────────────────────────────────── */
  function _drawHUDFrame() {
    if (!_hud || !_hctx) return;
    // Always clear first - prevents stale pixels from prior frames or
    // resize events accumulating on the HUD layer.
    _hctx.clearRect(0, 0, _hud.width, _hud.height);

    if (_state === STATE.DEAD) {
      // Red vignette encroaches from edges
      var rg = _hctx.createRadialGradient(_W / 2, _H / 2, _H * 0.2, _W / 2, _H / 2, _H * 0.75);
      rg.addColorStop(0, 'rgba(0,0,0,0)');
      rg.addColorStop(1, 'rgba(180,0,0,0.65)');
      _hctx.fillStyle = rg;
      _hctx.fillRect(0, 0, _W, _H);
      return;
    }

    if (_state !== STATE.PLAYING && _state !== STATE.SUCCESS) return;

    // Left eye — isolated canvas state
    _hctx.save();
    _drawEyeHUD(_hctx, 0,      _W / 2, _H);
    _hctx.restore();

    // Right eye — isolated canvas state (no bleed from left-eye pass)
    _hctx.save();
    _drawEyeHUD(_hctx, _W / 2, _W / 2, _H);
    _hctx.restore();

    // Centre nose-bridge separator — explicit state, not inherited
    _hctx.save();
    _hctx.strokeStyle = 'rgba(0,255,204,0.08)';
    _hctx.lineWidth   = 1;
    _hctx.shadowBlur  = 0;
    _hctx.beginPath();
    _hctx.moveTo(_W / 2, 0);
    _hctx.lineTo(_W / 2, _H);
    _hctx.stroke();
    _hctx.restore();
  }


  /* ─────────────────────────────────────────────────────────────────────────
     SCISSOR RENDER — side-by-side stereoscopic pass
     autoClear=false: disable scissor, full-buffer clear, then per-eye scissor
     clear+render so leftover fragments cannot ghost in the other eye.
  ───────────────────────────────────────────────────────────────────────── */
  function _render() {
    var halfW  = Math.floor(_W / 2);
    var rightW = _W - halfW;

    // gl.clear() is scissored. Disable scissor and wipe the whole buffer
    // or the previous eye's half keeps last-frame pixels ("one moves, one stays").
    _renderer.setScissorTest(false);
    _renderer.setViewport(0, 0, _W, _H);
    _renderer.clear(true, true, true);

    _renderer.setScissorTest(true);

    _renderer.setScissor(0, 0, halfW, _H);
    _renderer.setViewport(0, 0, halfW, _H);
    _renderer.clear(true, true, true);
    _renderer.render(_scene, _camL);

    _renderer.setScissor(halfW, 0, rightW, _H);
    _renderer.setViewport(halfW, 0, rightW, _H);
    _renderer.clear(true, true, true);
    _renderer.render(_scene, _camR);

    _renderer.setScissorTest(false);
    _drawHUDFrame();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     _audio(name, ...args)
     Safe audio dispatch — checks ABYSS.Audio then SoundSystem.
     Zero inline conditionals needed at each call site.
  ───────────────────────────────────────────────────────────────────────── */
  function _audio(name) {
    var api = (window.ABYSS && window.ABYSS.Audio)
            ? window.ABYSS.Audio
            : (window.SoundSystem || null);
    if (api && typeof api[name] === 'function') {
      api[name]();
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     commitInteraction(target)
     Handles dwell completion for all 5 interaction types.

     TYPE DISPATCH TABLE:
       'fauna'    → scan + emissive flash (setHex only)
       'pollution'→ collect + hide + splice interactables
       'terminal' →
           power_conduit    → activate station flood lights
           o2_refill        → refill O₂ + start cooldown
           specimen_deposit → log specimen, play chime
           waste_disposal   → lerp hatch open, play rumble
       'station'  → airlock pressurize → check win condition

     ZERO SHADER RECOMPILATION:
       - emissiveIntensity NEVER mutated.
       - Only emissive.setHex() and PointLight.intensity are modified.
       - Pollution: visible=false + position offscreen, never re-added.
  ───────────────────────────────────────────────────────────────────────── */
  // Module-level refs to terminal meshes for O2 cooldown readout in HUD
  var _o2Terminal = null;

  function _commitInteraction(target) {
    if (!target || !target.userData) return;

    var ud = target.userData;

    /* ══════════════════ POLLUTION COLLECTION ══════════════════ */
    if (ud.type === 'pollution') {
      if (ud.collected) return;
      ud.collected = true;
      _pollutionDone++;

      _audio('playScanChime');

      // Hide + move offscreen — no material mutation
      target.visible = false;
      target.position.set(0, -999, 0);

      // Splice from both the module-level list and EntityManager's live list
      var em = (window.ABYSS && window.ABYSS.EntityManager)
        ? ABYSS.EntityManager.getInteractables() : _interactables;
      var pi = em.indexOf(target);
      if (pi !== -1) em.splice(pi, 1);
      var li = _interactables.indexOf(target);
      if (li !== -1) _interactables.splice(li, 1);
    }

    /* ══════════════════ FAUNA SCANNING ══════════════════ */
    else if (ud.type === 'fauna') {
      if (ud.scanned) return;
      ud.scanned = true;
      _speciesScanned++;

      _audio('playSonarPing');
      setTimeout(function () { _audio('playScanChime'); }, 350);

      // Scan flash — emissive.setHex only, no intensity mutation
      target.traverse(function (node) {
        if (node.isMesh && node.material && node.material.emissive) {
          var origHex = node.material.emissive.getHex();
          node.material.emissive.setHex(0x00ffff);
          setTimeout(function () {
            if (node.material && node.material.emissive) {
              node.material.emissive.setHex(origHex);
            }
          }, 700);
        }
      });
    }

    /* ══════════════════ TERMINAL DISPATCH ══════════════════ */
    else if (ud.type === 'terminal') {

      /* ── power_conduit: activate station floodlights ── */
      if (ud.id === 'power_conduit') {
        if (_conduitDone) return;
        _conduitDone = true;

        _audio('playScanChime');

        // Flash conduit emissive white — emissiveIntensity is not touched
        _scene.traverse(function (obj) {
          if (obj.isMesh && obj.material && obj.material.emissive) {
            if (obj.userData.id === 'power_conduit' || obj === target) {
              obj.material.emissive.setHex(0xffffff);
            }
          }
          // Boost research station viewport PointLights to 4.5
          if (obj.isPointLight && Math.abs(obj.intensity - 2.2) < 0.3) {
            obj.intensity = 4.5;
            obj.color.set(0xffffff);
          }
        });
      }

      /* ── o2_refill: refill oxygen + start cooldown ── */
      else if (ud.id === 'o2_refill') {
        if (ud.cooldown) return;    // still cooling down — reject interaction

        _audio('playPneumaticHiss');

        // Refill to full (cap at OXYGEN_SECS)
        _oxygen = OXYGEN_SECS;
        _o2RefillDone = true;

        // Store ref for HUD cooldown readout
        _o2Terminal = target;

        // Delegate cooldown management to EntityManager
        if (window.ABYSS && window.ABYSS.EntityManager &&
            ABYSS.EntityManager.startO2Cooldown) {
          ABYSS.EntityManager.startO2Cooldown();
        } else {
          // Fallback: manage locally
          ud.cooldown      = true;
          ud.cooldownStart = performance.now();
          ud.cooldownSecs  = 30;
        }

        // Cyan emissive flash on tank to confirm
        target.traverse(function (node) {
          if (node.isMesh && node.material && node.material.emissive) {
            node.material.emissive.setHex(0x00ffff);
            setTimeout(function () {
              if (node.material && node.material.emissive) {
                node.material.emissive.setHex(0x003344);
              }
            }, 600);
          }
        });
      }

      /* ── specimen_deposit: deposit specimen, play chime ── */
      else if (ud.id === 'specimen_deposit') {
        _audio('playChime');

        _specimensDone++;
        ud.deposited = (ud.deposited || 0) + 1;

        // Brief green flash on console screens
        target.traverse(function (node) {
          if (node.isMesh && node.material && node.material.emissive) {
            var origH = node.material.emissive.getHex();
            node.material.emissive.setHex(0x00ff77);
            setTimeout(function () {
              if (node.material && node.material.emissive) {
                node.material.emissive.setHex(origH);
              }
            }, 500);
          }
        });
      }

      /* ── waste_disposal: open hatch via lerp, play rumble ── */
      else if (ud.id === 'waste_disposal') {
        _audio('playMechanicalRumble');

        _wasteDone = true;

        // Delegate hatch lerp to EntityManager (entities.js manages it)
        if (window.ABYSS && window.ABYSS.EntityManager &&
            ABYSS.EntityManager.openWasteHatch) {
          ABYSS.EntityManager.openWasteHatch();
        } else {
          // Fallback: set targetRot directly on userData
          ud.hatchOpen = true;
          ud.targetRot = Math.PI;
        }

        // Re-close hatch automatically after 4 seconds
        setTimeout(function () {
          if (window.ABYSS && window.ABYSS.EntityManager &&
              ABYSS.EntityManager.closeWasteHatch) {
            ABYSS.EntityManager.closeWasteHatch();
          } else if (ud) {
            ud.hatchOpen = false;
            ud.targetRot = 0;
          }
          _audio('playMechanicalRumble');
        }, 4000);

        ud.disposed = (ud.disposed || 0) + 1;
      }
    }

    /* ══════════════════ STATION AIRLOCK ══════════════════ */
    else if (ud.type === 'station') {
      if (_stationDone) return;
      _stationDone = true;

      _audio('playScanChime');

      // Viewport PointLights go green — pressurization signal
      _scene.traverse(function (obj) {
        if (obj.isPointLight && obj.intensity > 4.0) {
          obj.intensity = 6.0;
          obj.color.set(0x00ff88);
          obj.distance  = 16;
        }
      });

      // Check all missions complete → trigger success state
      if (_speciesScanned >= 5 && _pollutionDone >= 4 && _conduitDone) {
        setTimeout(function () { _setGameState(STATE.SUCCESS); }, 800);
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     _handleGaze(delta)
     Raycasts from left camera center. Builds the interactable candidate list
     from EntityManager.getInteractables() with fallback to _interactables.
     Filters already-completed entities. Accumulates gazeTime and fires
     _commitInteraction at GAZE_REQ seconds of cumulative dwell.

     STICKY TARGETING (grace buffer):
       _gazeLostTime counts up while no valid hit is found.
       Progress is NOT reset until _gazeLostTime exceeds GAZE_GRACE (0.65 s).
       This prevents fast-moving animals from clearing the scan bar on a single
       frame where they briefly dart outside the reticle or detection range.

     HIT RESOLVER (improved):
       1. Direct userData.faunaGroup / userData.terminalGroup pointer (fastest).
       2. Ancestor walk-up checking faunaGroup/terminalGroup at every level.
       3. Final walk-to-scene-root fallback for any typed group.
       This catches clownfish sub-groups, deeply-nested eel/manta meshes,
       and pollution meshes that may lack a direct pointer.
  ───────────────────────────────────────────────────────────────────────── */
  function _handleGaze(delta) {
    if (!_camL || !_scene) return;

    _raycaster.setFromCamera({ x: 0, y: 0 }, _camL);

    var candidateList = (window.ABYSS && window.ABYSS.EntityManager &&
                         ABYSS.EntityManager.getInteractables)
      ? ABYSS.EntityManager.getInteractables()
      : _interactables;

    var hits = _raycaster.intersectObjects(candidateList, true);

    var rigPos = (window.ABYSS && window.ABYSS._rigPosition) ? ABYSS._rigPosition : null;

    // ── Scan-lock radius update (same hysteresis as before) ───────────────
    var nearest = Infinity;
    if (rigPos && window.ABYSS.EntityManager && ABYSS.EntityManager.getRadarContacts) {
      var blips = ABYSS.EntityManager.getRadarContacts();
      for (var bi = 0; bi < blips.length; bi++) {
        var b = blips[bi];
        if (b.kind === 'shark') continue;
        var bd = Math.hypot(b.x - rigPos.x, b.y - rigPos.y, b.z - rigPos.z);
        if (bd < nearest) nearest = bd;
      }
    }
    var enterR = SCAN_RADIUS;
    var exitR  = SCAN_RADIUS + SCAN_HYSTERESIS;
    if (_scanLock) {
      _scanLock = nearest <= exitR;
    } else {
      _scanLock = nearest <= enterR;
    }
    if (!isFinite(nearest)) {
      _scanFalloff = 0;
    } else {
      _scanFalloff = 1 - Math.max(0, Math.min(1, (nearest - (SCAN_RADIUS - 6)) / 6));
    }

    // ── Hit resolver — multi-strategy ────────────────────────────────────
    // TUNE: maxScanDist — the distance gate for which a raycasted entity
    // is considered "in range" for dwelling. Uses SCAN_RADIUS when no lock,
    // SCAN_RADIUS*1.5 when lock is active (matches widened raycaster.far).
    var maxScanDist = _scanLock ? SCAN_RADIUS * 1.5 : enterR;

    var hit = null;
    if (hits.length > 0) {
      var obj = hits[0].object;
      var ud  = (obj && obj.userData) ? obj.userData : {};

      // Strategy 1: direct group pointer on the hit mesh
      if (ud.faunaGroup) {
        hit = ud.faunaGroup;
      } else if (ud.terminalGroup) {
        hit = ud.terminalGroup;
      } else if (ud.type === 'pollution' || ud.type === 'station') {
        hit = obj;
      } else {
        // Strategy 2: walk up hierarchy checking faunaGroup/terminalGroup
        // at each ancestor. Fixes clownfish sub-groups and manta children
        // that may lack the direct pointer but have a typed ancestor.
        var walker = obj;
        while (walker && walker !== _scene) {
          var wu = walker.userData;
          if (wu) {
            if (wu.faunaGroup)    { hit = wu.faunaGroup;    break; }
            if (wu.terminalGroup) { hit = wu.terminalGroup; break; }
            if (wu.type === 'pollution' || wu.type === 'station') { hit = walker; break; }
            if (wu.type === 'fauna' || wu.type === 'terminal')    { hit = walker; break; }
          }
          walker = walker.parent;
        }
      }

      // Strategy 3: if still null — final walk-to-scene-root fallback
      if (!hit) {
        var p = obj;
        while (p.parent && p.parent !== _scene) { p = p.parent; }
        if (p && p.userData && p.userData.type) hit = p;
      }
    }

    // ── Filter already-completed targets ─────────────────────────────────
    if (hit && hit.userData && hit.userData.type) {
      var hud = hit.userData;
      if (hud.type === 'fauna'     && hud.scanned)   hit = null;
      if (hud.type === 'pollution' && hud.collected)  hit = null;
      if (hud.type === 'terminal'  && hud.id === 'power_conduit' && _conduitDone) hit = null;
      if (hud.type === 'terminal'  && hud.id === 'o2_refill'     && hud.cooldown) hit = null;
      if (hud.type === 'station'   && _stationDone)  hit = null;
    } else {
      hit = null;
    }

    // ── Distance guard ────────────────────────────────────────────────────
    // Uses hit.position (group/mesh origin). For large entities like the manta
    // ray, the group origin IS the live animated position (mutated each frame
    // in entities.js update). maxScanDist is wider when scan lock is active.
    if (hit && rigPos) {
      var hp    = hit.position;
      var hdist = Math.hypot(hp.x - rigPos.x, hp.y - rigPos.y, hp.z - rigPos.z);
      if (hdist > maxScanDist) hit = null;
    }

    // ── Dwell accumulation with grace buffer ──────────────────────────────
    // [CHANGED] Previous behaviour: any frame with hit===null instantly cleared
    //   _gazeTime → 0, forcing a full restart.
    // [NEW] A GAZE_GRACE second grace window is allowed before the bar resets.
    //   Fast-swimming fauna can briefly exit the reticle without clearing progress.
    if (hit) {
      // Valid hit this frame — reset the lost-gaze timer
      _gazeLostTime = 0;

      if (_gazeTarget !== hit) {
        // Switched to a new target — reset dwell clock
        _gazeTarget  = hit;
        _gazeTime    = 0;
      }
      _gazeTime    += delta;
      _gazeProgress = Math.min(1, _gazeTime / GAZE_REQ);
      // Publish gaze progress so controls.js can apply scan-assist slowdown
      if (window.ABYSS) window.ABYSS._gazeProgress = _gazeProgress;

      if (_gazeTime >= GAZE_REQ) {
        _commitInteraction(hit);
        _gazeTarget   = null;
        _gazeTime     = 0;
        _gazeProgress = 0;
        _gazeLostTime = 0;
      }
    } else if (_gazeTarget !== null) {
      // No valid hit — increment lost-gaze timer
      _gazeLostTime += delta;

      if (_gazeLostTime < GAZE_GRACE) {
        // Within grace window: hold progress, don't reset.
        // _gazeTime is not incremented during the grace window (no reward for
        // darting out), but existing progress is preserved.
        // _gazeProgress stays at its last value so the arc stays visible.
      } else {
        // Grace expired — full reset
        _gazeTarget   = null;
        _gazeTime     = 0;
        _gazeProgress = 0;
        _gazeLostTime = 0;
        if (window.ABYSS) window.ABYSS._gazeProgress = 0;
      }
    } else {
      // No current target and no previous target — stay at zero
      _gazeTime     = 0;
      _gazeProgress = 0;
      _gazeLostTime = 0;
      if (window.ABYSS) window.ABYSS._gazeProgress = 0;
    }
  }


  /* ─────────────────────────────────────────────────────────────────────────
     MAIN GAME LOOP
  ───────────────────────────────────────────────────────────────────────── */
  function _loop(ts) {
    requestAnimationFrame(_loop);

    var delta = Math.min(_clock.getDelta(), 0.05);

    if (_state === STATE.PLAYING) {
      var t = _clock.getElapsedTime();

      // Module updates
      if (window.ABYSS && window.ABYSS.Controls && ABYSS.Controls.update)
        ABYSS.Controls.update(delta);
      if (window.ABYSS && window.ABYSS.EnvironmentBuilder && ABYSS.EnvironmentBuilder.update)
        ABYSS.EnvironmentBuilder.update(t);
      if (window.ABYSS && window.ABYSS.EntityManager && ABYSS.EntityManager.update)
        ABYSS.EntityManager.update(t, delta);

      // Hand Tracking Translation
      if (window.ABYSS && window.ABYSS.HandTracker && window.ABYSS.HandTracker.HandMotion) {
        var hm = window.ABYSS.HandTracker.HandMotion;
        window._smoothedThrust = window._smoothedThrust || 0;
        var targetThrust = hm.isMoving ? (hm.thrust > 0 ? hm.thrust : 1.0) : 0.0;
        // Lerp thrust for smooth fluid drag
        window._smoothedThrust += (targetThrust - window._smoothedThrust) * (delta * 2.5);
        
        if (window._smoothedThrust > 0.01) {
          var forwardDirection = new THREE.Vector3();
          _camL.getWorldDirection(forwardDirection);
          var swimSpeed = 0.0; // Disabled: locomotion handled entirely by controls.js (CRUISE_SPEED = 2.8)
          _rig.position.addScaledVector(forwardDirection, swimSpeed * window._smoothedThrust * delta);
          
          // Clamp to depth bounds
          _rig.position.y = Math.max(FLOOR_Y + 1.5, Math.min(SURFACE_Y, _rig.position.y));
        }
      }

      _handleGaze(delta);

      // O₂ drain — depth scale + scan dwell + shark proximity
      var rigY = _rig ? _rig.position.y : 0;
      var depthNorm = Math.max(0, Math.min(1, (SURFACE_Y - rigY) / DEPTH_RANGE));
      var drainRate = O2_DRAIN_BASE * (1 + depthNorm * O2_DEPTH_EXTRA);
      if (window.ABYSS && window.ABYSS._sharkNear) drainRate *= O2_SHARK_MULT;
      if (_gazeProgress > 0) drainRate += O2_DRAIN_SCAN;
      _oxygen -= drainRate * delta;
      _oxygen  = Math.max(0, _oxygen);

      // Shark proximity audio alert — throttled to every 4 seconds
      if (window.ABYSS && window.ABYSS._sharkNear && ts - _lastSharkAlert > 4000) {
        _lastSharkAlert = ts;
        _audio('playProximityAlert');
      }

      // Win condition: fauna + pollution + conduit + station all done
      if (_speciesScanned >= 5 && _pollutionDone >= 4 && _conduitDone && _stationDone) {
        _setGameState(STATE.SUCCESS);
        return;
      }
      // Death condition: O₂ depleted
      if (_oxygen <= 0) {
        _setGameState(STATE.DEAD);
        return;
      }

    } else if (_state === STATE.SUCCESS || _state === STATE.DEAD) {
      // Keep environment + entity animations running on end screens
      var tf = _clock.getElapsedTime();
      if (window.ABYSS && window.ABYSS.EnvironmentBuilder && ABYSS.EnvironmentBuilder.update)
        ABYSS.EnvironmentBuilder.update(tf);
      if (window.ABYSS && window.ABYSS.EntityManager && ABYSS.EntityManager.update)
        ABYSS.EntityManager.update(tf, delta);
    }

    if (_scene && _camL) _render();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     STATE MACHINE
  ───────────────────────────────────────────────────────────────────────── */
  function _setGameState(newState) {
    _state = newState;
    window.ABYSS._gameState = newState;

    var overlay = document.getElementById('endOverlay');
    var eyebrow = document.getElementById('endEyebrow');
    var titleEl = document.getElementById('endTitle');
    var msgEl   = document.getElementById('endMsg');

    if (newState === STATE.SUCCESS) {
      _audio('playVictory');
      if (eyebrow) eyebrow.textContent = 'MISSION COMPLETE';
      if (titleEl) { titleEl.textContent = 'STATION ONLINE'; titleEl.style.color = '#00ffcc'; }
      if (msgEl)   msgEl.textContent = 'The research station is now operational. Your survey data will protect this ecosystem for generations.';
      if (overlay) overlay.classList.remove('hidden');

    } else if (newState === STATE.DEAD) {
      if (eyebrow) eyebrow.textContent = 'OXYGEN DEPLETED';
      if (titleEl) { titleEl.textContent = 'DIVER DOWN'; titleEl.style.color = '#ff4444'; }
      if (msgEl)   msgEl.textContent = 'You ran out of air before completing the mission. The ocean still needs you.';
      if (overlay) overlay.classList.remove('hidden');
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SCENE SETUP — environment + entities
  ───────────────────────────────────────────────────────────────────────── */
  function _buildWorld() {
    var stationResult = null;
    if (window.ABYSS && window.ABYSS.EnvironmentBuilder && ABYSS.EnvironmentBuilder.build) {
      stationResult = ABYSS.EnvironmentBuilder.build(_scene);
    }

    if (window.ABYSS && window.ABYSS.EntityManager && ABYSS.EntityManager.buildAll) {
      ABYSS.EntityManager.buildAll(_scene);
      _interactables = ABYSS.EntityManager.getInteractables();
    } else {
      _interactables = [];
    }

    // Register environment-built airlock and conduit into EntityManager interactables
    if (stationResult) {
      if (stationResult.airlock) {
        stationResult.airlock.name = 'station_airlock';
        if (_interactables.indexOf(stationResult.airlock) === -1) {
          _interactables.push(stationResult.airlock);
          if (window.ABYSS && window.ABYSS.EntityManager) {
            ABYSS.EntityManager.getInteractables().push(stationResult.airlock);
          }
        }
      }
      if (stationResult.conduit) {
        if (window.ABYSS && window.ABYSS.EntityManager &&
            ABYSS.EntityManager.registerConduit) {
          ABYSS.EntityManager.registerConduit(stationResult.conduit);
        }
        if (_interactables.indexOf(stationResult.conduit) === -1) {
          _interactables.push(stationResult.conduit);
        }
      }
    }

    // Task 4: Boundary Clamping
    var maxRadius = 50;
    window.ABYSS.BOUNDS = {
      minX: -maxRadius - 15,
      maxX: maxRadius + 15,
      minZ: -maxRadius - 15,
      maxZ: maxRadius + 15
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     START GAME — called from Dive In button gesture handler
  ───────────────────────────────────────────────────────────────────────── */
  function _startGame() {
    if (window.ABYSS && window.ABYSS.Audio) {
      if (ABYSS.Audio.init)            ABYSS.Audio.init();
      if (ABYSS.Audio.resume)          ABYSS.Audio.resume();
      if (ABYSS.Audio.startOceanHum)   ABYSS.Audio.startOceanHum();
      if (ABYSS.Audio.startBubbleLoop) ABYSS.Audio.startBubbleLoop();
    } else if (window.SoundSystem) {
      if (SoundSystem.init)            SoundSystem.init();
      if (SoundSystem.resume)          SoundSystem.resume();
      if (SoundSystem.startOceanHum)   SoundSystem.startOceanHum();
      if (SoundSystem.startBubbleLoop) SoundSystem.startBubbleLoop();
    }

    if (_scene && _rig) {
      try {
        _scene.add(_rig);
      } catch (e) { console.warn("Scene attach failed", e); }
    }
    
    try {
      if (typeof _buildWorld === 'function') _buildWorld();
    } catch (e) {
      console.warn("Entity generation failed:", e);
    }

    if (_clock) _clock.start();
    _setGameState(STATE.PLAYING);

    var startOv = document.getElementById('overlay');
    if (startOv) {
      startOv.style.transition = 'opacity 0.9s';
      startOv.style.opacity    = '0';
      setTimeout(function () { startOv.classList.add('hidden'); }, 900);
    }
    
    // Reveal game HUD
    var gameHud = document.getElementById('game-hud');
    if (gameHud) {
      gameHud.style.display = 'block';
      gameHud.style.setProperty('display', 'block', 'important');
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RESET — zero-allocation in-place reset between sessions.
     Preserves localStorage ABYSS_* keys per backward-compat contract.
  ───────────────────────────────────────────────────────────────────────── */
  function _reset() {
    _oxygen         = OXYGEN_SECS;
    _speciesScanned = 0;
    _pollutionDone  = 0;
    _conduitDone    = false;
    _stationDone    = false;
    _o2RefillDone   = false;
    _specimensDone  = 0;
    _wasteDone      = false;
    _gazeTarget     = null;
    _gazeTime       = 0;
    _gazeProgress   = 0;
    _scanLock       = false;
    _scanFalloff    = 0;
    _lastSharkAlert = 0;
    _o2Terminal     = null;
    window.ABYSS._sharkNear    = false;
    window.ABYSS._gazeProgress = 0;   // clear scan-assist bridge for fresh session

    // In-place entity reset (re-shows pollution, resets eel phases etc.)
    if (window.ABYSS && window.ABYSS.EntityManager && ABYSS.EntityManager.reset) {
      ABYSS.EntityManager.reset();
      _interactables = ABYSS.EntityManager.getInteractables();
    }

    // Reset station / conduit PointLight intensities
    if (_scene) {
      _scene.traverse(function (obj) {
        if (obj.isPointLight && obj.intensity > 4.0) {
          obj.intensity = 2.2;
          obj.color.set(0x00aaff);
          obj.distance  = 10;
        }
      });

      var airlock = _scene.getObjectByName('station_airlock');
      if (airlock && _interactables.indexOf(airlock) === -1) {
        _interactables.push(airlock);
      }
    }

    // Set player position just above seabed
    var seabedY = -8.0; // base height
    if (window.ABYSS && window.ABYSS.EnvironmentBuilder && ABYSS.EnvironmentBuilder.getElevation) {
      seabedY = ABYSS.EnvironmentBuilder.getElevation(0, 0);
    }
    const EYE_HEIGHT_OFFSET = 2.2;
    _rig.position.set(0, seabedY + EYE_HEIGHT_OFFSET, 0);

    // Re-init controls rig references
    if (window.ABYSS && window.ABYSS.Controls && ABYSS.Controls.init) {
      ABYSS.Controls.init(_rig, _pitchObj);
    }

    _clock.start();

    var endOverlay = document.getElementById('endOverlay');
    if (endOverlay) endOverlay.classList.add('hidden');
    _setGameState(STATE.PLAYING);

    if (window.ABYSS && window.ABYSS.Audio && ABYSS.Audio.startBubbleLoop) {
      ABYSS.Audio.startBubbleLoop();
    } else if (window.SoundSystem && SoundSystem.startBubbleLoop) {
      SoundSystem.startBubbleLoop();
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RESIZE HANDLER
  ───────────────────────────────────────────────────────────────────────── */
  function _onResize() {
    _W = window.innerWidth || 800;
    _H = window.innerHeight || 600;

    if (_renderer) _renderer.setSize(_W, _H);

    var aspect = (_W / 2) / _H;
    if (_camL) { _camL.aspect = aspect; _camL.updateProjectionMatrix(); }
    if (_camR) { _camR.aspect = aspect; _camR.updateProjectionMatrix(); }

    if (_hud) {
      _hud.width  = _W || 800;
      _hud.height = _H || 600;
    }
  }

  /* -------------------------------------------------------------------------
     BOOTSTRAP � DOMContentLoaded
  ------------------------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', function () {
    /* -- DIVE IN button (Attach Early) -- */
    var diveBtn = document.getElementById('diveBtn');
    if (diveBtn) {
      function requestDeviceFullscreen() {
        var docEl = document.documentElement;
        var requestFS = docEl.requestFullscreen || 
                        docEl.webkitRequestFullscreen || 
                        docEl.mozRequestFullScreen || 
                        docEl.msRequestFullscreen;

        if (requestFS && !document.fullscreenElement) {
          requestFS.call(docEl).catch(function(err) {
            console.warn("Fullscreen request error:", err);
          });
        }

        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').catch(function(err) {
            console.warn("Orientation lock not supported or allowed:", err);
          });
        }
      }

      function handleDiveIn() {
        requestDeviceFullscreen();
        try {
          // 1. Instant UI Transition
          var startOv = document.getElementById('overlay');
          if (startOv) {
            startOv.style.setProperty('display', 'none', 'important');
          }
          var gameHud = document.getElementById('game-hud');
          if (gameHud) {
            gameHud.style.display = 'block';
            gameHud.style.setProperty('display', 'block', 'important');
          }

          // 2. Start Game Loop Immediately
          _startGame();

          // 3. AudioContext unlock (must be inside user gesture)
          if (window.ABYSS && window.ABYSS.Audio && ABYSS.Audio.init) {
            ABYSS.Audio.init();
            if (ABYSS.Audio.resume) ABYSS.Audio.resume();
          } else if (window.SoundSystem && SoundSystem.init) {
            SoundSystem.init();
            if (SoundSystem.resume) SoundSystem.resume();
          }

          // 4. Wake lock (Non-blocking)
          if (navigator.wakeLock) {
            navigator.wakeLock.request('screen').then(function (wl) {
              window._wakeLock = wl;
              document.addEventListener('visibilitychange', function () {
                if (document.visibilityState === 'visible' && navigator.wakeLock) {
                  navigator.wakeLock.request('screen').then(function (w) {
                    window._wakeLock = w;
                  }).catch(function () {});
                }
              });
            }).catch(function () {});
          }

          // 5. Disable pointer drag
          if (window.ABYSS && window.ABYSS.Controls && ABYSS.Controls.disablePointerDrag) {
            ABYSS.Controls.disablePointerDrag();
          }

          // 6. Asynchronous Hand Tracking & Camera Initialization
          setTimeout(async function () {
            try {
              if (window.ABYSS && window.ABYSS.HandTracker) {
                if (ABYSS.HandTracker.startRearCamera) {
                  await ABYSS.HandTracker.startRearCamera();
                }
                if (ABYSS.HandTracker.setupHandTracker) {
                  ABYSS.HandTracker.setupHandTracker();
                }
              }
            } catch (e) {
              console.warn("Camera/Vision init failed, falling back to standard controls:", e);
            }
          }, 0);

          // 7. Request Gyro (Non-blocking)
          if (window.ABYSS && window.ABYSS.Controls && ABYSS.Controls.requestGyro) {
            ABYSS.Controls.requestGyro().catch(function () {});
          }
        } catch (err) {
          console.error("Critical error during DIVE IN transition:", err);
        }
      }

      diveBtn.addEventListener('click', handleDiveIn);
      diveBtn.addEventListener('touchend', function (e) {
        e.preventDefault(); // Prevent ghost click
        handleDiveIn();
      });
    }

    /* -- RESTART button (Attach Early) -- */
    var restartBtn = document.getElementById('restartBtn');
    if (restartBtn) {
      restartBtn.addEventListener('click', function () {
        window.location.reload();
      });
    }

    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0x041a2e);

    try {
      _initRenderer();
    } catch (e) { console.error("Renderer init failed:", e); }

    try {
      _initHUD();
    } catch (e) { console.error("HUD init failed:", e); }

    try {
      _initBgParticles();
    } catch (e) { console.error("BgParticles init failed:", e); }

    if (_rig && _pitchObj) {
      try {
        if (window.ABYSS && window.ABYSS.Controls && ABYSS.Controls.init) {
          ABYSS.Controls.init(_rig, _pitchObj);
        }
      } catch (e) { console.error("Controls init failed:", e); }

      _attachTorch();
    } else {
      console.warn("Rig or PitchObj not ready. Skipping controls and torch attach.");
    }

    _lastTS = performance.now();
    requestAnimationFrame(_loop);

    // Hide loading spinner quickly
    var lo = document.getElementById('loadingOverlay');
    if (lo) setTimeout(function () { lo.style.display = 'none'; }, 380);

    window.addEventListener('resize', _onResize);
  });

}());