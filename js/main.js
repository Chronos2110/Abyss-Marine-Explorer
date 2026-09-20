/* =============================================================================
   ABYSS: Marine Explorer — Main Orchestrator & Stereoscopic VR Engine
   =============================================================================
   * Core WebGL Dual-Camera Stereoscopic Rendering (IPD Synchronized)
   * Real-Time Gaze Raycasting & Target Acquisition System
   * Dual-Eye HUD Canvas Overlay (Compass, Oxygen, Mission, Sonar Radar)
   * Mission Logic: Fauna Scanning & Hazardous Debris Cleansing
   * Submarine Vitals (Oxygen Depletion, Depth Telemetry, Speed)
   * Game State Machine (MAIN_MENU, PLAYING, GAME_OVER, VICTORY)
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  // Game States
  var STATE = {
    MENU: 'MENU',
    PLAYING: 'PLAYING',
    GAMEOVER: 'GAMEOVER',
    VICTORY: 'VICTORY'
  };

  var _currentState = STATE.MENU;

  // Three.js Core
  var _scene = null;
  var _renderer = null;
  var _cameraRig = null;
  var _cameraL = null;
  var _cameraR = null;

  // Canvas HUD Overlay
  var _hudCanvas = null;
  var _hudCtx = null;
  var _interactables = [];
  var _clock = new THREE.Clock();

  // Raycasting & Gaze
  var _raycaster = new THREE.Raycaster();
  var _gazeTarget = null;
  var _gazeTimer = 0.0;
  var GAZE_DURATION = 1.5; // Seconds to complete scan/clean action

  // Vitals & Mission Metrics
  var _oxygen = 100.0;
  var OXYGEN_BASE_DEPLETION_RATE = 0.04; // ~4 minutes total dive time
  var _scannedCount = 0;
  var _cleanedCount = 0;
  var _totalDebrisCount = 0;
  var _totalFaunaCount = 0;

  // Radar / Sonar Pulse
  var _sonarSweepAngle = 0.0;
  var _sonarTimer = 0.0;
  var SONAR_INTERVAL = 3.0;

  function init() {
    // 1. WebGL Canvas & Renderer Setup
    var vrCanvas = document.getElementById('vrCanvas');
    _renderer = new THREE.WebGLRenderer({ canvas: vrCanvas, antialias: true, alpha: false });
    _renderer.setSize(window.innerWidth, window.innerHeight);
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // 2. HUD Canvas Setup
    _hudCanvas = document.getElementById('hudCanvas');
    _hudCtx = _hudCanvas.getContext('2d');
    _resizeHUD();

    // 3. Scene Creation
    _scene = new THREE.Scene();

    // 4. Camera Rig & Dual Stereoscopic Eyes
    _cameraRig = new THREE.Group();
    _cameraRig.position.set(0, -10, 30);
    _scene.add(_cameraRig);

    var ipd = 0.064; // Interpupillary distance (~64mm)
    var aspect = (window.innerWidth / 2) / window.innerHeight;

    _cameraL = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000);
    _cameraL.position.set(-ipd / 2, 0, 0);
    _cameraRig.add(_cameraL);

    _cameraR = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000);
    _cameraR.position.set(ipd / 2, 0, 0);
    _cameraRig.add(_cameraR);

    // 5. Subsystems Initialization
    if (ABYSS.Controls) ABYSS.Controls.init(_cameraRig);
    if (ABYSS.Environment) ABYSS.Environment.init(_scene, _interactables);
    if (ABYSS.Entities) ABYSS.Entities.init(_scene, _interactables);

    // Count totals for mission check
    _countMissionTargets();

    // 6. Bind Event Listeners
    window.addEventListener('resize', _onWindowResize, false);
    _bindUIEvents();

    // Hide loader overlay once loaded
    var loader = document.getElementById('loadingOverlay');
    if (loader) loader.classList.add('hidden');

    // Launch Loop
    _animate();
  }

  function _countMissionTargets() {
    _totalDebrisCount = 0;
    _totalFaunaCount = 0;

    _interactables.forEach(function (obj) {
      if (obj.userData) {
        if (obj.userData.type === 'debris') _totalDebrisCount++;
        if (obj.userData.type === 'fauna') _totalFaunaCount++;
      }
    });
  }

  function _bindUIEvents() {
    var startBtn = document.getElementById('startBtn');
    var restartBtn = document.getElementById('restartBtn');

    if (startBtn) {
      startBtn.addEventListener('click', function () {
        var overlay = document.getElementById('overlay');
        if (overlay) overlay.classList.add('hidden');

        _currentState = STATE.PLAYING;

        if (ABYSS.Controls && ABYSS.Controls.requestGyroPermission) {
          ABYSS.Controls.requestGyroPermission();
        }
        if (ABYSS.Audio) {
          ABYSS.Audio.startAmbient();
          ABYSS.Audio.playSonarPing();
        }
      });
    }

    if (restartBtn) {
      restartBtn.addEventListener('click', function () {
        location.reload();
      });
    }
  }

  function _onWindowResize() {
    var w = window.innerWidth;
    var h = window.innerHeight;

    _renderer.setSize(w, h);

    var aspect = (w / 2) / h;
    _cameraL.aspect = aspect;
    _cameraL.updateProjectionMatrix();

    _cameraR.aspect = aspect;
    _cameraR.updateProjectionMatrix();

    _resizeHUD();
  }

  function _resizeHUD() {
    if (!_hudCanvas) return;
    _hudCanvas.width = window.innerWidth;
    _hudCanvas.height = window.innerHeight;
  }

  // ===========================================================================
  // GAME LOGIC & GAZE RAYCASTING
  // ===========================================================================

  function _updateGaze(delta) {
    if (_currentState !== STATE.PLAYING) return;

    var rayDirection = new THREE.Vector3(0, 0, -1);
    rayDirection.applyQuaternion(_cameraRig.quaternion);

    _raycaster.set(_cameraRig.position, rayDirection);
    _raycaster.far = 100.0;

    var intersects = _raycaster.intersectObjects(_interactables, true);

    if (intersects.length > 0) {
      var hitObject = intersects[0].object;

      // Crawl up hierarchy to find group with userData if hit mesh child
      while (hitObject.parent && hitObject.parent !== _scene && (!hitObject.userData || !hitObject.userData.type)) {
        hitObject = hitObject.parent;
      }

      if (hitObject && hitObject.userData && hitObject.userData.type) {
        var data = hitObject.userData;

        // Skip if already completed
        if ((data.type === 'fauna' && data.scanned) || (data.type === 'debris' && data.cleaned)) {
          _gazeTarget = null;
          _gazeTimer = 0.0;
          return;
        }

        if (_gazeTarget === hitObject) {
          _gazeTimer += delta;

          if (ABYSS.Audio) {
            ABYSS.Audio.playScanBeep(_gazeTimer / GAZE_DURATION);
          }

          if (_gazeTimer >= GAZE_DURATION) {
            _executeGazeAction(hitObject);
            _gazeTimer = 0.0;
            _gazeTarget = null;
          }
        } else {
          _gazeTarget = hitObject;
          _gazeTimer = 0.0;
        }
        return;
      }
    }

    _gazeTarget = null;
    _gazeTimer = 0.0;
  }

  function _executeGazeAction(target) {
    var data = target.userData;

    if (data.type === 'fauna' && !data.scanned) {
      data.scanned = true;
      _scannedCount++;
      if (ABYSS.Audio) ABYSS.Audio.playSuccess();
    } else if (data.type === 'debris' && !data.cleaned) {
      data.cleaned = true;
      _cleanedCount++;
      target.visible = false;
      if (ABYSS.Audio) ABYSS.Audio.playCleanEffect();
    }

    _checkMissionObjectives();
  }

  function _updateVitals(delta) {
    if (_currentState !== STATE.PLAYING) return;

    _oxygen -= OXYGEN_BASE_DEPLETION_RATE * delta * 10;
    _oxygen = Math.max(0, _oxygen);

    if (_oxygen <= 0) {
      _triggerEndGame(false, "OXYGEN EXHAUSTED: SUBMERSIBLE LIFE SUPPORT FAILED");
    }
  }

  function _updateSonar(delta) {
    if (_currentState !== STATE.PLAYING) return;

    _sonarSweepAngle += delta * 2.5;
    if (_sonarSweepAngle > Math.PI * 2) {
      _sonarSweepAngle -= Math.PI * 2;
    }

    _sonarTimer += delta;
    if (_sonarTimer >= SONAR_INTERVAL) {
      _sonarTimer = 0;
      if (ABYSS.Audio) ABYSS.Audio.playSonarPing();
    }
  }

  function _checkMissionObjectives() {
    if (_cleanedCount >= _totalDebrisCount && _totalDebrisCount > 0) {
      _triggerEndGame(true, "MISSION SUCCESS: OCEAN TRENCH CLEARED OF TOXIC WASTE");
    }
  }

  function _triggerEndGame(isVictory, message) {
    _currentState = isVictory ? STATE.VICTORY : STATE.GAMEOVER;

    var gameOverModal = document.getElementById('gameOverlay');
    var titleElem = document.getElementById('overlayTitle');
    var msgElem = document.getElementById('overlayMsg');

    if (titleElem) titleElem.innerText = isVictory ? "MISSION COMPLETE" : "SYSTEM FAILURE";
    if (msgElem) msgElem.innerText = message;
    if (gameOverModal) gameOverModal.classList.remove('hidden');
  }

  // ===========================================================================
  // CANVAS HUD & STEREOSCOPIC RETICLE RENDERER
  // ===========================================================================

  function _drawHUD() {
    _hudCtx.clearRect(0, 0, _hudCanvas.width, _hudCanvas.height);

    var w = _hudCanvas.width;
    var h = _hudCanvas.height;
    var halfW = w / 2;

    // Render left eye HUD and right eye HUD separately
    _drawEyeHUD(0, 0, halfW, h);
    _drawEyeHUD(halfW, 0, halfW, h);
  }

  function _drawEyeHUD(offsetX, offsetY, eyeW, eyeH) {
    var centerX = offsetX + eyeW / 2;
    var centerY = offsetY + eyeH / 2;

    _hudCtx.save();

    // 1. Compass / Heading Tape (Top Center)
    _drawCompassTape(centerX, offsetY + 35);

    // 2. Oxygen Vitals Gauge (Top Center under Compass)
    _drawOxygenBar(centerX, offsetY + 65);

    // 3. Sonar Radar Display (Bottom Left of Eye Viewport)
    _drawSonarRadar(offsetX + 70, offsetY + eyeH - 70);

    // 4. Mission Status Telemetry (Bottom Right of Eye Viewport)
    _drawMissionTelemetry(offsetX + eyeW - 120, offsetY + eyeH - 70);

    // 5. Tactical Center Crosshair & Gaze Ring
    _drawCrosshairs(centerX, centerY);

    _hudCtx.restore();
  }

  function _drawCompassTape(cx, cy) {
    var euler = new THREE.Euler().setFromQuaternion(_cameraRig.quaternion, 'YXZ');
    var headingDeg = Math.round(THREE.MathUtils.radToDeg(-euler.y)) % 360;
    if (headingDeg < 0) headingDeg += 360;

    _hudCtx.fillStyle = '#00ffcc';
    _hudCtx.font = 'bold 12px Orbitron, monospace';
    _hudCtx.textAlign = 'center';
    _hudCtx.fillText("HDG: " + headingDeg + "°", cx, cy);

    // Compass Bar Frame
    _hudCtx.strokeStyle = 'rgba(0, 255, 204, 0.4)';
    _hudCtx.lineWidth = 1;
    _hudCtx.strokeRect(cx - 60, cy + 5, 120, 4);

    // Tick indicator
    _hudCtx.fillStyle = '#00ffcc';
    _hudCtx.fillRect(cx - 2, cy + 3, 4, 8);
  }

  function _drawOxygenBar(cx, cy) {
    var width = 140;
    var height = 8;
    var x = cx - width / 2;

    _hudCtx.fillStyle = 'rgba(0, 255, 204, 0.2)';
    _hudCtx.fillRect(x, cy, width, height);

    var pct = _oxygen / 100.0;
    _hudCtx.fillStyle = pct < 0.25 ? '#ff0266' : '#00ffcc';
    _hudCtx.fillRect(x, cy, width * pct, height);

    _hudCtx.strokeStyle = '#00ffcc';
    _hudCtx.lineWidth = 1;
    _hudCtx.strokeRect(x, cy, width, height);

    _hudCtx.fillStyle = '#ffffff';
    _hudCtx.font = '9px Orbitron, monospace';
    _hudCtx.textAlign = 'center';
    _hudCtx.fillText("OXYGEN RESERVES: " + Math.round(_oxygen) + "%", cx, cy - 4);
  }

  function _drawSonarRadar(rx, ry) {
    var radius = 42;

    // Radar Frame
    _hudCtx.beginPath();
    _hudCtx.arc(rx, ry, radius, 0, Math.PI * 2);
    _hudCtx.fillStyle = 'rgba(1, 15, 30, 0.65)';
    _hudCtx.fill();
    _hudCtx.strokeStyle = '#00ffcc';
    _hudCtx.lineWidth = 1.5;
    _hudCtx.stroke();

    // Concentric Rings
    _hudCtx.beginPath();
    _hudCtx.arc(rx, ry, radius * 0.5, 0, Math.PI * 2);
    _hudCtx.strokeStyle = 'rgba(0, 255, 204, 0.25)';
    _hudCtx.stroke();

    // Radar Sweep Line
    _hudCtx.beginPath();
    _hudCtx.moveTo(rx, ry);
    _hudCtx.lineTo(rx + Math.cos(_sonarSweepAngle) * radius, ry + Math.sin(_sonarSweepAngle) * radius);
    _hudCtx.strokeStyle = 'rgba(0, 255, 204, 0.8)';
    _hudCtx.stroke();

    // Blips for Interactables on Radar
    var subPos = _cameraRig.position;
    var subYaw = new THREE.Euler().setFromQuaternion(_cameraRig.quaternion, 'YXZ').y;

    _interactables.forEach(function (obj) {
      if (!obj.visible) return;

      var dx = obj.position.x - subPos.x;
      var dz = obj.position.z - subPos.z;
      var dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < 180) {
        var angle = Math.atan2(dz, dx) - subYaw - Math.PI / 2;
        var rDist = (dist / 180) * radius;

        var blipX = rx + Math.cos(angle) * rDist;
        var blipY = ry + Math.sin(angle) * rDist;

        _hudCtx.fillStyle = obj.userData.type === 'debris' ? '#ff3300' : '#00ffaa';
        _hudCtx.beginPath();
        _hudCtx.arc(blipX, blipY, 2.5, 0, Math.PI * 2);
        _hudCtx.fill();
      }
    });

    // Submarine Center Point
    _hudCtx.fillStyle = '#ffffff';
    _hudCtx.fillRect(rx - 1.5, ry - 1.5, 3, 3);
  }

  function _drawMissionTelemetry(tx, ty) {
    var depth = Math.max(0, Math.round(26.0 - _cameraRig.position.y));

    _hudCtx.fillStyle = '#00ffcc';
    _hudCtx.font = '10px Orbitron, monospace';
    _hudCtx.textAlign = 'right';

    _hudCtx.fillText("DEPTH: " + depth + ".0 M", tx, ty - 20);
    _hudCtx.fillText("FAUNA SCANNED: " + _scannedCount + " / " + _totalFaunaCount, tx, ty - 6);
    _hudCtx.fillText("DEBRIS CLEARED: " + _cleanedCount + " / " + _totalDebrisCount, tx, ty + 8);
  }

  function _drawCrosshairs(cx, cy) {
    _hudCtx.strokeStyle = _gazeTarget ? '#ff0055' : '#00ffcc';
    _hudCtx.lineWidth = _gazeTarget ? 3 : 1.5;

    // Crosshair Outer Ring
    _hudCtx.beginPath();
    _hudCtx.arc(cx, cy, 10, 0, Math.PI * 2);
    _hudCtx.stroke();

    // Center Dot
    _hudCtx.fillStyle = _gazeTarget ? '#ff0055' : '#00ffcc';
    _hudCtx.fillRect(cx - 1.5, cy - 1.5, 3, 3);

    // Dynamic Gaze Progress Ring
    if (_gazeTarget && _gazeTimer > 0) {
      var progress = Math.min(1.0, _gazeTimer / GAZE_DURATION);

      _hudCtx.strokeStyle = '#ff0055';
      _hudCtx.lineWidth = 4;
      _hudCtx.beginPath();
      _hudCtx.arc(cx, cy, 22, -Math.PI / 2, (-Math.PI / 2) + (Math.PI * 2 * progress));
      _hudCtx.stroke();

      // Label Overlay
      var targetName = _gazeTarget.userData.name || "TARGET";
      _hudCtx.fillStyle = '#ffffff';
      _hudCtx.font = 'bold 11px Orbitron, monospace';
      _hudCtx.textAlign = 'center';
      _hudCtx.fillText(targetName.toUpperCase(), cx, cy + 40);
      _hudCtx.fillText("SCANNING " + Math.round(progress * 100) + "%", cx, cy + 54);
    }
  }

  // ===========================================================================
  // MAIN RENDER & ANIMATION LOOP
  // ===========================================================================

  function _animate() {
    requestAnimationFrame(_animate);

    var delta = _clock.getDelta();
    var time = _clock.getElapsedTime();

    // Subsystem Frame Updates
    if (ABYSS.Controls) ABYSS.Controls.update(delta);
    if (ABYSS.Environment) ABYSS.Environment.update(delta, time);
    if (ABYSS.Entities) ABYSS.Entities.update(delta, time);

    _updateVitals(delta);
    _updateSonar(delta);
    _updateGaze(delta);

    _drawHUD();

    // Force rigid transformation update on rig & camera children
    _cameraRig.updateMatrixWorld(true);

    var w = window.innerWidth;
    var h = window.innerHeight;

    _renderer.setScissorTest(true);

    // Left Eye Pass
    _renderer.setViewport(0, 0, w / 2, h);
    _renderer.setScissor(0, 0, w / 2, h);
    _renderer.render(_scene, _cameraL);

    // Right Eye Pass
    _renderer.setViewport(w / 2, 0, w / 2, h);
    _renderer.setScissor(w / 2, 0, w / 2, h);
    _renderer.render(_scene, _cameraR);

    _renderer.setScissorTest(false);
  }

  // DOM Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();