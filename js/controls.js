/* =============================================================================
   ABYSS: Marine Explorer — js/controls.js
   MODULE 1: Vision-Only Gyroscope & Pure Palm-Driven Locomotion Engine

   CRITICAL RUNTIME ARCHITECTURE:
   1. Vision Only for Gyroscope:
      - Head rotation (Pitch, Yaw, Roll) exclusively orients the camera.
      - Full 360° unrestricted yaw via canonical W3C Euler 'YXZ' multiplied
        by _q1 (-90° X device frame to Three.js world frame) and _q0 (screen orientation).
      - Zero gyro-pitch locomotion: all code checking nose-down pitch for swimming/diving
        or nose-up pitch for ascending is completely eliminated. Head tilt NEVER triggers movement.
   2. Pure Palm-Driven Locomotion:
      - Forward locomotion is triggered ONLY when:
          window.ABYSS.HandTracker.isPalmActive === true
      - Target horizontal forward speed:
          Active   : 3.8 units/second (lerped smoothly via delta * 3.5)
          Inactive : 0.0 units/second
      - Movement is strictly projected onto the horizontal X-Z plane:
          _moveDir.set(_lookDir.x, 0, _lookDir.z).normalize()
        The player swims horizontally in whichever direction their head is facing,
        without sinking or floating due to vertical head angle.
   3. Zero Garbage Collection:
      - Pre-allocated module-level math objects (_euler, _q0, _q1, _zee, _lookDir, _moveDir).
      - Delta time clamped to 0.05s per frame (prevents simulation tunneling).
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  /* ─── Locomotion Constants ───────────────────────────────────────────────── */
  var PALM_SWIM_SPEED = 3.8;                          // Target speed when palm is active (units/sec)
  var WASD_SPEED      = 8.5;                          // Desktop keyboard debug speed (units/sec)

  /* ─── Module-Scope Scene References ─────────────────────────────────────── */
  var cameraRig    = null;                            // Holds translation + orientation
  var pitchObject  = null;                            // Child group of rig
  var activeCamera = null;                            // Active eye camera (cameraL) for gaze direction

  /* ─── Module-Scope Pre-Allocated Math Objects (Zero Runtime GC) ─────────── */
  var _euler   = new THREE.Euler();
  var _q0      = new THREE.Quaternion();
  var _q1      = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90 deg on X
  var _zee     = new THREE.Vector3(0, 0, 1);
  var _lookDir = new THREE.Vector3();
  var _moveDir = new THREE.Vector3();

  /* ─── Tracking & Orientation State ───────────────────────────────────────── */
  var gyroActive = false;

  /* ─── Locomotion Speeds & State ──────────────────────────────────────────── */
  var _currentFwdSpeed = 0;
  var swimState        = 'HOVERING';
  var velocity         = new THREE.Vector3();

  /* ─── Desktop Pointer Fallback State ─────────────────────────────────────── */
  var _keys         = {};
  var isPointerDown = false;
  var _lastX        = 0;
  var _lastY        = 0;
  var _rotY         = 0;
  var _rotX         = 0;

  /* ═══════════════════════════════════════════════════════════════════════════
     _clampRig()
     Enforces world boundaries on cameraRig within the 200x200 seabed terrain.
     ═══════════════════════════════════════════════════════════════════════════ */
  function _clampRig() {
    if (!cameraRig) return;
    cameraRig.position.x = THREE.MathUtils.clamp(cameraRig.position.x, -85,   85);
    cameraRig.position.y = THREE.MathUtils.clamp(cameraRig.position.y,  -7.5, 16.0);
    cameraRig.position.z = THREE.MathUtils.clamp(cameraRig.position.z, -95,   35);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     handleOrientation(e)
     W3C handleOrientation pipeline with full 360° yaw:
     - Head rotation (Pitch, Yaw, Roll) EXCLUSIVELY orients the camera.
     - NO clamps on rotation.y or quaternion.
     - Canonical transformation from W3C frame to Three.js Y-up world frame.
     - Applies screen orientation correction angle.
     ═══════════════════════════════════════════════════════════════════════════ */
  function handleOrientation(e) {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    if (!gyroActive) gyroActive = true;

    var alpha = THREE.MathUtils.degToRad(e.alpha); // Z rotation [0, 360]
    var beta  = THREE.MathUtils.degToRad(e.beta);  // X rotation [-180, 180]
    var gamma = THREE.MathUtils.degToRad(e.gamma); // Y rotation [-90, 90]

    var screenAngle = (window.screen && window.screen.orientation && window.screen.orientation.angle !== undefined)
      ? window.screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
    var orient = THREE.MathUtils.degToRad(screenAngle);

    // Set canonical W3C Euler angles in 'YXZ' order
    _euler.set(beta, alpha, -gamma, 'YXZ');

    if (cameraRig) {
      // Unrestricted 360° orientation: head rotation exclusively orients the camera
      cameraRig.quaternion.setFromEuler(_euler);
      cameraRig.quaternion.multiply(_q1);      // Convert from device frame to world frame
      _q0.setFromAxisAngle(_zee, -orient);     // Compensate for screen orientation
      cameraRig.quaternion.multiply(_q0);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     requestGyro()
     Async permission request flow for iOS 13+ and Android.
     MUST be triggered from a user gesture handler.
     ═══════════════════════════════════════════════════════════════════════════ */
  async function requestGyro() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        var result = await DeviceOrientationEvent.requestPermission();
        if (result !== 'granted') {
          console.warn('[ABYSS Controls] DeviceOrientation permission denied:', result);
          return false;
        }
      } catch (err) {
        console.warn('[ABYSS Controls] DeviceOrientation permission error:', err);
        return false;
      }
    }

    window.removeEventListener('deviceorientation', handleOrientation);
    window.addEventListener('deviceorientation', handleOrientation, { passive: false });
    return true;
  }

  function stopGyro() {
    gyroActive = false;
    window.removeEventListener('deviceorientation', handleOrientation);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     getCameraPitchY() & getPitchDeg()
     Used exclusively for visual orientation feedback, HUD pitch readouts,
     and In-VR exit dwell detection (looking up towards surface).
     NEVER triggers movement.
     ═══════════════════════════════════════════════════════════════════════════ */
  function getCameraPitchY() {
    if (activeCamera) {
      activeCamera.getWorldDirection(_lookDir);
    } else if (cameraRig) {
      cameraRig.getWorldDirection(_lookDir);
    } else {
      _lookDir.set(0, 0, -1);
    }
    _lookDir.normalize();
    return _lookDir.y;
  }

  function getPitchDeg() {
    var y = getCameraPitchY();
    var clampedY = THREE.MathUtils.clamp(y, -1.0, 1.0);
    return THREE.MathUtils.radToDeg(Math.asin(clampedY));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     init(inCameraRig, inPitchObject, inActiveCamera)
     ═══════════════════════════════════════════════════════════════════════════ */
  function init(inCameraRig, inPitchObject, inActiveCamera) {
    cameraRig    = inCameraRig;
    pitchObject  = inPitchObject;
    activeCamera = inActiveCamera || null;

    // Reset locomotion state
    _keys            = {};
    isPointerDown    = false;
    _rotY            = (cameraRig ? cameraRig.rotation.y : 0);
    _rotX            = 0;
    _currentFwdSpeed = 0;
    swimState        = 'HOVERING';
    velocity.set(0, 0, 0);

    /* ── Keyboard fallback (WASD desktop debug) ── */
    window.addEventListener('keydown', function (e) { _keys[e.key.toLowerCase()] = true; });
    window.addEventListener('keyup',   function (e) { _keys[e.key.toLowerCase()] = false; });

    /* ── Desktop pointer drag-look fallback (active only when gyro is off) ── */
    window.addEventListener('pointerdown', function (e) {
      if (gyroActive) return;
      isPointerDown = true;
      _lastX = e.clientX;
      _lastY = e.clientY;
    });

    window.addEventListener('pointermove', function (e) {
      if (gyroActive || !isPointerDown) return;

      var dx = e.clientX - _lastX;
      var dy = e.clientY - _lastY;
      _lastX = e.clientX;
      _lastY = e.clientY;

      _rotY -= dx * 0.003;
      _rotX -= dy * 0.003;
      _rotX  = THREE.MathUtils.clamp(_rotX, -Math.PI / 2.1, Math.PI / 2.1);

      if (cameraRig) {
        cameraRig.quaternion.setFromEuler(_euler.set(_rotX, _rotY, 0, 'YXZ'));
      }
    });

    window.addEventListener('pointerup',     function () { isPointerDown = false; });
    window.addEventListener('pointercancel', function () { isPointerDown = false; });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     update(delta)
     - Delta capped at 0.05s.
     - Pure Palm-Driven Locomotion:
         Forward movement triggered ONLY when HandTracker.isPalmActive === true.
         Target speed = 3.8 u/s (active) or 0.0 u/s (inactive), lerped at delta * 3.5.
     - Movement projected strictly onto horizontal X-Z plane:
         _moveDir.set(_lookDir.x, 0, _lookDir.z).normalize()
         Zero vertical movement from head angle — player never sinks or floats
         due to looking up or down.
     ═══════════════════════════════════════════════════════════════════════════ */
  function update(delta) {
    if (!cameraRig) return;

    // Delta capped at 0.05s per frame
    delta = Math.min(delta, 0.05);

    /* ── 1. Desktop Keyboard Translation (WASD Debug) ── */
    var fwd    = (_keys['w'] || _keys['arrowup']    ? -1 : 0)
               + (_keys['s'] || _keys['arrowdown']   ?  1 : 0);
    var strafe = (_keys['a'] || _keys['arrowleft']   ? -1 : 0)
               + (_keys['d'] || _keys['arrowright']   ?  1 : 0);

    if (fwd !== 0 || strafe !== 0) {
      _moveDir.set(strafe, 0, fwd);
      _moveDir.applyEuler(_euler.set(0, cameraRig.rotation.y, 0, 'YXZ'));
      _moveDir.y = 0;
      if (_moveDir.lengthSq() > 0.0001) _moveDir.normalize();
      cameraRig.position.addScaledVector(_moveDir, WASD_SPEED * delta);
      _clampRig();
    }

    /* ── 2. Sample World-Space Head Gaze Direction ── */
    if (activeCamera) {
      activeCamera.getWorldDirection(_lookDir);
      _lookDir.normalize();
    } else {
      cameraRig.getWorldDirection(_lookDir);
      _lookDir.normalize();
    }

    /* ── 3. Pure Palm-Driven Locomotion ──
       Forward movement is triggered ONLY when window.ABYSS.HandTracker.isPalmActive === true.
       Head tilt (pitch/roll) NEVER triggers movement.
    */
    var isPalmActive = Boolean(
      window.ABYSS &&
      window.ABYSS.HandTracker &&
      window.ABYSS.HandTracker.isPalmActive === true
    );

    var targetSpeed = isPalmActive ? PALM_SWIM_SPEED : 0.0;
    _currentFwdSpeed = THREE.MathUtils.lerp(_currentFwdSpeed, targetSpeed, Math.min(delta * 3.5, 1.0));

    if (_currentFwdSpeed < 0.005) {
      _currentFwdSpeed = 0;
    }

    swimState = (_currentFwdSpeed > 0.05) ? 'SWIMMING' : 'HOVERING';

    /* ── 4. Project Movement onto Horizontal X-Z Plane ──
       The player swims horizontally in whichever direction their head is facing,
       without sinking or floating due to vertical head angle.
    */
    if (_currentFwdSpeed > 0.001) {
      _moveDir.set(_lookDir.x, 0, _lookDir.z);
      if (_moveDir.lengthSq() > 0.0001) {
        _moveDir.normalize();
        cameraRig.position.addScaledVector(_moveDir, _currentFwdSpeed * delta);
      }
    }

    /* ── 5. World Boundary Clamp ── */
    _clampRig();

    /* ── 6. Velocity Vector Sync for HUD / Audio ── */
    if (_moveDir.lengthSq() > 0.0001) {
      velocity.set(
        _currentFwdSpeed * _moveDir.x,
        0,
        _currentFwdSpeed * _moveDir.z
      );
    } else {
      velocity.set(0, 0, 0);
    }

    /* ── 7. Rig Position Sync for Entity Proximity (Shark, etc.) ── */
    if (window.ABYSS) {
      if (!window.ABYSS._rigPosition) {
        window.ABYSS._rigPosition = new THREE.Vector3();
      }
      window.ABYSS._rigPosition.copy(cameraRig.position);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PUBLIC API — window.ABYSS.Controls
     ═══════════════════════════════════════════════════════════════════════════ */
  window.ABYSS.Controls = {
    init:              init,
    update:            update,
    getSwimState:      function () { return swimState; },
    getVelocity:       function () { return velocity; },
    requestGyro:       requestGyro,
    stopGyro:          stopGyro,
    getCameraPitchY:   getCameraPitchY,
    getPitchDeg:       getPitchDeg,
    getLookDirection:  function () { return _lookDir.clone(); },
    get gyroActive()   { return gyroActive; },
    get isGyroActive() { return gyroActive; },
    get swimStatus()   {
      return (_currentFwdSpeed > 0.05) ? 'ON' : 'OFF';
    }
  };

  // Legacy alias for backward compatibility
  window.Controls = window.ABYSS.Controls;

}());
