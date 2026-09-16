// =============================================================================
// ABYSS: Marine Explorer — main.js
// Orchestrator: renderer, SBS loop, gaze, state machine, HUD, clock.
// Depends on: audio.js, environment.js, entities.js, controls.js (loaded first)
// =============================================================================

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  // =============================================================================
  // STATE
  // =============================================================================

  var STATE = { START: 0, DIVING: 1, MISSION_COMPLETE: 2, GAME_OVER: 3 };
  var gameState = STATE.START;

  var renderer, scene, cameraRig, cameraL, cameraR;
  var clock, raycaster;
  var audioCtx = null;

  var oxygen = 100;
  var OXYGEN_DURATION = 180; // seconds

  var speciesScanned    = 0;
  var pollutionCollected = 0;
  var stationGazed      = false;

  var gazeTarget   = null;
  var gazeTime     = 0;
  var GAZE_REQUIRED = 2.0;
  var gazeProgress = 0;

  var interactables = [];
  var faunaGroups   = [];

  var torch       = null;
  var playerGlow  = null;

  var W = window.innerWidth;
  var H = window.innerHeight;

  var hudCanvas, hudCtx;
  var lastFrameTime = 0;

  // =============================================================================
  // START-SCREEN BG PARTICLES
  // =============================================================================

  function initBgParticles() {
    var c = document.getElementById('bgParticles');
    if (!c) return;
    var ctx = c.getContext('2d');
    var pts = [];

    function resize() {
      c.width  = window.innerWidth;
      c.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    for (var i = 0; i < 80; i++) {
      pts.push({
        x:  Math.random() * window.innerWidth,
        y:  Math.random() * window.innerHeight,
        r:  Math.random() * 2 + 0.5,
        vy: -(Math.random() * 0.3 + 0.1),
        op: Math.random()
      });
    }

    function draw() {
      ctx.clearRect(0, 0, c.width, c.height);
      for (var j = 0; j < pts.length; j++) {
        var p = pts[j];
        p.y += p.vy;
        if (p.y < 0) p.y = c.height;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,255,204,' + (0.25 + p.op * 0.4) + ')';
        ctx.fill();
      }
      requestAnimationFrame(draw);
    }
    draw();
  }

  // =============================================================================
  // RENDERER + CAMERAS + RIG
  // =============================================================================

  function initRenderer() {
    var canvas = document.getElementById('vrCanvas');
    renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: false,
      powerPreference: 'high-performance'
    });
    renderer.autoClear = false;
    renderer.shadowMap.enabled = false;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);

    clock = new THREE.Clock();
    raycaster = new THREE.Raycaster();
    raycaster.far = 55;

    cameraRig = new THREE.Group();

    var aspect = (W / 2) / H;
    cameraL = new THREE.PerspectiveCamera(90, aspect, 0.1, 200);
    cameraL.position.x = -0.032;
    cameraRig.add(cameraL);

    cameraR = new THREE.PerspectiveCamera(90, aspect, 0.1, 200);
    cameraR.position.x = +0.032;
    cameraRig.add(cameraR);

    cameraRig.position.set(0, 0, 0);
  }

  // =============================================================================
  // DIVE TORCH — attached to cameraRig
  // SpotLight target must also be in the scene graph.
  // Pattern: add both torch and torchTarget to cameraRig BEFORE scene.add(cameraRig).
  // =============================================================================

  function attachTorch() {
    torch = new THREE.SpotLight(0xcceeff, 2.8);
    torch.distance  = 45;
    torch.angle     = Math.PI / 5.5;
    torch.penumbra  = 0.45;
    torch.decay     = 1.2;
    torch.position.set(0, 0, 0);

    var torchTarget = new THREE.Object3D();
    torchTarget.position.set(0, 0, -1); // 1 unit ahead in rig-local space

    cameraRig.add(torch);
    cameraRig.add(torchTarget);
    torch.target = torchTarget; // set AFTER both are in cameraRig's graph

    // Bioluminescent player glow
    playerGlow = new THREE.PointLight(0x00e5ff, 0.9, 8);
    playerGlow.position.set(0, -0.5, 0);
    cameraRig.add(playerGlow);
  }

  // =============================================================================
  // HUD
  // =============================================================================

  function initHUD() {
    hudCanvas     = document.getElementById('hudCanvas');
    hudCtx        = hudCanvas.getContext('2d');
    hudCanvas.width  = W;
    hudCanvas.height = H;
  }

  // Rounded rectangle path helper
  function roundRect(ctx, x, y, w, h, r) {
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

  // =============================================================================
  // HUD DRAW — per viewport
  // =============================================================================

  function drawHUD(ctx, offsetX, eyeW, eyeH) {
    var cx = offsetX + eyeW / 2;
    var cy = eyeH / 2;
    var t  = clock.getElapsedTime();

    // --- Vignette gradients (top and bottom) ---
    var topGrad = ctx.createLinearGradient(offsetX, 0, offsetX, eyeH * 0.18);
    topGrad.addColorStop(0, 'rgba(4,27,51,0.75)');
    topGrad.addColorStop(1, 'rgba(4,27,51,0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(offsetX, 0, eyeW, eyeH * 0.18);

    var botGrad = ctx.createLinearGradient(offsetX, eyeH * 0.82, offsetX, eyeH);
    botGrad.addColorStop(0, 'rgba(4,27,51,0)');
    botGrad.addColorStop(1, 'rgba(4,27,51,0.75)');
    ctx.fillStyle = botGrad;
    ctx.fillRect(offsetX, eyeH * 0.82, eyeW, eyeH * 0.18);

    // ========================
    // TOP LEFT — OXYGEN BAR
    // ========================

    var oxyPct = Math.max(0, oxygen / 100);
    var oxyLow  = oxyPct <= 0.15;
    var oxyAmber = oxyPct <= 0.40 && !oxyLow;
    var oxyColor = oxyLow
      ? (Math.sin(t * 6) > 0 ? '#ff4444' : '#ff0000')
      : oxyAmber ? '#ffaa00' : '#00ffcc';

    var barW = eyeW * 0.26;
    var barH = 12;
    var barX = offsetX + 14;
    var barY = 16;

    // Label
    ctx.font = 'bold ' + Math.round(eyeW * 0.020) + 'px Courier New';
    ctx.fillStyle = '#00ffcc';
    ctx.textAlign = 'left';
    ctx.fillText('⬡ OXYGEN', barX, barY + barH - 2);

    // Bar track
    var bx = barX + ctx.measureText('⬡ OXYGEN  ').width;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, bx, barY, barW, barH, 3);
    ctx.fill();

    // Bar fill
    if (oxyPct > 0) {
      if (oxyLow) { ctx.shadowBlur = 10; ctx.shadowColor = oxyColor; }
      ctx.fillStyle = oxyColor;
      roundRect(ctx, bx + 2, barY + 2, Math.max(0, (barW - 4) * oxyPct), barH - 4, 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Percentage text
    ctx.fillStyle = oxyLow ? oxyColor : 'rgba(255,255,255,0.85)';
    ctx.fillText(Math.ceil(oxyPct * 100) + '%', bx + barW + 6, barY + barH - 2);

    // ========================
    // TOP RIGHT — DEPTH
    // ========================

    var depth = (42 + Math.sin(t * 0.3) * 5).toFixed(0);
    var dTxt  = 'DEPTH ' + depth + 'm';

    ctx.font = 'bold ' + Math.round(eyeW * 0.021) + 'px Courier New';
    var dW = ctx.measureText(dTxt).width + 18;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, offsetX + eyeW - dW - 12, barY, dW, barH + 2, 3);
    ctx.fill();

    ctx.fillStyle = '#00ffcc';
    ctx.textAlign = 'right';
    ctx.fillText(dTxt, offsetX + eyeW - 16, barY + barH - 1);

    // ========================
    // CENTER — RETICLE + GAZE ARC
    // ========================

    var rR = 22;

    // Outer ring
    ctx.strokeStyle = gazeProgress > 0 ? '#00ffcc' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth   = gazeProgress > 0 ? 2.5 : 1.5;
    if (gazeProgress > 0) { ctx.shadowBlur = 14; ctx.shadowColor = '#00ffcc'; }
    ctx.beginPath();
    ctx.arc(cx, cy, rR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Center dot
    ctx.fillStyle = gazeProgress > 0 ? 'rgba(0,255,204,0.95)' : 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Crosshairs
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - rR - 9, cy); ctx.lineTo(cx - rR + 5, cy);
    ctx.moveTo(cx + rR - 5, cy); ctx.lineTo(cx + rR + 9, cy);
    ctx.moveTo(cx, cy - rR - 9); ctx.lineTo(cx, cy - rR + 5);
    ctx.moveTo(cx, cy + rR - 5); ctx.lineTo(cx, cy + rR + 9);
    ctx.stroke();

    // Gaze progress arc
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
    if (gazeTarget) {
      var lblMap = {
        turtle:         'SEA TURTLE',
        jellyfish:      'JELLYFISH',
        clownfish:      'CLOWNFISH',
        mantaray:       'MANTA RAY',
        eel:            'BIOLUM. EEL',
        station_airlock: 'AIRLOCK — SCAN'
      };
      var lbl = '';
      if (gazeTarget.userData.type === 'fauna')
        lbl = lblMap[gazeTarget.userData.id] || 'SCANNING';
      else if (gazeTarget.userData.type === 'pollution')
        lbl = 'POLLUTION — COLLECT';
      else if (gazeTarget.userData.type === 'station')
        lbl = lblMap[gazeTarget.userData.id] || 'SCAN';

      if (lbl) {
        ctx.font = 'bold ' + Math.round(eyeW * 0.022) + 'px Courier New';
        var lbW = ctx.measureText(lbl).width + 24;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        roundRect(ctx, cx - lbW / 2, cy + rR + 14, lbW, 28, 6);
        ctx.fill();
        ctx.fillStyle = '#00ffcc';
        ctx.textAlign = 'center';
        ctx.fillText(lbl, cx, cy + rR + 32);
      }
    }

    // ========================
    // BOTTOM BAR
    // ========================

    var objFsz = Math.round(eyeW * 0.018);
    var objY   = eyeH - 38;

    var stReady   = speciesScanned >= 5 && pollutionCollected >= 4 && !stationGazed;
    var stState   = stationGazed ? 'UNLOCKED' : (stReady ? 'READY' : 'LOCKED');
    var stColor   = stationGazed ? '#00ff88' : (stReady ? '#ffee00' : '#4488ff');
    var line1     = '◈ ' + speciesScanned + '/5 SPECIES   ◈ ' + pollutionCollected + '/4 CLEAN';
    var line2     = 'STATION: ' + stState;

    // Station ready pulsing dot
    if (stReady) {
      var pulse = Math.abs(Math.sin(t * 3));
      ctx.fillStyle = 'rgba(' + Math.round(255 * pulse) + ',238,0,' + (0.5 + pulse * 0.5) + ')';
      ctx.beginPath();
      ctx.arc(cx, objY + objFsz + 10, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.font = 'bold ' + objFsz + 'px Courier New';
    var l1W = ctx.measureText(line1).width + 24;

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(ctx, cx - l1W / 2, objY - objFsz - 8, l1W, objFsz * 2.8 + 14, 6);
    ctx.fill();

    ctx.fillStyle = '#00ffcc';
    ctx.textAlign = 'center';
    ctx.fillText(line1, cx, objY);

    ctx.fillStyle = stColor;
    if (stationGazed) { ctx.shadowBlur = 8; ctx.shadowColor = '#00ff88'; }
    ctx.fillText(line2, cx, objY + objFsz + 8);
    ctx.shadowBlur = 0;
  }

  // =============================================================================
  // HUD FRAME — draws both eyes
  // =============================================================================

  function drawHUDFrame() {
    hudCtx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);

    if (gameState === STATE.GAME_OVER) {
      var grad = hudCtx.createRadialGradient(W / 2, H / 2, H * 0.22, W / 2, H / 2, H * 0.72);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(180,0,0,0.62)');
      hudCtx.fillStyle = grad;
      hudCtx.fillRect(0, 0, W, H);
      return;
    }

    if (gameState !== STATE.DIVING && gameState !== STATE.MISSION_COMPLETE) return;

    drawHUD(hudCtx, 0,     W / 2, H);
    drawHUD(hudCtx, W / 2, W / 2, H);

    // Center separator
    hudCtx.strokeStyle = 'rgba(0,255,204,0.10)';
    hudCtx.lineWidth   = 1;
    hudCtx.beginPath();
    hudCtx.moveTo(W / 2, 0);
    hudCtx.lineTo(W / 2, H);
    hudCtx.stroke();
  }

  // =============================================================================
  // GAZE INTERACTION
  // =============================================================================

  function processGaze(delta) {
    raycaster.setFromCamera({ x: 0, y: 0 }, cameraL);
    var hits = raycaster.intersectObjects(interactables, true);

    var hitGroup = null;
    if (hits.length > 0) {
      var obj = hits[0].object;
      if (obj.userData.faunaGroup) {
        hitGroup = obj.userData.faunaGroup;
      } else if (obj.userData.type === 'pollution' || obj.userData.type === 'station') {
        hitGroup = obj;
      } else {
        var p = obj;
        while (p.parent && p.parent !== scene) p = p.parent;
        hitGroup = p;
      }
    }

    // Ignore completed targets
    if (hitGroup) {
      if (hitGroup.userData.type === 'fauna'      && hitGroup.userData.scanned)    hitGroup = null;
      if (hitGroup.userData.type === 'pollution'  && hitGroup.userData.collected)  hitGroup = null;
      if (hitGroup.userData.type === 'station'    && stationGazed)                 hitGroup = null;
    }

    if (hitGroup) {
      if (gazeTarget !== hitGroup) { gazeTarget = hitGroup; gazeTime = 0; }
      gazeTime    += delta;
      gazeProgress = Math.min(1, gazeTime / GAZE_REQUIRED);

      if (gazeTime >= GAZE_REQUIRED) {
        executeAction(hitGroup);
        gazeTarget   = null;
        gazeTime     = 0;
        gazeProgress = 0;
      }
    } else {
      gazeTarget   = null;
      gazeTime     = 0;
      gazeProgress = 0;
    }
  }

  function executeAction(target) {
    ABYSS.Audio.playSonarPing();
    setTimeout(function () { ABYSS.Audio.playScanChime(); }, 420);

    if (target.userData.type === 'fauna' && !target.userData.scanned) {
      target.userData.scanned = true;
      speciesScanned++;

      target.traverse(function (c) {
        if (c.isMesh && c.material && c.material.emissive !== undefined) {
          var origE = c.material.emissive.clone();
          var origI = c.material.emissiveIntensity || 0;
          c.material.emissive.set(0x00ffff);
          c.material.emissiveIntensity = 2.5;
          setTimeout(function () {
            c.material.emissive.copy(origE);
            c.material.emissiveIntensity = origI;
          }, 700);
        }
      });

    } else if (target.userData.type === 'pollution' && !target.userData.collected) {
      target.userData.collected = true;
      pollutionCollected++;

      var fadeStep = 0;
      var interval = setInterval(function () {
        fadeStep += 0.07;
        if (target.material) {
          target.material.opacity = Math.max(0, target.material.opacity - 0.07);
        }
        if (fadeStep >= 1) {
          target.visible = false;
          clearInterval(interval);
        }
      }, 40);

    } else if (target.userData.type === 'station' && !stationGazed) {
      stationGazed = true;

      // Boost viewport lights to green on unlock
      scene.traverse(function (obj) {
        if (obj.isPointLight && Math.abs(obj.intensity - 2.2) < 0.15) {
          obj.intensity = 5.0;
          obj.color.set(0x00ff88);
          obj.distance = 16;
        }
      });
    }
  }

  // =============================================================================
  // SBS RENDER PASS
  // =============================================================================

  function render() {
    renderer.clear();

    renderer.setViewport(0, 0, W / 2, H);
    renderer.setScissor(0, 0, W / 2, H);
    renderer.setScissorTest(true);
    renderer.render(scene, cameraL);

    renderer.setViewport(W / 2, 0, W / 2, H);
    renderer.setScissor(W / 2, 0, W / 2, H);
    renderer.setScissorTest(true);
    renderer.render(scene, cameraR);

    drawHUDFrame();
  }

  // =============================================================================
  // MAIN LOOP
  // =============================================================================

  function loop(timestamp) {
    requestAnimationFrame(loop);

    var delta = Math.min((timestamp - lastFrameTime) / 1000, 0.1);
    lastFrameTime = timestamp;

    if (gameState === STATE.DIVING) {
      var t = clock.getElapsedTime();

      ABYSS.Controls.update(delta);
      ABYSS.Environment.update(t);
      ABYSS.Entities.update(t);
      ABYSS.Entities.updateSharkAngle(delta);

      processGaze(delta);

      oxygen -= (100 / OXYGEN_DURATION) * delta;
      oxygen  = Math.max(0, oxygen);

      if (speciesScanned >= 5 && pollutionCollected >= 4 && stationGazed) {
        setGameState(STATE.MISSION_COMPLETE);
        return;
      }
      if (oxygen <= 0) {
        setGameState(STATE.GAME_OVER);
        return;
      }

    } else if (gameState === STATE.MISSION_COMPLETE || gameState === STATE.GAME_OVER) {
      var tFrozen = clock.getElapsedTime();
      ABYSS.Environment.update(tFrozen);
      ABYSS.Entities.update(tFrozen);
    }

    if (scene && cameraL) render();
  }

  // =============================================================================
  // STATE MACHINE
  // =============================================================================

  function setGameState(newState) {
    gameState = newState;

    var gameOverlay = document.getElementById('gameOverlay');
    var overlayTitle = document.getElementById('overlayTitle');
    var overlayMsg   = document.getElementById('overlayMsg');

    if (newState === STATE.MISSION_COMPLETE) {
      ABYSS.Audio.playMissionSuccess();
      overlayTitle.textContent = 'MISSION COMPLETE';
      overlayTitle.style.color = '#00ffcc';
      overlayMsg.textContent   =
        'The research station is now operational. Your data will help protect this ecosystem for generations.';
      gameOverlay.classList.remove('hidden');

    } else if (newState === STATE.GAME_OVER) {
      overlayTitle.textContent = 'OXYGEN DEPLETED';
      overlayTitle.style.color = '#ff4444';
      overlayMsg.textContent   =
        'You ran out of oxygen before completing your mission. The ocean still needs your help.';
      gameOverlay.classList.remove('hidden');
    }
  }

  // =============================================================================
  // SCENE BUILD
  // =============================================================================

  function buildScene() {
    var result = ABYSS.Environment.build(scene);
    interactables = result.interactables.slice(); // copy

    var entities = ABYSS.Entities.createAll(scene, interactables);
    faunaGroups = entities.fauna;
  }

  // =============================================================================
  // RESET
  // =============================================================================

  function resetGame() {
    // Dispose old scene geometry
    if (scene) {
      scene.traverse(function (obj) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach(function (m) { m.dispose(); });
          } else {
            obj.material.dispose();
          }
        }
      });
      while (scene.children.length > 0) scene.remove(scene.children[0]);
    }

    oxygen            = 100;
    speciesScanned    = 0;
    pollutionCollected = 0;
    stationGazed      = false;
    gazeTarget        = null;
    gazeTime          = 0;
    gazeProgress      = 0;
    interactables     = [];
    faunaGroups       = [];

    ABYSS.Controls.resetOrientation();

    // Re-attach rig + torch into scene
    scene = new THREE.Scene();
    scene.add(cameraRig);

    buildScene();
    clock.start();

    document.getElementById('gameOverlay').classList.add('hidden');
    gameState = STATE.DIVING;
    ABYSS.Audio.startBubbleLoop(function () { return gameState === STATE.DIVING; });
  }

  // =============================================================================
  // START GAME
  // =============================================================================

  function startGame() {
    // Audio — must be inside user-gesture handler
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      ABYSS.Audio.init(audioCtx);
      ABYSS.Audio.playOceanHum();
      ABYSS.Audio.startBubbleLoop(function () { return gameState === STATE.DIVING; });
    } catch (e) {
      console.warn('[ABYSS] AudioContext blocked or unavailable:', e);
    }

    // Gyro — fail silently, fall back to pointer controls
    ABYSS.Controls.requestGyro().catch(function (err) {
      console.info('[ABYSS] Gyro unavailable, using pointer controls:', err.message);
    });

    // Build the world
    scene.add(cameraRig);
    buildScene();
    clock.start();
    gameState = STATE.DIVING;

    // Fade out start overlay
    var startOverlay = document.getElementById('overlay');
    startOverlay.style.transition = 'opacity 0.9s';
    startOverlay.style.opacity    = '0';
    setTimeout(function () {
      startOverlay.classList.add('hidden');
    }, 900);
  }

  // =============================================================================
  // RESIZE
  // =============================================================================

  function onResize() {
    W = window.innerWidth;
    H = window.innerHeight;

    if (renderer) renderer.setSize(W, H);
    if (cameraL) { cameraL.aspect = (W / 2) / H; cameraL.updateProjectionMatrix(); }
    if (cameraR) { cameraR.aspect = (W / 2) / H; cameraR.updateProjectionMatrix(); }
    if (hudCanvas) { hudCanvas.width = W; hudCanvas.height = H; }
  }

  // =============================================================================
  // BOOTSTRAP
  // =============================================================================

  document.addEventListener('DOMContentLoaded', function () {
    initRenderer();
    initHUD();
    initBgParticles();

    // Init controls (pointer/WASD listeners attached to window)
    ABYSS.Controls.init(cameraRig);

    // Attach torch BEFORE scene.add(cameraRig) happens in startGame
    attachTorch();

    // Dummy empty scene for pre-start render loop
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x041b33);

    lastFrameTime = performance.now();
    requestAnimationFrame(loop);

    // Hide loading overlay
    var lo = document.getElementById('loadingOverlay');
    if (lo) setTimeout(function () { lo.style.display = 'none'; }, 400);

    // DIVE IN button
    document.getElementById('diveBtn').addEventListener('click', function () {
      // Fullscreen + landscape lock
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

      startGame();
    });

    // RESTART button
    document.getElementById('restartBtn').addEventListener('click', function () {
      resetGame();
    });

    window.addEventListener('resize', onResize);
  });

}());
