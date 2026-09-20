/* =============================================================================
   ABYSS: Marine Explorer — Navigation & Motion Control Module
   =============================================================================
   * Mouse Drag & Touch Look Controls for Desktop / Mobile Preview
   * DeviceOrientation Gyroscope Fusion for Head-Tracked Cardboard VR
   * Direct WASD + Gaze-Direction Flight Controls
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

ABYSS.Controls = (function () {
  'use strict';

  var _cameraRig = null;
  var _moveSpeed = 25.0;

  // Rotation Tracking
  var _pitch = 0; // Look up / down
  var _yaw = 0;   // Look left / right
  var _isMouseDown = false;
  var _prevMousePos = { x: 0, y: 0 };

  // Gyroscope tracking
  var _hasGyro = false;
  var _deviceOrientation = {};

  var _keys = { w: false, a: false, s: false, d: false, q: false, e: false };

  function init(cameraRig) {
    _cameraRig = cameraRig;

    // Keyboard bindings
    window.addEventListener('keydown', function (e) { _handleKey(e.key, true); });
    window.addEventListener('keyup', function (e) { _handleKey(e.key, false); });

    // Mouse Drag Look (Desktop)
    window.addEventListener('mousedown', function (e) {
      _isMouseDown = true;
      _prevMousePos = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', function () { _isMouseDown = false; });

    window.addEventListener('mousemove', function (e) {
      if (!_isMouseDown) return;
      var deltaX = e.clientX - _prevMousePos.x;
      var deltaY = e.clientY - _prevMousePos.y;

      _yaw -= deltaX * 0.003;
      _pitch -= deltaY * 0.003;
      _pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, _pitch));

      _prevMousePos = { x: e.clientX, y: e.clientY };
    });

    // Mobile Gyroscope Listener
    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', function (event) {
        if (event.alpha !== null) {
          _hasGyro = true;
          _deviceOrientation = event;
        }
      }, true);
    }
  }

  function requestGyroPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission()
        .then(function (response) {
          if (response === 'granted') {
            _hasGyro = true;
          }
        })
        .catch(console.error);
    }
  }

  function _handleKey(key, isPressed) {
    var k = key.toLowerCase();
    if (k === 'w' || k === 'arrowup') _keys.w = isPressed;
    if (k === 's' || k === 'arrowdown') _keys.s = isPressed;
    if (k === 'a' || k === 'arrowleft') _keys.a = isPressed;
    if (k === 'd' || k === 'arrowright') _keys.d = isPressed;
    if (k === 'q') _keys.q = isPressed;
    if (k === 'e') _keys.e = isPressed;
  }

  function update(delta) {
    if (!_cameraRig) return;
    var dt = Math.min(delta, 0.1);

    // Apply Orientation
    if (_hasGyro && _deviceOrientation.alpha !== undefined) {
      var alpha = THREE.MathUtils.degToRad(_deviceOrientation.alpha || 0);
      var beta = THREE.MathUtils.degToRad(_deviceOrientation.beta || 0);
      var gamma = THREE.MathUtils.degToRad(_deviceOrientation.gamma || 0);

      var euler = new THREE.Euler(beta, alpha, -gamma, 'YXZ');
      _cameraRig.quaternion.setFromEuler(euler);
    } else {
      var euler = new THREE.Euler(_pitch, _yaw, 0, 'YXZ');
      _cameraRig.quaternion.setFromEuler(euler);
    }

    // WASD Movement relative to look direction
    var moveVector = new THREE.Vector3();
    if (_keys.w) moveVector.z -= 1;
    if (_keys.s) moveVector.z += 1;
    if (_keys.a) moveVector.x -= 1;
    if (_keys.d) moveVector.x += 1;
    if (_keys.q) moveVector.y -= 1;
    if (_keys.e) moveVector.y += 1;

    if (moveVector.lengthSq() > 0) {
      moveVector.normalize();
      moveVector.applyQuaternion(_cameraRig.quaternion);
      _cameraRig.position.addScaledVector(moveVector, _moveSpeed * dt);
    }

    // Depth Bounds
    _cameraRig.position.y = Math.max(-23.5, Math.min(40.0, _cameraRig.position.y));
  }

  return {
    init: init,
    requestGyroPermission: requestGyroPermission,
    update: update
  };
})();