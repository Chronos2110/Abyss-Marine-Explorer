/* =============================================================================
   ABYSS: Marine Explorer — js/controls.js
   Gyro + pointer-drag look, WASD locomotion. Exposes window.InputController.
   ============================================================================= */

(function () {
  'use strict';

  /* ─── Config ──────────────────────────────────────────────────────────────── */
  var SPEED  = 8.5;                       // units / second
  var BOUNDS = {
    x: [-36,  36],
    y: [-6.4,  7.0],
    z: [-56,   6]
  };

  /* ─── State ───────────────────────────────────────────────────────────────── */
  var _rig       = null;
  var _useGyro   = false;
  var _drag      = false;
  var _lastX     = 0;
  var _lastY     = 0;
  var _rotY      = 0;      // yaw   (radians)
  var _rotX      = 0.04;  // pitch (radians)
  var _keys      = {};

  /* ─────────────────────────────────────────────────────────────────────────
     GYRO — DeviceOrientationEvent → cameraRig quaternion
     ───────────────────────────────────────────────────────────────────────── */
  function _onDeviceOrientation(evt) {
    if (evt.alpha === null && evt.beta === null && evt.gamma === null) return;
    _useGyro = true;

    var aRad = THREE.MathUtils.degToRad(evt.alpha || 0);
    var bRad = THREE.MathUtils.degToRad(evt.beta  || 0);
    var gRad = THREE.MathUtils.degToRad(evt.gamma || 0);

    var euler = new THREE.Euler(bRad, aRad, -gRad, 'YXZ');
    var q     = new THREE.Quaternion().setFromEuler(euler);

    // Portrait correction
    var q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    q.multiply(q1);

    // Screen orientation compensation
    var screenDeg = (window.screen.orientation && window.screen.orientation.angle) || 0;
    var qScreen   = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      -THREE.MathUtils.degToRad(screenDeg)
    );
    q.multiply(qScreen);

    if (_rig) _rig.quaternion.copy(q);
  }

  /* enableGyro — iOS 13+ requires requestPermission() from a user gesture */
  function enableGyro(rig) {
    _rig = rig;
    return new Promise(function (resolve, reject) {
      if (typeof DeviceOrientationEvent === 'undefined') {
        return reject(new Error('DeviceOrientationEvent not supported'));
      }
      function attach() {
        window.addEventListener('deviceorientation', _onDeviceOrientation, true);
        resolve();
      }
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
          .then(function (state) {
            if (state === 'granted') attach();
            else reject(new Error('Gyro permission denied'));
          })
          .catch(reject);
      } else {
        attach();
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     POINTER DRAG — smooth pitch / yaw mouse look
     Attached to window (not canvas) so HUD overlay doesn't block events.
     ───────────────────────────────────────────────────────────────────────── */
  function _onPointerDown(e) {
    _drag  = true;
    _lastX = e.clientX;
    _lastY = e.clientY;
  }

  function _onPointerMove(e) {
    if (!_drag || _useGyro) return;
    var dx = e.clientX - _lastX;
    var dy = e.clientY - _lastY;
    _lastX = e.clientX;
    _lastY = e.clientY;

    _rotY -= dx * 0.003;
    _rotX -= dy * 0.003;
    // Clamp pitch so orientation never flips
    _rotX = Math.max(-Math.PI / 2.05, Math.min(Math.PI / 2.05, _rotX));

    if (_rig) {
      _rig.quaternion.setFromEuler(new THREE.Euler(_rotX, _rotY, 0, 'YXZ'));
    }
  }

  function _onPointerUp() { _drag = false; }

  /* ─────────────────────────────────────────────────────────────────────────
     KEYBOARD — WASD + Arrow keys
     ───────────────────────────────────────────────────────────────────────── */
  function _onKeyDown(e) { _keys[e.code] = true; }
  function _onKeyUp(e)   { _keys[e.code] = false; }

  /* ─────────────────────────────────────────────────────────────────────────
     INIT — attach all event listeners
     ───────────────────────────────────────────────────────────────────────── */
  function init(rig) {
    _rig   = rig;
    _drag  = false;
    _useGyro = false;
    _rotY  = 0;
    _rotX  = 0.04;
    _keys  = {};

    window.addEventListener('pointerdown', _onPointerDown);
    window.addEventListener('pointermove', _onPointerMove);
    window.addEventListener('pointerup',   _onPointerUp);
    window.addEventListener('keydown',     _onKeyDown);
    window.addEventListener('keyup',       _onKeyUp);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     UPDATE — apply WASD velocity each frame
     Movement direction rotated by rig Y-axis only (no pitch tilt on translate)
     ───────────────────────────────────────────────────────────────────────── */
  function update(delta) {
    if (!_rig) return;

    var dir = new THREE.Vector3(0, 0, 0);
    if (_keys['KeyW']     || _keys['ArrowUp'])    dir.z -= 1;
    if (_keys['KeyS']     || _keys['ArrowDown'])  dir.z += 1;
    if (_keys['KeyA']     || _keys['ArrowLeft'])  dir.x -= 1;
    if (_keys['KeyD']     || _keys['ArrowRight']) dir.x += 1;

    if (dir.lengthSq() > 0) {
      dir.normalize().multiplyScalar(SPEED * delta);

      var yawEuler = new THREE.Euler(0, _rig.rotation.y, 0, 'YXZ');
      dir.applyEuler(yawEuler);
      _rig.position.add(dir);

      _rig.position.x = THREE.MathUtils.clamp(_rig.position.x, BOUNDS.x[0], BOUNDS.x[1]);
      _rig.position.y = THREE.MathUtils.clamp(_rig.position.y, BOUNDS.y[0], BOUNDS.y[1]);
      _rig.position.z = THREE.MathUtils.clamp(_rig.position.z, BOUNDS.z[0], BOUNDS.z[1]);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RESET — called between game sessions
     ───────────────────────────────────────────────────────────────────────── */
  function reset() {
    _useGyro = false;
    _drag    = false;
    _rotY    = 0;
    _rotX    = 0.04;
    _keys    = {};
    if (_rig) {
      _rig.quaternion.setFromEuler(new THREE.Euler(0.04, 0, 0, 'YXZ'));
      _rig.position.set(0, 0, 0);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
     ───────────────────────────────────────────────────────────────────────── */
  window.InputController = {
    init:       init,
    update:     update,
    reset:      reset,
    enableGyro: enableGyro
  };

}());
