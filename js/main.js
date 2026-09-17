/* =============================================================================
   ABYSS: Marine Explorer — js/main.js
   Orchestrator: renderer, dual SBS cameras, dive torch, gaze system,
   HUD canvas, game state machine. Depends on all other modules.

   PERFORMANCE & ZERO RECOMPILATION RULES:
   - commitInteraction() handles pollution by instant hide + offscreen relocation +
     direct splice from interactables list. No setInterval, no opacity changes.
   - Fauna scan uses material.emissive.getHex() / setHex() without mutating
     emissiveIntensity or adding dynamic material properties.
   - handleGaze() filters out collected/scanned entities before timer evaluation.
   ============================================================================= */

(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     STATE MACHINE
     ───────────────────────────────────────────────────────────────────────── */
  var STATE = { START: 0, DIVING: 1, SUCCESS: 2, DEAD: 3 };
  var _state = STATE.START;

  /* ─────────────────────────────────────────────────────────────────────────
     GLOBALS & GAME COUNTERS
     ───────────────────────────────────────────────────────────────────────── */
  var _renderer, _scene;
  var _rig, _camL, _camR;
  var _clock;
  var _raycaster;
  var _W, _H;

  // HUD canvas
  var _hud, _hctx;

  // Game counters
  var _oxygen         = 100;
  var speciesScanned  = 0;
  var _speciesScanned = 0;
  var pollutionCount  = 0;
  var _pollutionDone  = 0;
  var _stationDone    = false;
  var OXYGEN_SECS     = 180;

  // Gaze interaction state
  var gazeTarget      = null;
  var _gazeTarget     = null;
  var gazeTime        = 0;
  var _gazeTime       = 0;
  var gazeProgress    = 0;
  var _gazeProgress   = 0;
  var GAZE_REQ        = 2.0;
  var _interactables  = [];

  // Torch
  var _torch          = null;
  var _torchTarget    = null;

  // Timing
  var _lastTS         = 0;

  /* ─────────────────────────────────────────────────────────────────────────
     START-SCREEN BACKGROUND PARTICLES
     ───────────────────────────────────────────────────────────────────────── */
  function _initBgParticles() {
    var cv = document.getElementById('bgParticles');
    if (!cv) return;
    var c  = cv.getContext('2d');
    var pts = [];

    function resize() {
      cv.width  = window.innerWidth;
      cv.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

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
     RENDERER + CAMERAS + RIG
     ───────────────────────────────────────────────────────────────────────── */
  function _initRenderer() {
    _W = window.innerWidth;
    _H = window.innerHeight;

    var canvas = document.getElementById('vrCanvas');
    _renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: 'high-performance' });
    _renderer.autoClear = false;   // Per spec — call renderer.clear() once per frame
    _renderer.shadowMap.enabled = false;
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    _renderer.setSize(_W, _H);

    _clock     = new THREE.Clock();
    _raycaster = new THREE.Raycaster();
    _raycaster.far = 58;

    _rig = new THREE.Group();

    var aspect = (_W / 2) / _H;
    _camL = new THREE.PerspectiveCamera(90, aspect, 0.1, 200);
    _camL.position.x = -0.032;    // IPD = 0.064 / 2
    _rig.add(_camL);

    _camR = new THREE.PerspectiveCamera(90, aspect, 0.1, 200);
    _camR.position.x = +0.032;
    _rig.add(_camR);

    _rig.position.set(0, 0, 0);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     DIVE TORCH + HELMET GLOW
     SpotLight target must be in the scene graph BEFORE torch.target is set.
     ───────────────────────────────────────────────────────────────────────── */
  function _attachTorch() {
    // Primary beam — colour #cceeff per spec
    _torch = new THREE.SpotLight(0xcceeff, 2.8);
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

    // Helmet glow — bioluminescent ambient scatter
    var glow = new THREE.PointLight(0x00e5ff, 0.9, 8);
    glow.position.set(0, -0.5, 0);
    _rig.add(glow);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     HUD CANVAS
     ───────────────────────────────────────────────────────────────────────── */
  function _initHUD() {
    _hud          = document.getElementById('hudCanvas');
    _hctx         = _hud.getContext('2d');
    _hud.width    = _W;
    _hud.height   = _H;
  }

  function _roundRect(ctx, x, y, w, h, r) {
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
     drawEyeHUD — renders HUD elements for one viewport
     ───────────────────────────────────────────────────────────────────────── */
  function _drawEyeHUD(ctx, ox, eyeW, eyeH) {
    var t  = _clock.getElapsedTime();
    var cx = ox + eyeW / 2;
    var cy = eyeH / 2;

    /* ── Vignette top ── */
    var topG = ctx.createLinearGradient(ox, 0, ox, eyeH * 0.2);
    topG.addColorStop(0, 'rgba(4,27,51,0.78)');
    topG.addColorStop(1, 'rgba(4,27,51,0)');
    ctx.fillStyle = topG;
    ctx.fillRect(ox, 0, eyeW, eyeH * 0.2);

    /* ── Vignette bottom ── */
    var botG = ctx.createLinearGradient(ox, eyeH * 0.8, ox, eyeH);
    botG.addColorStop(0, 'rgba(4,27,51,0)');
    botG.addColorStop(1, 'rgba(4,27,51,0.78)');
    ctx.fillStyle = botG;
    ctx.fillRect(ox, eyeH * 0.8, eyeW, eyeH * 0.2);

    /* ─────────────────────────────────
       TOP-LEFT — OXYGEN BAR
       ───────────────────────────────── */
    var oxyPct   = Math.max(0, _oxygen / 100);
    var oxyLow   = oxyPct <= 0.25;
    var oxyAmber = oxyPct > 0.25 && oxyPct <= 0.50;
    var oxyColor = oxyLow
      ? (Math.sin(t * 6) > 0 ? '#ff4444' : '#ff0000')
      : oxyAmber ? '#ffaa00' : '#00ffcc';

    var barW = Math.round(eyeW * 0.27);
    var barH = 11;
    var barX = ox + 14;
    var barY = 15;

    // Label
    var fsz = Math.round(eyeW * 0.019);
    ctx.font      = 'bold ' + fsz + 'px "Share Tech Mono", monospace';
    ctx.fillStyle = '#00ffcc';
    ctx.textAlign = 'left';
    ctx.fillText('⬡ OXYGEN', barX, barY + barH - 1);

    // Track
    var trackX = barX + ctx.measureText('⬡ OXYGEN  ').width;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    _roundRect(ctx, trackX, barY, barW, barH, 3);
    ctx.fill();

    // Fill
    if (oxyPct > 0) {
      if (oxyLow) { ctx.shadowBlur = 10; ctx.shadowColor = oxyColor; }
      ctx.fillStyle = oxyColor;
      _roundRect(ctx, trackX + 2, barY + 2, Math.max(0, (barW - 4) * oxyPct), barH - 4, 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Percentage
    ctx.fillStyle = oxyLow ? oxyColor : 'rgba(255,255,255,0.82)';
    ctx.fillText(Math.ceil(oxyPct * 100) + '%', trackX + barW + 6, barY + barH - 1);

    /* ─────────────────────────────────
       TOP-RIGHT — DEPTH
       ───────────────────────────────── */
    var depth = (42 + Math.sin(t * 0.3) * 5).toFixed(0);
    var dTxt  = 'DEPTH ' + depth + 'm';
    ctx.font  = 'bold ' + fsz + 'px "Share Tech Mono", monospace';
    var dW    = ctx.measureText(dTxt).width + 18;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    _roundRect(ctx, ox + eyeW - dW - 12, barY, dW, barH + 2, 3);
    ctx.fill();
    ctx.fillStyle = '#00ffcc';
    ctx.textAlign = 'right';
    ctx.fillText(dTxt, ox + eyeW - 15, barY + barH - 1);

    /* ─────────────────────────────────
       CENTER — RETICLE + GAZE ARC
       ───────────────────────────────── */
    var rR = 22;

    // Outer ring
    ctx.strokeStyle = gazeProgress > 0 ? '#00ffcc' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth   = gazeProgress > 0 ? 2.5 : 1.5;
    if (gazeProgress > 0) { ctx.shadowBlur = 14; ctx.shadowColor = '#00ffcc'; }
    ctx.beginPath();
    ctx.arc(cx, cy, rR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Centre dot
    ctx.fillStyle = gazeProgress > 0 ? 'rgba(0,255,204,0.95)' : 'rgba(255,255,255,0.52)';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Crosshairs
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(cx - rR - 9, cy); ctx.lineTo(cx - rR + 5, cy);
    ctx.moveTo(cx + rR - 5, cy); ctx.lineTo(cx + rR + 9, cy);
    ctx.moveTo(cx, cy - rR - 9); ctx.lineTo(cx, cy - rR + 5);
    ctx.moveTo(cx, cy + rR - 5); ctx.lineTo(cx, cy + rR + 9);
    ctx.stroke();

    // Gaze arc
    if (gazeProgress > 0) {
      ctx.strokeStyle = '#00ffcc';
      ctx.lineWidth   = 4;
      ctx.shadowBlur  = 20;
      ctx.shadowColor = '#00ffcc';
      ctx.beginPath();
      ctx.arc(cx, cy, rR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * gazeProgress);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Scan label
    if (gazeTarget && gazeTarget.userData) {
      var LABELS = {
        turtle: 'SEA TURTLE', jellyfish: 'JELLYFISH', clownfish: 'CLOWNFISH',
        mantaray: 'MANTA RAY', eel: 'BIOLUM. EEL',
        station_airlock: 'AIRLOCK — SCAN'
      };
      var lbl = '';
      if (gazeTarget.userData.type === 'fauna')     lbl = LABELS[gazeTarget.userData.id] || 'SCANNING';
      if (gazeTarget.userData.type === 'pollution')  lbl = 'POLLUTION — COLLECT';
      if (gazeTarget.userData.type === 'station')    lbl = LABELS[gazeTarget.userData.id] || 'SCAN';

      if (lbl) {
        ctx.font = 'bold ' + Math.round(eyeW * 0.021) + 'px "Share Tech Mono", monospace';
        var lbW  = ctx.measureText(lbl).width + 24;
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        _roundRect(ctx, cx - lbW / 2, cy + rR + 12, lbW, 28, 5);
        ctx.fill();
        ctx.fillStyle  = '#00ffcc';
        ctx.textAlign  = 'center';
        ctx.fillText(lbl, cx, cy + rR + 30);
      }
    }

    /* ─────────────────────────────────
       BOTTOM BAR — objectives + station
       ───────────────────────────────── */
    var objFsz  = Math.round(eyeW * 0.017);
    var objY    = eyeH - 36;
    var stReady = speciesScanned >= 5 && pollutionCount >= 4 && !_stationDone;
    var stState = _stationDone ? 'UNLOCKED' : (stReady ? 'READY' : 'LOCKED');
    var stColor = _stationDone ? '#00ff88' : (stReady ? '#ffee00' : '#4488ff');
    var line1   = '◈ ' + speciesScanned + '/5 SPECIES   ◈ ' + pollutionCount + '/4 CLEAN';
    var line2   = 'STATION: ' + stState;

    ctx.font = 'bold ' + objFsz + 'px "Share Tech Mono", monospace';
    var l1W  = ctx.measureText(line1).width + 24;

    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    _roundRect(ctx, cx - l1W / 2, objY - objFsz - 8, l1W, objFsz * 2.9 + 14, 5);
    ctx.fill();

    ctx.fillStyle = '#00ffcc';
    ctx.textAlign = 'center';
    ctx.fillText(line1, cx, objY);

    // Station status — pulse dot when READY
    if (stReady) {
      var pulse = Math.abs(Math.sin(t * 3.0));
      ctx.fillStyle = 'rgba(255,238,0,' + (0.5 + pulse * 0.5) + ')';
      ctx.beginPath();
      ctx.arc(cx - l1W / 2 + 12, objY + objFsz + 4, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = stColor;
    if (_stationDone) { ctx.shadowBlur = 8; ctx.shadowColor = '#00ff88'; }
    ctx.fillText(line2, cx, objY + objFsz + 8);
    ctx.shadowBlur = 0;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     drawHUDFrame — clears HUD canvas, draws both eye viewports
     ───────────────────────────────────────────────────────────────────────── */
  function _drawHUDFrame() {
    _hctx.clearRect(0, 0, _hud.width, _hud.height);

    // Game-over vignette
    if (_state === STATE.DEAD) {
      var rg = _hctx.createRadialGradient(_W / 2, _H / 2, _H * 0.2, _W / 2, _H / 2, _H * 0.75);
      rg.addColorStop(0, 'rgba(0,0,0,0)');
      rg.addColorStop(1, 'rgba(180,0,0,0.65)');
      _hctx.fillStyle = rg;
      _hctx.fillRect(0, 0, _W, _H);
      return;
    }

    if (_state !== STATE.DIVING && _state !== STATE.SUCCESS) return;

    _drawEyeHUD(_hctx, 0,      _W / 2, _H);
    _drawEyeHUD(_hctx, _W / 2, _W / 2, _H);

    // Centre separator
    _hctx.strokeStyle = 'rgba(0,255,204,0.09)';
    _hctx.lineWidth   = 1;
    _hctx.beginPath();
    _hctx.moveTo(_W / 2, 0);
    _hctx.lineTo(_W / 2, _H);
    _hctx.stroke();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SBS RENDER PASS
     renderer.autoClear = false → call renderer.clear() once, then two viewports.
     ───────────────────────────────────────────────────────────────────────── */
  function _render() {
    _renderer.clear();

    _renderer.setViewport(0, 0, _W / 2, _H);
    _renderer.setScissor(0, 0, _W / 2, _H);
    _renderer.setScissorTest(true);
    _renderer.render(_scene, _camL);

    _renderer.setViewport(_W / 2, 0, _W / 2, _H);
    _renderer.setScissor(_W / 2, 0, _W / 2, _H);
    _renderer.setScissorTest(true);
    _renderer.render(_scene, _camR);

    _drawHUDFrame();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     commitInteraction(target)
     ZERO SHADER RECOMPILATION & ZERO STALLS:
     - Pollution:
       1. Mark target.userData.collected = true and increment pollutionCount.
       2. Play confirmation audio once via SoundSystem.playScanChime().
       3. Instantly set target.visible = false.
       4. Move entity outside active volume: target.position.set(0, -999, 0).
       5. Remove target directly from EntityManager.getInteractables() (splice).
       6. Clear gazeTarget = null and reset gazeTime = 0.
     - Fauna:
       1. Retrieve existing hex color with var origHex = node.material.emissive.getHex().
       2. Set highlight with node.material.emissive.setHex(0x00ffff).
       3. Revert with node.material.emissive.setHex(origHex) inside a 700 ms setTimeout.
     ───────────────────────────────────────────────────────────────────────── */
  function commitInteraction(target) {
    if (!target || !target.userData) return;

    /* ── POLLUTION COLLECTION ── */
    if (target.userData.type === 'pollution') {
      if (target.userData.collected) return;

      // 1. Mark target.userData.collected = true and increment pollutionCount
      target.userData.collected = true;
      pollutionCount++;
      _pollutionDone = pollutionCount;

      // 2. Play confirmation audio once via SoundSystem.playScanChime()
      if (window.SoundSystem && SoundSystem.playScanChime) {
        SoundSystem.playScanChime();
      }

      // 3. Instantly set target.visible = false
      target.visible = false;

      // 4. Move entity outside active interaction volume immediately
      target.position.set(0, -999, 0);

      // 5. Remove target directly from EntityManager.getInteractables() array (splice)
      if (window.EntityManager && EntityManager.getInteractables) {
        var interList = EntityManager.getInteractables();
        var pIdx = interList.indexOf(target);
        if (pIdx !== -1) {
          interList.splice(pIdx, 1);
        }
      }
      var localIdx = _interactables.indexOf(target);
      if (localIdx !== -1) {
        _interactables.splice(localIdx, 1);
      }

      // 6. Clear gazeTarget = null and reset gazeTime = 0
      gazeTarget   = null;
      _gazeTarget  = null;
      gazeTime     = 0;
      _gazeTime    = 0;
      gazeProgress = 0;
      _gazeProgress = 0;
    }

    /* ── FAUNA SCANNING ── */
    else if (target.userData.type === 'fauna') {
      if (target.userData.scanned) return;
      target.userData.scanned = true;
      speciesScanned++;
      _speciesScanned = speciesScanned;

      if (window.SoundSystem) {
        if (SoundSystem.playSonarPing) SoundSystem.playSonarPing();
        setTimeout(function () {
          if (SoundSystem.playScanChime) SoundSystem.playScanChime();
        }, 350);
      }

      target.traverse(function (node) {
        if (node.isMesh && node.material && node.material.emissive) {
          // 1. Retrieve the existing hex color with var origHex = node.material.emissive.getHex();
          var origHex = node.material.emissive.getHex();
          // 2. Set highlight with node.material.emissive.setHex(0x00ffff);
          node.material.emissive.setHex(0x00ffff);
          // 3. Revert with node.material.emissive.setHex(origHex); inside a 700 ms setTimeout
          setTimeout(function () {
            if (node.material && node.material.emissive) {
              node.material.emissive.setHex(origHex);
            }
          }, 700);
        }
      });
    }

    /* ── RESEARCH STATION AIRLOCK ── */
    else if (target.userData.type === 'station') {
      if (_stationDone) return;
      _stationDone = true;

      if (window.SoundSystem && SoundSystem.playScanChime) {
        SoundSystem.playScanChime();
      }

      // Boost viewport lights to green to signal unlock
      _scene.traverse(function (obj) {
        if (obj.isPointLight && Math.abs(obj.intensity - 2.2) < 0.18) {
          obj.intensity = 5.0;
          obj.color.set(0x00ff88);
          obj.distance  = 16;
        }
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     handleGaze(delta)
     Cast from centre screen through _camL.
     Filter out collected or already-scanned entities before evaluating timers
     to prevent repeated trigger dispatches.
     ───────────────────────────────────────────────────────────────────────── */
  function handleGaze(delta) {
    if (!_camL || !_scene) return;

    _raycaster.setFromCamera({ x: 0, y: 0 }, _camL);

    var candidateList = (window.EntityManager && EntityManager.getInteractables)
      ? EntityManager.getInteractables()
      : _interactables;

    var hits = _raycaster.intersectObjects(candidateList, true);

    var hit = null;
    if (hits.length > 0) {
      var obj = hits[0].object;
      var ud = (obj && obj.userData) ? obj.userData : {};
      if (ud.faunaGroup) {
        hit = ud.faunaGroup;
      } else if (ud.type === 'pollution' || ud.type === 'station') {
        hit = obj;
      } else {
        var p = obj;
        while (p.parent && p.parent !== _scene) p = p.parent;
        if (p && p.userData && p.userData.type) hit = p;
      }
    }

    // Filter out collected or already-scanned entities before evaluating timers
    if (hit && hit.userData && hit.userData.type) {
      if (hit.userData.type === 'fauna'          && hit.userData.scanned)   hit = null;
      else if (hit.userData.type === 'pollution' && hit.userData.collected) hit = null;
      else if (hit.userData.type === 'station'   && _stationDone)           hit = null;
    } else {
      hit = null;
    }

    if (hit) {
      if (gazeTarget !== hit) {
        gazeTarget  = hit;
        _gazeTarget = hit;
        gazeTime    = 0;
        _gazeTime   = 0;
      }
      gazeTime += delta;
      _gazeTime = gazeTime;
      gazeProgress = Math.min(1, gazeTime / GAZE_REQ);
      _gazeProgress = gazeProgress;

      if (gazeTime >= GAZE_REQ) {
        commitInteraction(hit);
        gazeTarget    = null;
        _gazeTarget   = null;
        gazeTime      = 0;
        _gazeTime     = 0;
        gazeProgress  = 0;
        _gazeProgress = 0;
      }
    } else {
      gazeTarget    = null;
      _gazeTarget   = null;
      gazeTime      = 0;
      _gazeTime     = 0;
      gazeProgress  = 0;
      _gazeProgress = 0;
    }
  }

  // Backwards compatibility aliases
  var _executeAction = commitInteraction;
  var _processGaze   = handleGaze;

  /* ─────────────────────────────────────────────────────────────────────────
     MAIN LOOP
     ───────────────────────────────────────────────────────────────────────── */
  function _loop(ts) {
    requestAnimationFrame(_loop);

    var delta = Math.min((ts - _lastTS) / 1000, 0.1);
    _lastTS   = ts;

    if (_state === STATE.DIVING) {
      var t = _clock.getElapsedTime();

      if (window.InputController && InputController.update) InputController.update(delta);
      if (window.EnvironmentBuilder && EnvironmentBuilder.update) EnvironmentBuilder.update(t);
      if (window.EntityManager && EntityManager.update) EntityManager.update(t, delta);
      handleGaze(delta);

      _oxygen -= (100 / OXYGEN_SECS) * delta;
      _oxygen  = Math.max(0, _oxygen);

      if (speciesScanned >= 5 && pollutionCount >= 4 && _stationDone) {
        _setGameState(STATE.SUCCESS);
        return;
      }
      if (_oxygen <= 0) {
        _setGameState(STATE.DEAD);
        return;
      }

    } else if (_state === STATE.SUCCESS || _state === STATE.DEAD) {
      var tf = _clock.getElapsedTime();
      if (window.EnvironmentBuilder && EnvironmentBuilder.update) EnvironmentBuilder.update(tf);
      if (window.EntityManager && EntityManager.update) EntityManager.update(tf, delta);
    }

    if (_scene && _camL) _render();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     STATE MACHINE
     ───────────────────────────────────────────────────────────────────────── */
  function _setGameState(newState) {
    _state = newState;

    var overlay = document.getElementById('endOverlay');
    var eyebrow = document.getElementById('endEyebrow');
    var titleEl = document.getElementById('endTitle');
    var msgEl   = document.getElementById('endMsg');

    if (newState === STATE.SUCCESS) {
      if (window.SoundSystem && SoundSystem.playVictory) SoundSystem.playVictory();
      eyebrow.textContent = 'MISSION COMPLETE';
      titleEl.textContent = 'STATION ONLINE';
      titleEl.style.color = '#00ffcc';
      msgEl.textContent   = 'The research station is now operational. Your survey data will protect this ecosystem for generations.';
      overlay.classList.remove('hidden');

    } else if (newState === STATE.DEAD) {
      eyebrow.textContent = 'OXYGEN DEPLETED';
      titleEl.textContent = 'DIVER DOWN';
      titleEl.style.color = '#ff4444';
      msgEl.textContent   = 'You ran out of air before completing the mission. The ocean still needs you.';
      overlay.classList.remove('hidden');
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SCENE SETUP — assembles environment + entities into a fresh scene
     ───────────────────────────────────────────────────────────────────────── */
  function _buildWorld() {
    var stationAirlock = null;
    if (window.EnvironmentBuilder && EnvironmentBuilder.build) {
      stationAirlock = EnvironmentBuilder.build(_scene);
      if (stationAirlock) {
        stationAirlock.name = 'station_airlock';
      }
    }

    if (window.EntityManager && EntityManager.buildAll) {
      EntityManager.buildAll(_scene);
      _interactables = EntityManager.getInteractables();
    } else {
      _interactables = [];
    }

    if (stationAirlock && _interactables.indexOf(stationAirlock) === -1) {
      _interactables.push(stationAirlock);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     START GAME — called from DIVE IN click
     ───────────────────────────────────────────────────────────────────────── */
  function _startGame() {
    if (window.SoundSystem) {
      if (SoundSystem.init) SoundSystem.init();
      if (SoundSystem.resume) SoundSystem.resume();
      if (SoundSystem.startOceanHum) SoundSystem.startOceanHum();
      if (SoundSystem.startBubbleLoop) SoundSystem.startBubbleLoop();
    }

    if (window.InputController && InputController.enableGyro) {
      InputController.enableGyro(_rig).catch(function (err) {
        console.info('[Main] Gyro unavailable:', err.message);
      });
    }

    _scene.add(_rig);
    _buildWorld();
    _clock.start();
    _state = STATE.DIVING;

    var startOv = document.getElementById('overlay');
    if (startOv) {
      startOv.style.transition = 'opacity 0.9s';
      startOv.style.opacity    = '0';
      setTimeout(function () { startOv.classList.add('hidden'); }, 900);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RESET — zero-allocation in-place reset between sessions
     ───────────────────────────────────────────────────────────────────────── */
  function _reset() {
    _oxygen        = 100;
    speciesScanned = 0;
    _speciesScanned = 0;
    pollutionCount = 0;
    _pollutionDone = 0;
    _stationDone   = false;

    gazeTarget     = null;
    _gazeTarget    = null;
    gazeTime       = 0;
    _gazeTime      = 0;
    gazeProgress   = 0;
    _gazeProgress  = 0;

    // In-place entity reset: restores visibility, position, and interactables list
    if (window.EntityManager && EntityManager.reset) {
      EntityManager.reset();
      _interactables = EntityManager.getInteractables();
    }

    // Reset station lights if altered
    if (_scene) {
      _scene.traverse(function (obj) {
        if (obj.isPointLight && obj.intensity > 4.5) {
          obj.intensity = 2.2;
          obj.color.set(0x00e5ff);
          obj.distance  = 12;
        }
      });
      var airlock = _scene.getObjectByName('station_airlock');
      if (airlock && _interactables.indexOf(airlock) === -1) {
        _interactables.push(airlock);
      }
    }

    if (window.InputController && InputController.reset) {
      InputController.reset();
    }

    _clock.start();

    var endOverlay = document.getElementById('endOverlay');
    if (endOverlay) endOverlay.classList.add('hidden');
    _state = STATE.DIVING;

    if (window.SoundSystem && SoundSystem.startBubbleLoop) {
      SoundSystem.startBubbleLoop();
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RESIZE
     ───────────────────────────────────────────────────────────────────────── */
  function _onResize() {
    _W = window.innerWidth;
    _H = window.innerHeight;
    if (_renderer) _renderer.setSize(_W, _H);
    var aspect = (_W / 2) / _H;
    if (_camL) { _camL.aspect = aspect; _camL.updateProjectionMatrix(); }
    if (_camR) { _camR.aspect = aspect; _camR.updateProjectionMatrix(); }
    if (_hud)  { _hud.width = _W; _hud.height = _H; }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BOOTSTRAP
     ───────────────────────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    _initRenderer();
    _initHUD();
    _initBgParticles();

    if (window.InputController && InputController.init) {
      InputController.init(_rig);
    }

    _attachTorch();

    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0x041b33);

    _lastTS = performance.now();
    requestAnimationFrame(_loop);

    var lo = document.getElementById('loadingOverlay');
    if (lo) setTimeout(function () { lo.style.display = 'none'; }, 380);

    // ── DIVE IN ──
    var diveBtn = document.getElementById('diveBtn');
    if (diveBtn) {
      diveBtn.addEventListener('click', function () {
        try {
          var el = document.documentElement;
          if (el.requestFullscreen) el.requestFullscreen().catch(function () {});
          else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        } catch (e) {}
        try {
          if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape').catch(function () {});
          }
        } catch (e) {}
        _startGame();
      });
    }

    // ── RESTART ──
    var restartBtn = document.getElementById('restartBtn');
    if (restartBtn) {
      restartBtn.addEventListener('click', function () {
        _reset();
      });
    }

    window.addEventListener('resize', _onResize);
  });

}());
