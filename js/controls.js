// =============================================================================
// ABYSS: Marine Explorer — controls.js
// Gyro, pointer drag, WASD locomotion. Exposed on window.ABYSS.Controls.
// =============================================================================

window.ABYSS = window.ABYSS || {};

window.ABYSS.Controls = (function () {
  'use strict';

  var _cameraRig = null;

  // --- Look state ---
  var _useGyro   = false;
  var _isDragging = false;
  var _lastX = 0, _lastY = 0;
  var _rotY = 0, _rotX = 0.05;

  // --- WASD key state ---
  var _keys = {};
  var SPEED  = 8.0; // units per second
  var BOUNDS = {
    x: [-35,  35],
    y: [-6.5,  6.0],
    z: [-55,   5]
  };

  // =============================================================================
  // GYRO
  // =============================================================================

  function _handleOrientation(evt) {
    if (evt.alpha === null && evt.beta === null && evt.gamma === null) return;
    _useGyro = true;

    var alphaRad = THREE.MathUtils.degToRad(evt.alpha || 0);
    var betaRad  = THREE.MathUtils.degToRad(evt.beta  || 0);
    var gammaRad = THREE.MathUtils.degToRad(evt.gamma || 0);

    var euler = new THREE.Euler(betaRad, alphaRad, -gammaRad, 'YXZ');
    var q = new THREE.Quaternion().setFromEuler(euler);
    var q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    q.multiply(q1);

    var screenAngle = window.screen.orientation ? window.screen.orientation.angle : 0;
    var q0 = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      -THREE.MathUtils.degToRad(screenAngle)
    );
    q.multiply(q0);

    if (_cameraRig) _cameraRig.quaternion.copy(q);
  }

  // requestGyro — returns a Promise; resolves on grant, rejects on deny.
  // Main.js calls this inside the DIVE IN click handler (user-gesture context).
  function requestGyro() {
    return new Promise(function (resolve, reject) {
      if (typeof DeviceOrientationEvent === 'undefined') {
        reject(new Error('DeviceOrientationEvent not supported'));
        return;
      }

      function attachListener() {
        window.addEventListener('deviceorientation', _handleOrientation, true);
        resolve();
      }

      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ requires explicit permission
        DeviceOrientationEvent.requestPermission()
          .then(function (state) {
            if (state === 'granted') {
              attachListener();
            } else {
              reject(new Error('Gyro permission denied'));
            }
          })
          .catch(reject);
      } else {
        // Non-iOS — attach directly
        attachListener();
      }
    });
  }

  // =============================================================================
  // POINTER (drag-to-look)
  // Listeners attached to window so the HUD canvas overlay doesn't block events.
  // =============================================================================

  function _onPointerDown(e) {
    _isDragging = true;
    _lastX = e.clientX;
    _lastY = e.clientY;
  }

  function _onPointerMove(e) {
    if (!_isDragging || _useGyro) return;
    var dx = e.clientX - _lastX;
    var dy = e.clientY - _lastY;
    _lastX = e.clientX;
    _lastY = e.clientY;

    _rotY -= dx * 0.003;
    _rotX -= dy * 0.003;
    _rotX = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, _rotX));

    if (_cameraRig) {
      _cameraRig.quaternion.setFromEuler(new THREE.Euler(_rotX, _rotY, 0, 'YXZ'));
    }
  }

  function _onPointerUp() {
    _isDragging = false;
  }

  // =============================================================================
  // KEYBOARD (WASD + Arrow keys)
  // =============================================================================

  function _onKeyDown(e) { _keys[e.code] = true; }
  function _onKeyUp(e)   { _keys[e.code] = false; }

  // =============================================================================
  // init — attach all listeners, store rig reference
  // =============================================================================

  function init(cameraRig) {
    _cameraRig = cameraRig;
    _useGyro   = false;
    _isDragging = false;
    _rotY = 0;
    _rotX = 0.05;
    _keys = {};

    // Pointer on window (not canvas) — overlay canvas has pointer-events:none
    window.addEventListener('pointerdown', _onPointerDown);
    window.addEventListener('pointermove', _onPointerMove);
    window.addEventListener('pointerup',   _onPointerUp);

    // WASD
    window.addEventListener('keydown', _onKeyDown);
    window.addEventListener('keyup',   _onKeyUp);
  }

  // =============================================================================
  // update — apply WASD velocity to rig, enforce bounds
  // Called every frame from main.js with real delta time (seconds).
  // =============================================================================

  function update(delta) {
    if (!_cameraRig) return;

    // Build movement direction in rig-local space
    var dir = new THREE.Vector3(0, 0, 0);

    if (_keys['KeyW']     || _keys['ArrowUp'])    dir.z -= 1;
    if (_keys['KeyS']     || _keys['ArrowDown'])  dir.z += 1;
    if (_keys['KeyA']     || _keys['ArrowLeft'])  dir.x -= 1;
    if (_keys['KeyD']     || _keys['ArrowRight']) dir.x += 1;

    if (dir.lengthSq() > 0) {
      dir.normalize().multiplyScalar(SPEED * delta);

      // Rotate by Y-axis only (no pitch applied to translation)
      var yaw = new THREE.Euler(0, _cameraRig.rotation.y, 0, 'YXZ');
      dir.applyEuler(yaw);

      _cameraRig.position.add(dir);

      // Enforce bounds
      _cameraRig.position.x = THREE.MathUtils.clamp(
        _cameraRig.position.x, BOUNDS.x[0], BOUNDS.x[1]
      );
      _cameraRig.position.y = THREE.MathUtils.clamp(
        _cameraRig.position.y, BOUNDS.y[0], BOUNDS.y[1]
      );
      _cameraRig.position.z = THREE.MathUtils.clamp(
        _cameraRig.position.z, BOUNDS.z[0], BOUNDS.z[1]
      );
    }
  }

  // =============================================================================
  // Helpers for main.js to read internal state on reset
  // =============================================================================

  function resetOrientation() {
    _useGyro = false;
    _isDragging = false;
    _rotY = 0;
    _rotX = 0.05;
    if (_cameraRig) {
      _cameraRig.quaternion.setFromEuler(new THREE.Euler(0.05, 0, 0, 'YXZ'));
    }
  }

  // =============================================================================
  // Public API
  // =============================================================================

  return {
    init:             init,
    update:           update,
    requestGyro:      requestGyro,
    resetOrientation: resetOrientation
  };

}());
