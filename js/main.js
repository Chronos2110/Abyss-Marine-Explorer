/* =============================================================================
   ABYSS: Marine Explorer — js/main.js
   MODULE 1, MODULE 3 & MODULE 5: Complete Stereoscopic Engine, Sonar Radar,
   In-VR Dwell Exit Pipeline, Settings IPD Manager & Gameplay Rebalance

   ARCHITECTURAL SPECIFICATION & SYSTEM CONTRACTS:
   1. Namespace & Settings Manager:
      - window.ABYSS.Settings with persistent ipdOffset (localStorage 'ABYSS_ipdOffset').
      - Dynamic adjustIPD(delta) adjusting cameraL/cameraR x offsets.
   2. Stereoscopic Optics & Scissor Pipeline:
      - Base IPD: 0.064m (±0.032m per eye + ipdOffset).
      - CAMERA_FOV: 75 degrees.
      - Dual-viewport render loop via WebGLRenderer scissor test:
          Left  : (0, 0, W / 2, H) for cameraL
          Right : (W / 2, 0, W / 2, H) for cameraR
      - Delta time clamped to 0.05s per frame (prevents simulation tunneling).
   3. Sonar Radar Canvas Rendering (Symmetrical Binocular Stereo):
      - Two distinct canvas contexts positioned at identical local view coordinates:
          Left eye panel  : bottom-right corner of left eye (bottom: 12px, left: calc(50% - 110px)).
          Right eye panel : bottom-right corner of right eye (bottom: 12px, right: 12px).
      - Scale: 90px diameter, identical margins, sweep data, and orientation heading.
      - drawSonar(ctx, playerPos, interactables, heading):
          Range: 35 units.
          Rotating phosphorescent green sweep line.
          Heading indicator needle.
          Color blips: Fauna = #00ccff, Pollution = #ff8800, Terminals/Base = #00ff66.
          Blips dynamically rotated by -heading so top matches forward gaze.
   4. In-VR Dwell Exit & Android Hardware Back Button:
      - "SURFACE / EXIT" dwell reticle at top-center of each eye display.
      - Dwell timer: 1.8 seconds continuous gaze (pitch >= 35° or direct gaze).
      - exitDiveSession():
          * Cancel animation frame.
          * Stop camera stream tracks via window.ABYSS.HandTracker?.stop().
          * Stop ambient audio via window.ABYSS.Audio?.stopAmbient().
          * Lock screen orientation to portrait mode.
          * Hide #vrCanvas, disable scissor test, and restore #startOverlay.
      - Capacitor hardware back button binding to exitDiveSession().
   5. Gameplay Rebalance & Dwell Scanning:
      - O2_DURATION: 300 seconds (5 minutes). Base drain = 100 / 300 per second (doubled near shark).
      - DWELL_SCAN_TIME: exactly 1.2 seconds.
      - Mission objectives:
          * 6 Marine Species scanned.
          * 6 Pollution Hazards cleared.
          * 2 Power Conduits restored.
          * Airlock docking trigger when all prior tasks are complete.
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     MODULE CONTRACT: window.ABYSS.Settings
  ───────────────────────────────────────────────────────────────────────── */
  var cameraL = null;
  var cameraR = null;

  window.ABYSS.Settings = {
    ipdOffset: parseFloat(localStorage.getItem('ABYSS_ipdOffset') ?? '0'),
    adjustIPD: function (delta) {
      this.ipdOffset = THREE.MathUtils.clamp(this.ipdOffset + delta, -0.016, 0.016);
      localStorage.setItem('ABYSS_ipdOffset', this.ipdOffset.toString());
      var half = 0.064 / 2 + this.ipdOffset;
      if (cameraL && cameraR) {
        cameraL.position.x = -half;
        cameraR.position.x = half;
      }
    }
  };

  /* ─────────────────────────────────────────────────────────────────────────
     STATE MACHINE & GAMEPLAY CONSTANTS
  ───────────────────────────────────────────────────────────────────────── */
  var STATE = { START: 'START', PLAYING: 'PLAYING', SUCCESS: 'SUCCESS', DEAD: 'DEAD' };
  var _state = STATE.START;
  var _isPaused = false;
  var _animId = null;

  // Stereoscopic Optical Constants
  var CAMERA_FOV = 75; // 75 degrees FOV

  // Gameplay Constants
  var O2_DURATION      = 300;               // 300 seconds (5 minutes)
  var O2_DRAIN_BASE    = 100 / O2_DURATION; // 100 / 300 = 0.3333... % per second
  var O2_DRAIN_SHARK   = O2_DRAIN_BASE * 2; // doubled within 12 units of shark
  var DWELL_SCAN_TIME  = 1.2;               // exactly 1.2 seconds matching CSS transition
  var EXIT_DWELL_TIME  = 1.8;               // 1.8 seconds continuous gaze for In-VR Surface / Exit

  // Depth Boundaries
  var FLOOR_Y     = -8;
  var SURFACE_Y   = 20;
  var DEPTH_RANGE = SURFACE_Y - FLOOR_Y; // 28 units -> 80m visual readout

  /* ─────────────────────────────────────────────────────────────────────────
     GLOBALS & ENGINE OBJECTS
  ───────────────────────────────────────────────────────────────────────── */
  var _renderer    = null;
  var _scene       = null;
  var _rig         = null;
  var _pitchObj    = null;
  var _clock       = null;
  var _raycaster   = null;
  var _W           = 0;
  var _H           = 0;
  var _worldBuilt  = false;
  var _lastTS      = 0;

  // Torch
  var _torch       = null;
  var _torchTarget = null;

  // HUD & Radar Canvases
  var _hud          = null;
  var _hctx         = null;
  var _sonarCanvasL = null;
  var _sonarCanvasR = null;
  var _sonarCtxL    = null;
  var _sonarCtxR    = null;

  // Dynamic Session State
  var _oxygen           = 100; // 0..100 %
  var _speciesScanned   = 0;   // 0..6
  var _pollutionDone    = 0;   // 0..6
  var _conduitsRestored = 0;   // 0..2
  var _stationDone      = false;
  var _o2RefillDone     = false;
  var _specimensDone    = 0;
  var _wasteDone        = false;
  var _o2Terminal       = null;
  var _lastSharkAlert   = 0;

  // Dwell Targeting
  var _gazeTarget       = null;
  var _gazeTime         = 0;
  var _gazeProgress     = 0;
  var _exitGazeTime     = 0;
  var _exitGazeProgress = 0;
  var _interactables    = [];

  // Launch state
  var _launched         = false;

  /* ─────────────────────────────────────────────────────────────────────────
     SCREEN ORIENTATION TRANSITION HELPER
  ───────────────────────────────────────────────────────────────────────── */
  async function _setOrientation(mode) {
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ScreenOrientation) {
        await window.Capacitor.Plugins.ScreenOrientation.lock({ orientation: mode });
        console.log('[ABYSS] Capacitor ScreenOrientation locked to:', mode);
        return;
      }
    } catch (err) {
      console.warn('[ABYSS] Capacitor ScreenOrientation.lock error:', err);
    }

    try {
      if (window.screen && window.screen.orientation && window.screen.orientation.lock) {
        var p = window.screen.orientation.lock(mode);
        if (p && p.catch) {
          p.catch(function (e) {
            console.warn('[ABYSS] screen.orientation.lock rejected:', e);
          });
        }
        console.log('[ABYSS] screen.orientation.lock set to:', mode);
      }
    } catch (err) {
      console.warn('[ABYSS] screen.orientation.lock fallback error:', err);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     START-SCREEN BACKGROUND PARTICLES
  ───────────────────────────────────────────────────────────────────────── */
  function _initBgParticles() {
    var cv = document.getElementById('bgParticles');
    if (!cv) return;
    var c = cv.getContext('2d');

    function resize() {
      cv.width = window.innerWidth;
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
      if (_state === STATE.PLAYING) return;
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
     RENDERER & STEREOSCOPIC DUAL-CAMERA PIPELINE
  ───────────────────────────────────────────────────────────────────────── */
  function _initRenderer() {
    _W = window.innerWidth;
    _H = window.innerHeight;

    var canvas = document.getElementById('vrCanvas');
    if (!canvas) return;

    if (!_renderer) {
      _renderer = new THREE.WebGLRenderer({
        canvas:          canvas,
        antialias:       false,
        powerPreference: 'high-performance'
      });
      _renderer.autoClear         = false;
      _renderer.shadowMap.enabled = false;

      _clock     = new THREE.Clock();
      _raycaster = new THREE.Raycaster();
      _raycaster.far = 60;

      _rig      = new THREE.Group();
      _pitchObj = new THREE.Group();
      _rig.add(_pitchObj);

      // Base IPD: 0.064m (±0.032m per eye, plus ipdOffset)
      var halfIPD = 0.064 / 2 + window.ABYSS.Settings.ipdOffset;
      var aspect  = (_W / 2) / _H;

      cameraL = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, 0.1, 500);
      cameraL.position.x = -halfIPD;
      _pitchObj.add(cameraL);

      cameraR = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, 0.1, 500);
      cameraR.position.x = halfIPD;
      _pitchObj.add(cameraR);

      _attachTorch();
    }

    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    _renderer.setSize(_W, _H);

    _updateCameraAspect();

    cameraL.updateMatrixWorld();
    cameraR.updateMatrixWorld();

    if (window.ABYSS && window.ABYSS.Controls && window.ABYSS.Controls.init) {
      window.ABYSS.Controls.init(_rig, _pitchObj, cameraL);
    }
  }

  function _updateCameraAspect() {
    _W = window.innerWidth;
    _H = window.innerHeight;
    var aspect = (_W / 2) / _H;

    if (cameraL) {
      cameraL.aspect = aspect;
      cameraL.fov    = CAMERA_FOV;
      cameraL.updateProjectionMatrix();
    }
    if (cameraR) {
      cameraR.aspect = aspect;
      cameraR.fov    = CAMERA_FOV;
      cameraR.updateProjectionMatrix();
    }
    if (_renderer) {
      _renderer.setSize(_W, _H);
    }
    if (_hud) {
      _hud.width  = _W;
      _hud.height = _H;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     DIVE TORCH & SUBSEA HELMET GLOW
  ───────────────────────────────────────────────────────────────────────── */
  function _attachTorch() {
    if (_torch || !_rig) return;

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

    var glow = new THREE.PointLight(0x00e5ff, 0.9, 8);
    glow.position.set(0, -0.5, 0);
    _rig.add(glow);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     HUD CANVAS INITIALIZATION
  ───────────────────────────────────────────────────────────────────────── */
  function _initHUD() {
    _hud = document.getElementById('hudCanvas');
    if (!_hud) return;
    _hctx       = _hud.getContext('2d');
    _hud.width  = window.innerWidth;
    _hud.height = window.innerHeight;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SONAR RADAR CANVAS SETUP (Two Distinct Canvas Contexts, Symmetrical Stereo)
     Left Eye Panel  : bottom-right of left 50%  (bottom: 12px, left: calc(50% - 110px))
     Right Eye Panel : bottom-right of right 50% (bottom: 12px, right: 12px)
     Scale: 90px diameter, identical binocular coordinates in both viewports.
  ───────────────────────────────────────────────────────────────────────── */
  function _initSonar() {
    _sonarCanvasL = document.getElementById('sonarCanvasL');
    if (!_sonarCanvasL) {
      _sonarCanvasL = document.createElement('canvas');
      _sonarCanvasL.id = 'sonarCanvasL';
      _sonarCanvasL.width = 90;
      _sonarCanvasL.height = 90;
      _sonarCanvasL.style.position = 'fixed';
      _sonarCanvasL.style.bottom = '12px';
      _sonarCanvasL.style.left = 'calc(50% - 110px)';
      _sonarCanvasL.style.width = '90px';
      _sonarCanvasL.style.height = '90px';
      _sonarCanvasL.style.pointerEvents = 'none';
      _sonarCanvasL.style.zIndex = '25';
      _sonarCanvasL.style.display = 'none';
      document.body.appendChild(_sonarCanvasL);
    } else {
      _sonarCanvasL.width = 90;
      _sonarCanvasL.height = 90;
      _sonarCanvasL.style.position = 'fixed';
      _sonarCanvasL.style.bottom = '12px';
      _sonarCanvasL.style.left = 'calc(50% - 110px)';
      _sonarCanvasL.style.width = '90px';
      _sonarCanvasL.style.height = '90px';
    }
    _sonarCtxL = _sonarCanvasL.getContext('2d');

    _sonarCanvasR = document.getElementById('sonarCanvasR');
    if (!_sonarCanvasR) {
      _sonarCanvasR = document.createElement('canvas');
      _sonarCanvasR.id = 'sonarCanvasR';
      _sonarCanvasR.width = 90;
      _sonarCanvasR.height = 90;
      _sonarCanvasR.style.position = 'fixed';
      _sonarCanvasR.style.bottom = '12px';
      _sonarCanvasR.style.right = '12px';
      _sonarCanvasR.style.width = '90px';
      _sonarCanvasR.style.height = '90px';
      _sonarCanvasR.style.pointerEvents = 'none';
      _sonarCanvasR.style.zIndex = '25';
      _sonarCanvasR.style.display = 'none';
      document.body.appendChild(_sonarCanvasR);
    } else {
      _sonarCanvasR.width = 90;
      _sonarCanvasR.height = 90;
      _sonarCanvasR.style.position = 'fixed';
      _sonarCanvasR.style.bottom = '12px';
      _sonarCanvasR.style.right = '12px';
      _sonarCanvasR.style.width = '90px';
      _sonarCanvasR.style.height = '90px';
    }
    _sonarCtxR = _sonarCanvasR.getContext('2d');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     drawSonar(ctx, playerPos, interactables, heading)
     - Range: 35 units.
     - Rotating phosphorescent green sweep line.
     - Heading indicator needle.
     - Color blips: Fauna = #00ccff, Pollution = #ff8800, Terminals/Base = #00ff66.
     - Blips dynamically rotated by -heading so top matches forward gaze.
  ───────────────────────────────────────────────────────────────────────── */
  function drawSonar(ctx, playerPos, interactables, heading) {
    if (!ctx) return;
    var w = ctx.canvas.width;
    var h = ctx.canvas.height;
    var cx = w / 2;
    var cy = h / 2;
    var radius = Math.min(cx, cy) - 4;
    var RADAR_RANGE = 35; // 35 units

    ctx.clearRect(0, 0, w, h);

    ctx.save();

    // Circular background
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(2, 16, 26, 0.85)';
    ctx.fill();

    // Concentric range rings
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.22)';
    ctx.lineWidth = 1;
    [0.33, 0.66, 1.0].forEach(function (f) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * f, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Crosshair quadrant lines
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // Rotating phosphorescent green sweep line
    var sweepSpeed = 2.0; // rad/s
    var now = performance.now() * 0.001;
    var sweepAngle = (now * sweepSpeed) % (Math.PI * 2);

    // Phosphorescent trailing wedge
    var tailAngle = 0.55;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, sweepAngle - tailAngle, sweepAngle, false);
    ctx.closePath();
    var sweepGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, radius);
    sweepGrad.addColorStop(0, 'rgba(0, 255, 102, 0.35)');
    sweepGrad.addColorStop(1, 'rgba(0, 255, 102, 0.02)');
    ctx.fillStyle = sweepGrad;
    ctx.fill();

    // Crisp sweep line
    var sx = cx + Math.cos(sweepAngle) * radius;
    var sy = cy + Math.sin(sweepAngle) * radius;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(sx, sy);
    ctx.strokeStyle = '#00ff66';
    ctx.lineWidth = 1.8;
    ctx.shadowColor = '#00ff66';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Outer rim border
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 255, 102, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Heading indicator needle (top needle pointing straight ahead at 12 o'clock)
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius - 2);
    ctx.lineTo(cx - 4, cy - radius + 7);
    ctx.lineTo(cx + 4, cy - radius + 7);
    ctx.closePath();
    ctx.fillStyle = '#00ff88';
    ctx.shadowColor = '#00ff88';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Player position pip
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Color blips dynamically rotated by -heading so top matches forward gaze
    if (Array.isArray(interactables) && playerPos) {
      var px = playerPos.x || 0;
      var pz = playerPos.z || 0;

      for (var i = 0; i < interactables.length; i++) {
        var item = interactables[i];
        if (!item || item.visible === false) continue;

        var ud = item.userData || {};
        if (ud.type === 'pollution' && ud.collected) continue;

        var ix = 0, iz = 0;
        if (item.getWorldPosition) {
          var _wp = new THREE.Vector3();
          item.getWorldPosition(_wp);
          ix = _wp.x;
          iz = _wp.z;
        } else if (item.position) {
          ix = item.position.x;
          iz = item.position.z;
        }

        var dx = ix - px;
        var dz = iz - pz;
        var dist = Math.hypot(dx, dz);
        if (dist > RADAR_RANGE || dist < 0.2) continue;

        // Angle in world: looking down -Z is angle 0
        var worldAngle = Math.atan2(dx, -dz);
        // Blips dynamically rotated by -heading
        var relAngle = worldAngle - heading;

        var distFraction = dist / RADAR_RANGE;
        var blipRadius   = distFraction * (radius - 5);
        var bx = cx + blipRadius * Math.sin(relAngle);
        var by = cy - blipRadius * Math.cos(relAngle);

        // Blip Color Palette: Fauna = #00ccff, Pollution = #ff8800, Terminals/Base = #00ff66
        var eType = ud.entityType || ud.type || '';
        var blipColor = '#00ccff'; // Fauna default
        if (eType === 'pollution') {
          blipColor = '#ff8800';
        } else if (eType === 'terminal' || eType === 'station' || ud.id === 'power_conduit' || ud.id === 'station_airlock') {
          blipColor = '#00ff66';
        } else if (eType === 'fauna') {
          blipColor = '#00ccff';
        }

        ctx.beginPath();
        ctx.arc(bx, by, 2.8, 0, Math.PI * 2);
        ctx.fillStyle = blipColor;
        ctx.shadowColor = blipColor;
        ctx.shadowBlur = 5;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    ctx.restore();
  }

  // Expose drawSonar on public API
  window.ABYSS.drawSonar = drawSonar;

  /* ─── Rounded Rect Helper ───────────────────────────────────────────────── */
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
    ctx.quadraticCurveTo(x, y + r, x + r, y);
    ctx.closePath();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     _drawEyeHUD — Dynamic Stereo HUD on hudCanvas
  ───────────────────────────────────────────────────────────────────────── */
  function _drawEyeHUD(ctx, ox, eyeW, eyeH) {
    var t = _clock ? _clock.getElapsedTime() : 0;
    var cx = ox + eyeW / 2;
    var cy = eyeH / 2;
    var oxyPct = Math.max(0, Math.min(1, _oxygen / 100));
    var oxyLow = oxyPct <= 0.15; // below ~45s
    var swimSt = (window.ABYSS && window.ABYSS.Controls && window.ABYSS.Controls.getSwimState)
      ? window.ABYSS.Controls.getSwimState() : 'HOVERING';
    var pitchDeg = (window.ABYSS && window.ABYSS.Controls && window.ABYSS.Controls.getPitchDeg)
      ? window.ABYSS.Controls.getPitchDeg().toFixed(1) : '--';

    /* ─── TOP-LEFT: O₂ BAR + STATUS ──────────────────────────── */
    var barW = Math.round(eyeW * 0.22);
    var barH = 7;
    var barX = ox + 14;
    var barY = 14;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    _roundRect(ctx, barX, barY, barW, barH, 3);
    ctx.fill();

    var o2Color;
    if (oxyLow) {
      var pulse = Math.sin(t * 8) * 0.5 + 0.5;
      o2Color = 'rgba(255,' + Math.round(50 + pulse * 60) + ',50,0.95)';
    } else if (oxyPct < 0.40) {
      o2Color = '#ffaa00';
    } else {
      o2Color = '#00ffcc';
    }

    var fillW = Math.max(0, Math.round(barW * oxyPct));
    if (fillW > 0) {
      ctx.fillStyle = o2Color;
      _roundRect(ctx, barX, barY, fillW, barH, 3);
      ctx.fill();
    }

    ctx.font = 'bold ' + Math.max(9, Math.round(eyeW * 0.016)) + 'px "Share Tech Mono",monospace';
    ctx.fillStyle = oxyLow ? '#ff4444' : 'rgba(0,255,204,0.9)';
    ctx.textAlign = 'left';
    var o2SecsRem = Math.ceil((_oxygen / 100) * O2_DURATION);
    ctx.fillText('O\u2082 ' + Math.ceil(oxyPct * 100) + '% (' + o2SecsRem + 's)', barX, barY + barH + 13);

    /* ─── TOP-RIGHT: DEPTH + PITCH READOUT ───────────────────── */
    var rawDepth = SURFACE_Y - (_rig ? _rig.position.y : 0);
    var depthM   = Math.max(0, Math.round((rawDepth / DEPTH_RANGE) * 80));

    ctx.font = 'bold ' + Math.max(9, Math.round(eyeW * 0.016)) + 'px "Share Tech Mono",monospace';
    ctx.fillStyle = 'rgba(0,255,204,0.9)';
    ctx.textAlign = 'right';
    var rightEdge = ox + eyeW - 14;
    ctx.fillText('DEPTH ' + depthM + 'm', rightEdge, barY + 11);

    ctx.font = Math.max(8, Math.round(eyeW * 0.013)) + 'px "Share Tech Mono",monospace';
    ctx.fillStyle = 'rgba(0,170,255,0.7)';
    ctx.fillText('PITCH ' + pitchDeg + '\u00B0', rightEdge, barY + 25);

    /* ─── SWIM STATE BADGE ───────────────────────────────────── */
    var stateY = barY + barH + 30;
    var stateCol = '#00ffcc';
    if (swimSt === 'DIVING')    stateCol = '#00aaff';
    if (swimSt === 'ASCENDING') stateCol = '#ffaa00';
    if (swimSt === 'HOVERING')  stateCol = 'rgba(255,255,255,0.45)';

    ctx.font = 'bold ' + Math.max(8, Math.round(eyeW * 0.014)) + 'px "Share Tech Mono",monospace';
    ctx.fillStyle = stateCol;
    ctx.textAlign = 'left';
    ctx.fillText(swimSt, barX, stateY);

    /* ─── SHARK PROXIMITY WARNING ────────────────────────────── */
    if (window.ABYSS && window.ABYSS._sharkNear) {
      var warnPulse = Math.sin(t * 10) * 0.5 + 0.5;
      ctx.font = 'bold ' + Math.max(9, Math.round(eyeW * 0.016)) + 'px "Share Tech Mono",monospace';
      ctx.fillStyle = 'rgba(255,60,60,' + (0.7 + warnPulse * 0.3) + ')';
      ctx.textAlign = 'left';
      ctx.fillText('\u26A0 SHARK PROXIMITY \u2014 2\u00D7 O\u2082 DRAIN', barX, stateY + 16);
    }

    /* ─── TOP-CENTER: IN-VR SURFACE / EXIT DWELL RETICLE ─────── */
    var exitX = ox + eyeW / 2;
    var exitY = 32;

    ctx.fillStyle = _exitGazeProgress > 0 ? 'rgba(255,50,50,0.45)' : 'rgba(0,0,0,0.55)';
    _roundRect(ctx, exitX - 74, exitY - 14, 148, 28, 6);
    ctx.fill();
    ctx.strokeStyle = _exitGazeProgress > 0 ? '#ff4444' : 'rgba(0,255,204,0.45)';
    ctx.lineWidth = _exitGazeProgress > 0 ? 2 : 1;
    ctx.stroke();

    ctx.font = 'bold ' + Math.max(9, Math.round(eyeW * 0.014)) + 'px "Share Tech Mono",monospace';
    ctx.fillStyle = _exitGazeProgress > 0 ? '#ffffff' : 'rgba(0,255,204,0.9)';
    ctx.textAlign = 'center';
    ctx.fillText('\u25B2 SURFACE / EXIT \u25B2', exitX, exitY + 4);

    if (_exitGazeProgress > 0) {
      ctx.strokeStyle = '#ff3333';
      ctx.lineWidth = 3;
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#ff3333';
      ctx.beginPath();
      ctx.arc(exitX + 58, exitY, 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * _exitGazeProgress);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    /* ─── CENTER: DWELL RETICLE + GAZE ARC (1.2s DWELL) ──────── */
    var rR = Math.round(eyeW * 0.030);

    // Outer ring
    ctx.strokeStyle = _gazeProgress > 0 ? '#00ffcc' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = _gazeProgress > 0 ? 2.5 : 1.5;
    if (_gazeProgress > 0) { ctx.shadowBlur = 14; ctx.shadowColor = '#00ffcc'; }
    ctx.beginPath();
    ctx.arc(cx, cy, rR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Center dot
    ctx.fillStyle = _gazeProgress > 0 ? 'rgba(0,255,204,0.95)' : 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.8, 0, Math.PI * 2);
    ctx.fill();

    // Crosshair ticks
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - rR - 10, cy); ctx.lineTo(cx - rR + 6, cy);
    ctx.moveTo(cx + rR - 6,  cy); ctx.lineTo(cx + rR + 10, cy);
    ctx.moveTo(cx, cy - rR - 10); ctx.lineTo(cx, cy - rR + 6);
    ctx.moveTo(cx, cy + rR - 6);  ctx.lineTo(cx, cy + rR + 10);
    ctx.stroke();

    // Dwell arc — 1.2s sweep
    if (_gazeProgress > 0) {
      ctx.strokeStyle = '#00ffcc';
      ctx.lineWidth   = 4;
      ctx.shadowBlur  = 20;
      ctx.shadowColor = '#00ffcc';
      ctx.beginPath();
      ctx.arc(cx, cy, rR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * _gazeProgress);
      ctx.stroke();
      ctx.shadowBlur = 0;

      var pctTxt = Math.ceil(_gazeProgress * 100) + '%';
      ctx.font = 'bold ' + Math.max(8, Math.round(eyeW * 0.012)) + 'px "Share Tech Mono",monospace';
      ctx.fillStyle = 'rgba(0,255,204,0.85)';
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
        eel:               'BIOLUM. MORAY EEL',
        octopus:           'REEF OCTOPUS',
        power_conduit:     'POWER CONDUIT \u2014 RESTORE',
        power_conduit_0:   'POWER CONDUIT #1 \u2014 RESTORE',
        power_conduit_1:   'POWER CONDUIT #2 \u2014 RESTORE',
        station_airlock:   'STATION AIRLOCK \u2014 DOCK',
        o2_refill:         'O\u2082 REFILL \u2014 INHALE',
        specimen_deposit:  'SPECIMEN DEPOSIT \u2014 STORE',
        waste_disposal:    'WASTE DISPOSAL \u2014 OPEN HATCH'
      };
      var lbl = '';
      var tud = _gazeTarget.userData;
      var tType = tud.entityType || tud.type;
      var tId   = tud.entityId || tud.id;

      if (tType === 'fauna') {
        lbl = LABELS[tud.species] || LABELS[tId] || 'SCANNING FAUNA';
      } else if (tType === 'pollution') {
        lbl = 'POLLUTION \u2014 COLLECT';
      } else if (tType === 'terminal') {
        lbl = LABELS[tId] || 'ACTIVATE TERMINAL';
      } else if (tType === 'station' || tId === 'station_airlock') {
        var priorComplete = (_speciesScanned >= 6 && _pollutionDone >= 6 && _conduitsRestored >= 2);
        lbl = priorComplete ? 'STATION AIRLOCK \u2014 DOCK' : 'AIRLOCK \u2014 OBJECTIVES REQUIRED';
      }

      if (lbl) {
        ctx.font = 'bold ' + Math.round(eyeW * 0.021) + 'px "Share Tech Mono",monospace';
        var lbW  = ctx.measureText(lbl).width + 28;
        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        _roundRect(ctx, cx - lbW / 2, cy + rR + 14, lbW, 30, 5);
        ctx.fill();

        var priorTasksOk = (_speciesScanned >= 6 && _pollutionDone >= 6 && _conduitsRestored >= 2);
        ctx.fillStyle = (tType === 'station' && !priorTasksOk) ? '#ffaa00' : '#00ffcc';
        ctx.textAlign = 'center';
        ctx.fillText(lbl, cx, cy + rR + 33);
      }
    }

    /* ─── BOTTOM: MISSION OBJECTIVES TRACKER ──────────────────── */
    var mFsz  = Math.max(9, Math.round(eyeW * 0.015));
    var mX    = ox + 14;
    var mBotY = eyeH - 14;

    ctx.font      = mFsz + 'px "Share Tech Mono",monospace';
    ctx.textAlign = 'left';

    var allPriorDone = (_speciesScanned >= 6 && _pollutionDone >= 6 && _conduitsRestored >= 2);
    var airlockReady = allPriorDone && !_stationDone;
    var m4Col = _stationDone ? 'rgba(0,255,204,0.95)' : (airlockReady ? '#00ff88' : 'rgba(255,255,255,0.45)');
    var m4Sym = _stationDone ? '[\u2713]' : (airlockReady ? '[\u25B6]' : '[ ]');
    var m4Txt = _stationDone ? 'STATION DOCKED' : (airlockReady ? 'AIRLOCK READY \u2014 DOCK' : 'STATION AIRLOCK');
    ctx.fillStyle = m4Col;
    ctx.fillText(m4Sym + ' ' + m4Txt, mX, mBotY);

    var cDone = _conduitsRestored >= 2;
    var m3Col = cDone ? 'rgba(0,255,204,0.95)' : 'rgba(255,255,255,0.45)';
    var m3Sym = cDone ? '[\u2713]' : '[ ]';
    ctx.fillStyle = m3Col;
    ctx.fillText(m3Sym + ' CONDUITS: ' + Math.min(2, _conduitsRestored) + '/2', mX, mBotY - (mFsz + 4));

    var pDone = _pollutionDone >= 6;
    var m2Col = pDone ? 'rgba(0,255,204,0.95)' : 'rgba(255,255,255,0.45)';
    var m2Sym = pDone ? '[\u2713]' : '[ ]';
    ctx.fillStyle = m2Col;
    ctx.fillText(m2Sym + ' POLLUTION: ' + Math.min(6, _pollutionDone) + '/6', mX, mBotY - (mFsz + 4) * 2);

    var fDone = _speciesScanned >= 6;
    var m1Col = fDone ? 'rgba(0,255,204,0.95)' : 'rgba(255,255,255,0.45)';
    var m1Sym = fDone ? '[\u2713]' : '[ ]';
    ctx.fillStyle = m1Col;
    ctx.fillText(m1Sym + ' SPECIES: ' + Math.min(6, _speciesScanned) + '/6', mX, mBotY - (mFsz + 4) * 3);
  }

  function _drawHUDFrame() {
    if (!_hctx) return;
    _hctx.clearRect(0, 0, _W, _H);

    _drawEyeHUD(_hctx, 0,      _W / 2, _H);
    _drawEyeHUD(_hctx, _W / 2, _W / 2, _H);

    _hctx.strokeStyle = 'rgba(0,255,204,0.08)';
    _hctx.lineWidth   = 1;
    _hctx.beginPath();
    _hctx.moveTo(_W / 2, 0);
    _hctx.lineTo(_W / 2, _H);
    _hctx.stroke();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     DUAL-VIEWPORT RENDER LOOP VIA SCISSOR TEST
     Left viewport  : (0, 0, W / 2, H) for cameraL
     Right viewport : (W / 2, 0, W / 2, H) for cameraR
  ───────────────────────────────────────────────────────────────────────── */
  function _render() {
    var halfW = Math.floor(_W / 2);
    _renderer.clear();
    _renderer.setScissorTest(true);

    // Left eye pass
    _renderer.setScissor(0, 0, halfW, _H);
    _renderer.setViewport(0, 0, halfW, _H);
    _renderer.render(_scene, cameraL);

    // Right eye pass
    _renderer.setScissor(halfW, 0, halfW, _H);
    _renderer.setViewport(halfW, 0, halfW, _H);
    _renderer.render(_scene, cameraR);

    _drawHUDFrame();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     AUDIO DISPATCH HELPER
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
  ───────────────────────────────────────────────────────────────────────── */
  function _commitInteraction(target) {
    if (!target || !target.userData) return;
    var ud    = target.userData;
    var eType = ud.entityType || ud.type;
    var eId   = ud.entityId || ud.id || '';

    /* ══════════════════ POLLUTION COLLECTION ══════════════════ */
    if (eType === 'pollution') {
      if (ud.collected) return;
      ud.collected = true;
      _pollutionDone++;

      _audio('playScanChime');

      target.visible = false;
      target.position.set(0, -999, 0);

      var em = (window.ABYSS && window.ABYSS.EntityManager)
        ? window.ABYSS.EntityManager.getInteractables() : _interactables;
      var pi = em.indexOf(target);
      if (pi !== -1) em.splice(pi, 1);
      var li = _interactables.indexOf(target);
      if (li !== -1) _interactables.splice(li, 1);
    }

    /* ══════════════════ FAUNA SCANNING ══════════════════ */
    else if (eType === 'fauna') {
      if (ud.scanned) return;
      ud.scanned = true;
      _speciesScanned++;

      _audio('playSonarPing');
      setTimeout(function () { _audio('playScanChime'); }, 350);

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
    else if (eType === 'terminal') {
      if (eId.indexOf('power_conduit') !== -1 || ud.id === 'power_conduit') {
        if (ud.active) return;
        ud.active = true;
        _conduitsRestored++;

        _audio('playScanChime');

        target.traverse(function (node) {
          if (node.isMesh && node.material && node.material.emissive) {
            node.material.emissive.setHex(0x00ffcc);
          }
        });

        _scene.traverse(function (obj) {
          if (obj.isPointLight && Math.abs(obj.intensity - 2.2) < 0.3) {
            obj.intensity = 4.0;
            obj.color.set(0x00ffcc);
          }
        });
      }
      else if (eId === 'o2_refill' || ud.id === 'o2_refill') {
        if (ud.cooldown) return;

        _audio('playPneumaticHiss');
        _oxygen = 100;
        _o2RefillDone = true;
        _o2Terminal = target;

        if (window.ABYSS && window.ABYSS.EntityManager && window.ABYSS.EntityManager.startO2Cooldown) {
          window.ABYSS.EntityManager.startO2Cooldown();
        } else {
          ud.cooldown      = true;
          ud.cooldownStart = performance.now();
          ud.cooldownSecs  = 30;
        }

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
      else if (eId === 'specimen_deposit' || ud.id === 'specimen_deposit') {
        _audio('playChime');
        _specimensDone++;
        ud.deposited = (ud.deposited || 0) + 1;

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
      else if (eId === 'waste_disposal' || ud.id === 'waste_disposal') {
        _audio('playMechanicalRumble');
        _wasteDone = true;

        if (window.ABYSS && window.ABYSS.EntityManager && window.ABYSS.EntityManager.openWasteHatch) {
          window.ABYSS.EntityManager.openWasteHatch();
        } else {
          ud.hatchOpen = true;
          ud.targetRot = Math.PI;
        }

        setTimeout(function () {
          if (window.ABYSS && window.ABYSS.EntityManager && window.ABYSS.EntityManager.closeWasteHatch) {
            window.ABYSS.EntityManager.closeWasteHatch();
          } else if (ud) {
            ud.hatchOpen = false;
            ud.targetRot = 0;
          }
          _audio('playMechanicalRumble');
        }, 4000);

        ud.disposed = (ud.disposed || 0) + 1;
      }
    }

    /* ══════════════════ STATION AIRLOCK DOCKING ══════════════════ */
    else if (eType === 'station' || eId === 'station_airlock' || ud.id === 'station_airlock') {
      var priorComplete = (_speciesScanned >= 6 && _pollutionDone >= 6 && _conduitsRestored >= 2);
      if (!priorComplete) {
        _audio('playProximityAlert');
        return;
      }

      if (_stationDone) return;
      _stationDone = true;

      _audio('playScanChime');

      target.traverse(function (node) {
        if (node.isMesh && node.material && node.material.emissive) {
          node.material.emissive.setHex(0x00ff88);
        }
      });

      _scene.traverse(function (obj) {
        if (obj.isPointLight && obj.intensity > 3.0) {
          obj.intensity = 6.0;
          obj.color.set(0x00ff88);
          obj.distance  = 20;
        }
      });

      setTimeout(function () {
        _setGameState(STATE.SUCCESS);
      }, 900);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     _handleGaze(delta) — Gaze Dwell Detection (1.2s Scan & 1.8s In-VR Exit)
  ───────────────────────────────────────────────────────────────────────── */
  function _handleGaze(delta) {
    if (!cameraL || !_scene) return;

    // 1. In-VR Surface / Exit Gaze Check:
    // User looks up towards the surface (pitch >= 35 deg)
    var isLookingUp = false;
    if (window.ABYSS && window.ABYSS.Controls && window.ABYSS.Controls.getPitchDeg) {
      isLookingUp = (window.ABYSS.Controls.getPitchDeg() >= 35);
    }

    if (isLookingUp) {
      _exitGazeTime += delta;
      _exitGazeProgress = Math.min(1, _exitGazeTime / EXIT_DWELL_TIME);
      if (_exitGazeTime >= EXIT_DWELL_TIME) {
        _exitGazeTime = 0;
        _exitGazeProgress = 0;
        exitDiveSession();
        return;
      }
    } else {
      _exitGazeTime = 0;
      _exitGazeProgress = 0;
    }

    // 2. Interactive Object Center Raycasting (0, 0)
    _raycaster.setFromCamera({ x: 0, y: 0 }, cameraL);

    var candidateList = (window.ABYSS && window.ABYSS.EntityManager && window.ABYSS.EntityManager.getInteractables)
      ? window.ABYSS.EntityManager.getInteractables()
      : _interactables;

    var hits = _raycaster.intersectObjects(candidateList, true);

    var hit = null;
    if (hits.length > 0) {
      var obj = hits[0].object;
      var ud  = (obj && obj.userData) ? obj.userData : {};

      if (ud.faunaGroup) {
        hit = ud.faunaGroup;
      } else if (ud.terminalGroup) {
        hit = ud.terminalGroup;
      } else if (ud.type === 'pollution' || ud.type === 'station' || ud.type === 'terminal' || ud.type === 'fauna') {
        hit = obj;
      } else {
        var p = obj;
        while (p.parent && p.parent !== _scene) { p = p.parent; }
        if (p && p.userData && (p.userData.type || p.userData.entityType)) hit = p;
      }
    }

    // Filter out already completed targets
    if (hit && hit.userData) {
      var hud   = hit.userData;
      var eType = hud.entityType || hud.type;
      var eId   = hud.entityId || hud.id;

      if (eType === 'fauna' && hud.scanned) hit = null;
      if (eType === 'pollution' && hud.collected) hit = null;
      if (eType === 'terminal' && (eId.indexOf('power_conduit') !== -1 || hud.id === 'power_conduit') && hud.active) hit = null;
      if (eType === 'terminal' && hud.id === 'o2_refill' && hud.cooldown) hit = null;
      if ((eType === 'station' || eId === 'station_airlock') && _stationDone) hit = null;
    } else {
      hit = null;
    }

    if (hit) {
      if (_gazeTarget !== hit) {
        _gazeTarget  = hit;
        _gazeTime    = 0;
      }
      _gazeTime    += delta;
      _gazeProgress = Math.min(1, _gazeTime / DWELL_SCAN_TIME);

      if (_gazeTime >= DWELL_SCAN_TIME) {
        _commitInteraction(hit);
        _gazeTarget   = null;
        _gazeTime     = 0;
        _gazeProgress = 0;
      }
    } else {
      _gazeTarget   = null;
      _gazeTime     = 0;
      _gazeProgress = 0;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     MAIN VR GAME LOOP
     - Delta capped at 0.05s per frame.
     - Dual Sonar Radar update.
  ───────────────────────────────────────────────────────────────────────── */
  function _loop(ts) {
    _animId = requestAnimationFrame(_loop);

    if (_isPaused) {
      _lastTS = ts;
      return;
    }

    var delta = Math.min((ts - _lastTS) / 1000, 0.05); // cap at 0.05s per frame
    _lastTS   = ts;

    if (_state === STATE.PLAYING) {
      var t = _clock.getElapsedTime();

      // 1. Update camera matrices
      if (_rig)    _rig.updateMatrixWorld();
      if (cameraL) cameraL.updateMatrixWorld();
      if (cameraR) cameraR.updateMatrixWorld();

      // 2. Update controls
      if (window.ABYSS && window.ABYSS.Controls && window.ABYSS.Controls.update) {
        window.ABYSS.Controls.update(delta);
      }

      // 3. Update environment & entities
      if (window.ABYSS && window.ABYSS.EnvironmentBuilder && window.ABYSS.EnvironmentBuilder.update) {
        window.ABYSS.EnvironmentBuilder.update(t);
      }
      if (window.ABYSS && window.ABYSS.EntityManager && window.ABYSS.EntityManager.update) {
        window.ABYSS.EntityManager.update(t, delta);
      }

      _handleGaze(delta);

      // O₂ drain: Base = 100 / 300 per second (doubled near shark)
      var drainRate = (window.ABYSS && window.ABYSS._sharkNear) ? O2_DRAIN_SHARK : O2_DRAIN_BASE;
      _oxygen -= drainRate * delta;
      _oxygen  = Math.max(0, _oxygen);

      // Shark alert throttle
      if (window.ABYSS && window.ABYSS._sharkNear && ts - _lastSharkAlert > 4000) {
        _lastSharkAlert = ts;
        _audio('playProximityAlert');
      }

      // Depleted condition
      if (_oxygen <= 0) {
        _setGameState(STATE.DEAD);
        return;
      }

      // Sonar Radar Render Pass
      var playerPos = _rig ? _rig.position : { x: 0, y: 0, z: 0 };
      var heading = 0;
      if (window.ABYSS && window.ABYSS.Controls && window.ABYSS.Controls.getLookDirection) {
        var ld = window.ABYSS.Controls.getLookDirection();
        heading = Math.atan2(ld.x, -ld.z);
      } else if (_pitchObj) {
        var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_pitchObj.quaternion);
        heading = Math.atan2(fwd.x, -fwd.z);
      } else if (_rig) {
        heading = _rig.rotation.y;
      }

      var activeInteractables = (window.ABYSS && window.ABYSS.EntityManager && window.ABYSS.EntityManager.getInteractables)
        ? window.ABYSS.EntityManager.getInteractables()
        : _interactables;

      drawSonar(_sonarCtxL, playerPos, activeInteractables, heading);
      drawSonar(_sonarCtxR, playerPos, activeInteractables, heading);

    } else if (_state === STATE.SUCCESS || _state === STATE.DEAD) {
      var tf = _clock ? _clock.getElapsedTime() : 0;
      if (window.ABYSS && window.ABYSS.EnvironmentBuilder && window.ABYSS.EnvironmentBuilder.update) {
        window.ABYSS.EnvironmentBuilder.update(tf);
      }
      if (window.ABYSS && window.ABYSS.EntityManager && window.ABYSS.EntityManager.update) {
        window.ABYSS.EntityManager.update(tf, delta);
      }
    }

    if (_scene && cameraL && _renderer) _render();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     GAME STATE TRANSITIONS
  ───────────────────────────────────────────────────────────────────────── */
  function _setGameState(newState) {
    _state = newState;

    var endOverlay = document.getElementById('endOverlay');
    var endEyebrow = document.getElementById('endEyebrow');
    var endTitle   = document.getElementById('endTitle');
    var endMsg     = document.getElementById('endMsg');
    var quitBtn    = document.getElementById('quitBtn');

    if (quitBtn) quitBtn.classList.add('hidden');

    if (newState === STATE.SUCCESS) {
      if (endOverlay) endOverlay.classList.remove('hidden');
      if (endEyebrow) endEyebrow.textContent = 'MISSION ACCOMPLISHED';
      if (endTitle) {
        endTitle.textContent = 'STATION UNLOCKED';
        endTitle.style.color = 'var(--cyan)';
        endTitle.style.textShadow = '0 0 30px rgba(0,255,204,0.8)';
      }
      if (endMsg) {
        endMsg.textContent = 'All 6 marine species catalogued, 6 pollution hazards removed, ' +
          'power conduit terminals restored, and underwater research station fully pressurized.';
      }
      _audio('playSuccessFanfare');
      _audio('playVictory');

    } else if (newState === STATE.DEAD) {
      if (endOverlay) endOverlay.classList.remove('hidden');
      if (endEyebrow) endEyebrow.textContent = 'LIFE SUPPORT OFFLINE';
      if (endTitle) {
        endTitle.textContent = 'O\u2082 DEPLETED';
        endTitle.style.color = '#ff4444';
        endTitle.style.textShadow = '0 0 30px rgba(255,68,68,0.8)';
      }
      if (endMsg) {
        endMsg.textContent = 'Oxygen reserves reached zero. Emergency ascent protocol ' +
          'initiated. Mission parameters incomplete.';
      }
      _audio('playProximityAlert');
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     WORLD BUILDER
  ───────────────────────────────────────────────────────────────────────── */
  function _buildWorld() {
    _interactables = [];

    var envResult = null;
    if (window.ABYSS && window.ABYSS.EnvironmentBuilder && window.ABYSS.EnvironmentBuilder.build) {
      envResult = window.ABYSS.EnvironmentBuilder.build(_scene);
    }

    if (envResult && envResult.airlock) {
      envResult.airlock.name = 'station_airlock';
      envResult.airlock.userData.type     = 'station';
      envResult.airlock.userData.id       = 'station_airlock';
      envResult.airlock.userData.entityId = 'station_airlock';
      if (_interactables.indexOf(envResult.airlock) === -1) {
        _interactables.push(envResult.airlock);
      }
    }

    if (window.ABYSS && window.ABYSS.EntityManager && window.ABYSS.EntityManager.spawnAll) {
      var spawned = window.ABYSS.EntityManager.spawnAll(_scene);
      if (Array.isArray(spawned)) {
        spawned.forEach(function (e) {
          if (e && e.isObject3D && _interactables.indexOf(e) === -1) {
            _interactables.push(e);
          }
        });
      }
    }

    if (_scene) {
      _scene.traverse(function (obj) {
        if (obj.userData && (obj.userData.id === 'station_airlock' || obj.userData.type === 'station')) {
          if (_interactables.indexOf(obj) === -1) {
            _interactables.push(obj);
          }
        }
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RESET SESSION STATE
  ───────────────────────────────────────────────────────────────────────── */
  function _resetSession() {
    _oxygen           = 100;
    _speciesScanned   = 0;
    _pollutionDone    = 0;
    _conduitsRestored = 0;
    _stationDone      = false;
    _o2RefillDone     = false;
    _specimensDone    = 0;
    _wasteDone        = false;
    _gazeTarget       = null;
    _gazeTime         = 0;
    _gazeProgress     = 0;
    _exitGazeTime     = 0;
    _exitGazeProgress = 0;
    _lastSharkAlert   = 0;
    _o2Terminal       = null;
    if (window.ABYSS) window.ABYSS._sharkNear = false;

    if (window.ABYSS && window.ABYSS.EntityManager && window.ABYSS.EntityManager.reset) {
      window.ABYSS.EntityManager.reset();
      _interactables = window.ABYSS.EntityManager.getInteractables() || [];
    }

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

    if (window.ABYSS && window.ABYSS.Controls && window.ABYSS.Controls.init) {
      window.ABYSS.Controls.init(_rig, _pitchObj, cameraL);
    }

    if (_rig) {
      _rig.position.set(0, 0, 0);
      _rig.rotation.set(0, 0, 0);
    }
    if (_pitchObj) {
      _pitchObj.rotation.set(0, 0, 0);
    }

    if (_clock) _clock.start();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     START GAME
  ───────────────────────────────────────────────────────────────────────── */
  function _startGame() {
    if (window.ABYSS && window.ABYSS.Audio) {
      if (window.ABYSS.Audio.init)            window.ABYSS.Audio.init();
      if (window.ABYSS.Audio.resume)          window.ABYSS.Audio.resume();
      if (window.ABYSS.Audio.playAmbient)     window.ABYSS.Audio.playAmbient();
      else {
        if (window.ABYSS.Audio.startOceanHum)   window.ABYSS.Audio.startOceanHum();
        if (window.ABYSS.Audio.startBubbleLoop) window.ABYSS.Audio.startBubbleLoop();
      }
    } else if (window.SoundSystem) {
      if (window.SoundSystem.init)            window.SoundSystem.init();
      if (window.SoundSystem.resume)          window.SoundSystem.resume();
      if (window.SoundSystem.startOceanHum)   window.SoundSystem.startOceanHum();
      if (window.SoundSystem.startBubbleLoop) window.SoundSystem.startBubbleLoop();
    }

    if (!_worldBuilt) {
      _scene.add(_rig);
      _buildWorld();
      _worldBuilt = true;
    } else {
      _resetSession();
    }

    if (_sonarCanvasL) _sonarCanvasL.style.display = 'block';
    if (_sonarCanvasR) _sonarCanvasR.style.display = 'block';

    _clock.start();
    _updateCameraAspect();
    _setGameState(STATE.PLAYING);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     exitDiveSession() — In-VR Dwell Exit & Back Button Handler
     - Cancel animation frame.
     - Stop camera stream tracks via window.ABYSS.HandTracker?.stop().
     - Stop ambient audio via window.ABYSS.Audio?.stopAmbient().
     - Call window.Capacitor?.Plugins?.ScreenOrientation?.lock({ orientation: 'portrait' }).
     - Hide #vrCanvas, disable scissor test, and restore #startOverlay.
  ───────────────────────────────────────────────────────────────────────── */
  async function exitDiveSession() {
    _state = STATE.START;

    // 1. Cancel animation frame
    if (_animId) {
      cancelAnimationFrame(_animId);
      _animId = null;
    }

    // 2. Stop camera stream tracks
    if (window.ABYSS && window.ABYSS.HandTracker && window.ABYSS.HandTracker.stop) {
      window.ABYSS.HandTracker.stop();
    }

    // 3. Stop ambient audio
    if (window.ABYSS && window.ABYSS.Audio && window.ABYSS.Audio.stopAmbient) {
      window.ABYSS.Audio.stopAmbient();
    }
    if (window.ABYSS && window.ABYSS.Audio) {
      if (window.ABYSS.Audio.stopOceanHum)   window.ABYSS.Audio.stopOceanHum();
      if (window.ABYSS.Audio.stopBubbleLoop) window.ABYSS.Audio.stopBubbleLoop();
    } else if (window.SoundSystem) {
      if (window.SoundSystem.stopOceanHum)   window.SoundSystem.stopOceanHum();
      if (window.SoundSystem.stopBubbleLoop) window.SoundSystem.stopBubbleLoop();
    }

    // Stop gyroscope sensor
    if (window.ABYSS && window.ABYSS.Controls && window.ABYSS.Controls.stopGyro) {
      window.ABYSS.Controls.stopGyro();
    }

    // 4. Lock screen orientation to portrait
    await _setOrientation('portrait');

    // 5. Disable scissor test
    if (_renderer) {
      _renderer.setScissorTest(false);
    }

    // 6. Hide #vrCanvas and sonar radar canvases
    var vrCanvas = document.getElementById('vrCanvas');
    if (vrCanvas) {
      vrCanvas.style.display = 'none';
    }

    var hudCanvas = document.getElementById('hudCanvas');
    if (hudCanvas) {
      var hctx = hudCanvas.getContext('2d');
      if (hctx) hctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
    }

    if (_sonarCanvasL) _sonarCanvasL.style.display = 'none';
    if (_sonarCanvasR) _sonarCanvasR.style.display = 'none';

    var quitBtn = document.getElementById('quitBtn');
    if (quitBtn) quitBtn.classList.add('hidden');

    var endOverlay = document.getElementById('endOverlay');
    if (endOverlay) endOverlay.classList.add('hidden');

    // 7. Restore #startOverlay
    var startOverlay = document.getElementById('startOverlay') || document.getElementById('overlay');
    if (startOverlay) {
      startOverlay.classList.remove('hidden');
      startOverlay.style.display    = 'flex';
      startOverlay.style.opacity    = '1';
      startOverlay.style.transition = 'opacity 0.4s ease-in';
    }

    _launched = false;
  }

  // Register public exit API
  window.ABYSS.exitDiveSession = exitDiveSession;
  window.ABYSS.quitGame        = exitDiveSession;
  window.ABYSS.startGame       = _startGame;

  /* ─────────────────────────────────────────────────────────────────────────
     RESIZE & ORIENTATION HANDLER
  ───────────────────────────────────────────────────────────────────────── */
  function _onResize() {
    _updateCameraAspect();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BOOTSTRAP — DOMContentLoaded
  ───────────────────────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    // 1. Enforce portrait mode on startup
    _setOrientation('portrait');

    _initHUD();
    _initSonar();
    _initBgParticles();

    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0x041a2e);

    _initRenderer();

    // Hide loading overlay
    var lo = document.getElementById('loadingOverlay');
    if (lo) setTimeout(function () { lo.style.display = 'none'; }, 380);

    /* ── DYNAMIC ORIENTATION TRANSITION & DIVE LAUNCH ─────────────────────────
       1. Lock landscape orientation.
       2. 150ms timeout for viewport dimensions to settle.
       3. Update renderer viewport and camera aspect.
       4. Request gyro permissions.
       5. Initialize HandTracker sensor.
       6. Show #vrCanvas and sonar canvases, start VR game loop.
    ─────────────────────────────────────────────────────────────────────────── */
    async function _onTapToDive(e) {
      if (_launched) return;
      _launched = true;

      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();

      if (window.ABYSS && window.ABYSS.Audio && window.ABYSS.Audio.init) {
        window.ABYSS.Audio.init();
      } else if (window.SoundSystem && window.SoundSystem.init) {
        window.SoundSystem.init();
      }

      try {
        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(function () {});
        }
      } catch (err) {}

      if (navigator.wakeLock) {
        navigator.wakeLock.request('screen').then(function (wl) {
          window._wakeLock = wl;
        }).catch(function () {});
      }

      // Step 1: Rotate device to landscape
      await _setOrientation('landscape');

      // Step 2: 150ms timeout so Three.js viewport matches rotated aspect
      await new Promise(function (resolve) { setTimeout(resolve, 150); });

      // Step 3: Viewport & camera aspect update
      var vrCanvas = document.getElementById('vrCanvas');
      if (vrCanvas) vrCanvas.style.display = 'block';

      _initRenderer();
      _updateCameraAspect();

      // Step 4: Request gyroscope permission
      try {
        if (window.ABYSS && window.ABYSS.Controls && window.ABYSS.Controls.requestGyro) {
          await window.ABYSS.Controls.requestGyro();
        }
      } catch (err) {
        console.warn('[ABYSS] Gyro request exception:', err);
      }

      // Step 5: Initialize HandTracker sensor pipeline
      if (window.ABYSS && window.ABYSS.HandTracker && window.ABYSS.HandTracker.init) {
        window.ABYSS.HandTracker.init().catch(function () {});
      }

      // Step 6: Show Quit HUD button & hide start overlay
      var quitBtn = document.getElementById('quitBtn');
      if (quitBtn) quitBtn.classList.remove('hidden');

      var startOverlay = document.getElementById('startOverlay') || document.getElementById('overlay');
      if (startOverlay) {
        startOverlay.style.transition = 'opacity 0.4s ease-out';
        startOverlay.style.opacity    = '0';
        setTimeout(function () {
          startOverlay.classList.add('hidden');
          startOverlay.style.display = 'none';
        }, 400);
      }

      _lastTS = performance.now();
      _startGame();

      if (!_animId) {
        _animId = requestAnimationFrame(_loop);
      }
    }

    // Attach to "TAP TO DIVE" button
    var diveBtn = document.getElementById('diveBtn') || document.getElementById('btn-start-vr');
    if (diveBtn) {
      diveBtn.addEventListener('click', _onTapToDive);
    }

    var startOverlay = document.getElementById('startOverlay') || document.getElementById('overlay');
    if (startOverlay) {
      startOverlay.addEventListener('click', _onTapToDive);
    }

    // In-game surface / quit button (#quitBtn)
    var quitBtn = document.getElementById('quitBtn');
    if (quitBtn) {
      quitBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        exitDiveSession();
      });
    }

    // Restart / surface button on End Overlay
    var restartBtn = document.getElementById('restartBtn');
    if (restartBtn) {
      restartBtn.addEventListener('click', function () {
        exitDiveSession();
      });
    }

    // Capacitor hardware back button binding
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      window.Capacitor.Plugins.App.addListener('backButton', function (info) {
        if (_state === STATE.PLAYING) {
          exitDiveSession();
        } else if (info && info.canGoBack) {
          window.history.back();
        } else {
          window.Capacitor.Plugins.App.exitApp();
        }
      });
    }

    // Keyboard shortcut: Escape to quit
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _state === STATE.PLAYING) {
        exitDiveSession();
      }
    });

    // Visibility / background pausing
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        _isPaused = true;
        if (window.ABYSS && window.ABYSS.Audio && window.ABYSS.Audio.stopAmbient) {
          window.ABYSS.Audio.stopAmbient();
        }
        if (window.ABYSS && window.ABYSS.HandTracker && window.ABYSS.HandTracker.stop) {
          window.ABYSS.HandTracker.stop();
        }
      } else {
        _isPaused = false;
        _lastTS   = performance.now();
        if (_state === STATE.PLAYING) {
          if (window.ABYSS && window.ABYSS.Audio && window.ABYSS.Audio.playAmbient) {
            window.ABYSS.Audio.playAmbient();
          }
          if (window.ABYSS && window.ABYSS.HandTracker && window.ABYSS.HandTracker.init) {
            window.ABYSS.HandTracker.init().catch(function () {});
          }
        }
      }
    });

    // Resize and orientation change listeners
    window.addEventListener('resize', _onResize);
    window.addEventListener('orientationchange', function () {
      setTimeout(_onResize, 150);
    });
    if (window.screen && window.screen.orientation) {
      window.screen.orientation.addEventListener('change', function () {
        setTimeout(_onResize, 150);
      });
    }
  });

}());
