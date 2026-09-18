/* =============================================================================
   ABYSS: Marine Explorer — js/main.js  v5
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

  // O₂ system — 180s baseline, 2× drain when shark within 12u
  var _oxygen        = 180;
  var OXYGEN_SECS    = 180;
  var O2_DRAIN_BASE  = 1.0;   // units/sec
  var O2_DRAIN_SHARK = 2.0;   // units/sec when _sharkNear

  // Mission counters
  var _speciesScanned  = 0;     // 0..5
  var _pollutionDone   = 0;     // 0..4
  var _conduitDone     = false;
  var _stationDone     = false;
  var _o2RefillDone    = false; // O2_REFILL terminal — counted toward success
  var _specimensDone   = 0;     // specimens deposited into SPECIMEN_DEPOSIT
  var _wasteDone       = false; // WASTE_DISPOSAL hatch opened

  // Gaze / dwell — 2.0s required
  var _gazeTarget   = null;
  var _gazeTime     = 0;
  var _gazeProgress = 0;
  var GAZE_REQ      = 2.0;   // seconds dwell required
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
      cv.width  = window.innerWidth;
      cv.height = window.innerHeight;
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
    _W = window.innerWidth;
    _H = window.innerHeight;

    var canvas = document.getElementById('vrCanvas');
    _renderer  = new THREE.WebGLRenderer({
      canvas:           canvas,
      antialias:        false,
      powerPreference:  'high-performance'
    });
    _renderer.autoClear          = false;
    _renderer.shadowMap.enabled  = false;
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    _renderer.setSize(_W, _H);

    _clock     = new THREE.Clock();
    _raycaster = new THREE.Raycaster();
    _raycaster.far = 60;

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

    // Force world matrices so Controls.init → cameraL.getWorldDirection() is valid
    // on the very first frame before the game loop begins.
    _camL.updateMatrixWorld();
    _camR.updateMatrixWorld();

    // Init controls — MUST pass cameraL as third arg.
    // cameraL.getWorldDirection() is the sole source of head steering direction.
    // pitchObject is zeroed by the gyro pipeline; never apply rotation to it externally.
    if (window.ABYSS && window.ABYSS.Controls && ABYSS.Controls.init) {
      window.ABYSS.Controls.init(_rig, _pitchObj, _camL);
    }
  }

  function _updateCameraAspect() {
    _W = window.innerWidth;
    _H = window.innerHeight;
    var aspect = (_W / 2) / _H;
    if (_camL) { _camL.aspect = aspect; _camL.fov = 80; _camL.updateProjectionMatrix(); }
    if (_camR) { _camR.aspect = aspect; _camR.fov = 80; _camR.updateProjectionMatrix(); }
    if (_renderer) _renderer.setSize(_W, _H);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     DIVE TORCH + HELMET GLOW
  ───────────────────────────────────────────────────────────────────────── */
  function _attachTorch() {
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
    _hud        = document.getElementById('hudCanvas');
    _hctx       = _hud.getContext('2d');
    _hud.width  = _W;
    _hud.height = _H;
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
    var oxyLow = oxyPct <= 0.167;   // below ~30s
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

    /* ─── TOP-LEFT: O₂ BAR ─────────────────────────────────────── */
    var fsz  = Math.max(10, Math.round(eyeW * 0.019));
    var barW = Math.round(eyeW * 0.28);
    var barH = 12;
    var barX = ox + 14;
    var barY = 16;

    // Colour: green → amber → pulsing red
    var oxyColor;
    if (oxyLow) {
      oxyColor = (Math.sin(t * 6) > 0) ? '#ff4444' : '#ff0000';
    } else if (oxyPct <= 0.334) {
      oxyColor = '#ffaa00';
    } else {
      oxyColor = '#00ffcc';
    }

    ctx.font      = 'bold ' + fsz + 'px "Share Tech Mono",monospace';
    ctx.fillStyle = oxyColor;
    ctx.textAlign = 'left';
    ctx.fillText('\u2B21 O\u2082', barX, barY + barH - 1);

    var labelW = ctx.measureText('\u2B21 O\u2082  ').width;
    var trackX = barX + labelW;

    // Track background
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    _roundRect(ctx, trackX, barY, barW, barH, 3);
    ctx.fill();

    // Filled bar segment
    if (oxyPct > 0) {
      if (oxyLow) { ctx.shadowBlur = 12; ctx.shadowColor = oxyColor; }
      ctx.fillStyle = oxyColor;
      _roundRect(ctx, trackX + 2, barY + 2,
        Math.max(0, (barW - 4) * oxyPct), barH - 4, 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Percentage readout
    ctx.fillStyle = oxyLow ? oxyColor : 'rgba(255,255,255,0.82)';
    ctx.fillText(Math.ceil(oxyPct * 100) + '%', trackX + barW + 6, barY + barH - 1);

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

    // Outer static ring — brightens when gazing at interactive target
    ctx.strokeStyle = _gazeProgress > 0 ? '#00ffcc' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth   = _gazeProgress > 0 ? 2.5 : 1.5;
    if (_gazeProgress > 0) { ctx.shadowBlur = 14; ctx.shadowColor = '#00ffcc'; }
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

    /* ─── BOTTOM: MISSION CHECKLIST ───────────────────────────── */
    var mFsz  = Math.max(9, Math.round(eyeW * 0.015));
    var mX    = ox + 14;
    var mBotY = eyeH - 14;

    var missions = [
      { label: 'FAUNA CATALOG (5 species)',    done: _speciesScanned >= 5,  count: _speciesScanned + '/5' },
      { label: 'POLLUTION RETRIEVAL (4)',       done: _pollutionDone  >= 4,  count: _pollutionDone  + '/4' },
      { label: 'POWER CONDUIT ACTIVATED',       done: _conduitDone,          count: _conduitDone    ? '1/1' : '0/1' },
      { label: 'O\u2082 REFILL STATION',        done: _o2RefillDone,         count: _o2RefillDone   ? '1/1' : '0/1' },
      { label: 'SPECIMEN DEPOSIT',              done: _specimensDone >= 1,   count: _specimensDone  + '/1' },
      { label: 'WASTE DISPOSAL HATCH',          done: _wasteDone,            count: _wasteDone      ? '1/1' : '0/1' },
      { label: 'AIRLOCK PRESSURIZED',           done: _stationDone,          count: _stationDone    ? '1/1' : '0/1' }
    ];

    var lineStep = mFsz + 5;
    var panelH   = missions.length * lineStep + 10;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    _roundRect(ctx, mX - 4, mBotY - panelH - 2, eyeW * 0.52, panelH + 6, 5);
    ctx.fill();

    ctx.font      = 'bold ' + mFsz + 'px "Share Tech Mono",monospace';
    ctx.textAlign = 'left';
    missions.forEach(function (m, mi) {
      var lineY = mBotY - (missions.length - 1 - mi) * lineStep;
      var icon  = m.done ? '\u2713' : '\u25CB';
      var col   = m.done ? '#00ff88' : 'rgba(178,235,242,0.75)';
      if (!m.done && m.label.indexOf('SHARK') !== -1 && window.ABYSS && window.ABYSS._sharkNear) {
        col = '#ff4444';
      }
      ctx.fillStyle = col;
      ctx.fillText(icon + ' ' + m.label + '  ' + m.count, mX, lineY);
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     _drawHUDFrame — clear full canvas + render both eye viewports
  ───────────────────────────────────────────────────────────────────────── */
  function _drawHUDFrame() {
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

    // Left eye
    _drawEyeHUD(_hctx, 0,      _W / 2, _H);
    // Right eye
    _drawEyeHUD(_hctx, _W / 2, _W / 2, _H);

    // Centre nose-bridge separator
    _hctx.strokeStyle = 'rgba(0,255,204,0.08)';
    _hctx.lineWidth   = 1;
    _hctx.beginPath();
    _hctx.moveTo(_W / 2, 0);
    _hctx.lineTo(_W / 2, _H);
    _hctx.stroke();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SCISSOR RENDER — side-by-side stereoscopic pass
     renderer.autoClear=false → clear once, two scissor/viewport passes.
  ───────────────────────────────────────────────────────────────────────── */
  function _render() {
    var halfW = Math.floor(_W / 2);
    _renderer.clear();

    _renderer.setScissorTest(true);

    // Left eye
    _renderer.setScissor(0, 0, halfW, _H);
    _renderer.setViewport(0, 0, halfW, _H);
    _renderer.render(_scene, _camL);

    // Right eye
    _renderer.setScissor(halfW, 0, halfW, _H);
    _renderer.setViewport(halfW, 0, halfW, _H);
    _renderer.render(_scene, _camR);

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
     _commitInteraction at the 2.0s dwell mark. Resets arc immediately on
     gaze leave — no DOM mutation.
  ───────────────────────────────────────────────────────────────────────── */
  function _handleGaze(delta) {
    if (!_camL || !_scene) return;

    _raycaster.setFromCamera({ x: 0, y: 0 }, _camL);

    var candidateList = (window.ABYSS && window.ABYSS.EntityManager &&
                         ABYSS.EntityManager.getInteractables)
      ? ABYSS.EntityManager.getInteractables()
      : _interactables;

    var hits = _raycaster.intersectObjects(candidateList, true);

    var hit = null;
    if (hits.length > 0) {
      var obj = hits[0].object;
      var ud  = (obj && obj.userData) ? obj.userData : {};

      if (ud.faunaGroup) {
        // Ray hit a mesh inside a fauna group — resolve to the group
        hit = ud.faunaGroup;
      } else if (ud.terminalGroup) {
        // Ray hit a mesh inside a terminal group — resolve to the group
        hit = ud.terminalGroup;
      } else if (ud.type === 'pollution' || ud.type === 'station') {
        hit = obj;
      } else {
        // Walk up the hierarchy to find a tagged group
        var p = obj;
        while (p.parent && p.parent !== _scene) { p = p.parent; }
        if (p && p.userData && p.userData.type) hit = p;
      }
    }

    // Filter out already-completed targets
    if (hit && hit.userData && hit.userData.type) {
      var hud = hit.userData;
      if (hud.type === 'fauna'     && hud.scanned)   hit = null;
      if (hud.type === 'pollution' && hud.collected)  hit = null;
      if (hud.type === 'terminal'  && hud.id === 'power_conduit'   && _conduitDone) hit = null;
      if (hud.type === 'terminal'  && hud.id === 'o2_refill'       && hud.cooldown) hit = null;
      if (hud.type === 'station'   && _stationDone)  hit = null;
    } else {
      hit = null;
    }

    if (hit) {
      if (_gazeTarget !== hit) {
        // New target — reset dwell clock
        _gazeTarget  = hit;
        _gazeTime    = 0;
      }
      _gazeTime    += delta;
      _gazeProgress = Math.min(1, _gazeTime / GAZE_REQ);

      if (_gazeTime >= GAZE_REQ) {
        _commitInteraction(hit);
        _gazeTarget   = null;
        _gazeTime     = 0;
        _gazeProgress = 0;
      }
    } else {
      // Gaze left — reset arc immediately (zero DOM dependency)
      _gazeTarget   = null;
      _gazeTime     = 0;
      _gazeProgress = 0;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     MAIN GAME LOOP
  ───────────────────────────────────────────────────────────────────────── */
  function _loop(ts) {
    requestAnimationFrame(_loop);

    var delta = Math.min((ts - _lastTS) / 1000, 0.05);   // cap at 50ms to prevent tunnelling
    _lastTS   = ts;

    if (_state === STATE.PLAYING) {
      var t = _clock.getElapsedTime();

      // 1. Update camera world matrices FIRST so Controls reads current frame direction
      if (_rig)  _rig.updateMatrixWorld();
      if (_camL) _camL.updateMatrixWorld();
      if (_camR) _camR.updateMatrixWorld();

      // 2. Update controls (samples cameraL direction internally)
      if (window.ABYSS && window.ABYSS.Controls && ABYSS.Controls.update)
        ABYSS.Controls.update(delta);

      // 3. Update entities, HUD, oxygen etc.
      if (window.ABYSS && window.ABYSS.EnvironmentBuilder && ABYSS.EnvironmentBuilder.update)
        ABYSS.EnvironmentBuilder.update(t);
      if (window.ABYSS && window.ABYSS.EntityManager && ABYSS.EntityManager.update)
        ABYSS.EntityManager.update(t, delta);

      _handleGaze(delta);

      // O₂ drain — doubled during shark proximity
      var drainRate = (window.ABYSS && window.ABYSS._sharkNear)
        ? O2_DRAIN_SHARK : O2_DRAIN_BASE;
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

    _scene.add(_rig);
    _buildWorld();
    _clock.start();
    _setGameState(STATE.PLAYING);

    // Fade out start overlay — CSS opacity transition, not material mutation
    var startOv = document.getElementById('overlay');
    if (startOv) {
      startOv.style.transition = 'opacity 0.9s';
      startOv.style.opacity    = '0';
      setTimeout(function () { startOv.classList.add('hidden'); }, 900);
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
    _lastSharkAlert = 0;
    _o2Terminal     = null;
    window.ABYSS._sharkNear = false;

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

    // Re-init controls rig references
    if (window.ABYSS && window.ABYSS.Controls && ABYSS.Controls.init) {
      ABYSS.Controls.init(_rig, _pitchObj, _camL);
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
    _updateCameraAspect();
    if (_hud) {
      _hud.width  = _W;
      _hud.height = _H;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BOOTSTRAP — DOMContentLoaded
  ───────────────────────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    _initRenderer();
    _initHUD();
    _initBgParticles();

    if (window.ABYSS && window.ABYSS.Controls && ABYSS.Controls.init) {
      ABYSS.Controls.init(_rig, _pitchObj, _camL);
    }

    _attachTorch();

    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0x041a2e);

    _lastTS = performance.now();
    requestAnimationFrame(_loop);

    // Hide loading spinner quickly
    var lo = document.getElementById('loadingOverlay');
    if (lo) setTimeout(function () { lo.style.display = 'none'; }, 380);

    /* ── DIVE IN button ─────────────────────────────────────────── */
    var diveBtn = document.getElementById('diveBtn') || document.getElementById('btn-start-vr');
    if (diveBtn) {
      diveBtn.addEventListener('click', function () {
        // Step 1: AudioContext unlock — must be first in gesture (iOS policy)
        if (window.ABYSS && window.ABYSS.Audio && ABYSS.Audio.init) {
          ABYSS.Audio.init();
        } else if (window.SoundSystem && SoundSystem.init) {
          SoundSystem.init();
        }

        // Step 2: Fullscreen
        document.documentElement.requestFullscreen().catch(function () {});

        // Step 3: Wake lock — prevent screen dim during Cardboard VR session
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

        // Step 4: Landscape orientation lock
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').catch(function () {});
        }

        // Step 5: Gyro permission (must be inside gesture handler on iOS 13+)
        var gyroPromise = (window.ABYSS && window.ABYSS.Controls &&
                          ABYSS.Controls.requestGyro)
          ? ABYSS.Controls.requestGyro()
          : Promise.resolve(false);

        // Step 6: Start game after gyro resolves (or times out)
        gyroPromise.then(function () {
          _startGame();
        }).catch(function () {
          _startGame();
        });
      });
    }

    /* ── RESTART button ─────────────────────────────────────────── */
    var restartBtn = document.getElementById('restartBtn');
    if (restartBtn) {
      restartBtn.addEventListener('click', function () {
        _reset();
      });
    }

    window.addEventListener('resize', _onResize);
  });

}());
