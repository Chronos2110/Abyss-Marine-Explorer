/* =============================================================================
   ABYSS: Marine Explorer — js/controls.js  v7
   1:1 Head Steering & Landscape Gyroscope Pipeline
   
   CRITICAL RUNTIME ARCHITECTURE:
   - Controls.init(cameraRig, pitchObject, cameraL):
     cameraL reference stored at module scope exclusively for direction sampling.
   - Module-scoped allocations (Zero Runtime Allocation Rule):
     _lookDir, _flatDir, _euler, _q0, _q1, _qFinal, _forwardVec allocated once.
   - Locomotion Zones (Y-component thresholds on normalized _lookDir):
       HOVERING  : _lookDir.y >= -0.20 && _lookDir.y <=  0.28 → velocity lerps to 0
       SWIMMING  : _lookDir.y <  -0.20 && _lookDir.y >= -0.68 → forward thrust along XZ
       DIVING    : _lookDir.y <  -0.68                         → downward Y thrust, reduced XZ
       ASCENDING : _lookDir.y >   0.28                         → upward Y thrust, reduced XZ
   - Forward heading extracted via XZ-projection (_flatDir) — no Y bleed into horizontal thrust.
   - Vertical velocity lerped separately and independently.
   - Position clamped to: X [-40, 40], Y [-7, 8], Z [-60, 10].
   - Gyroscope Pipeline:
       W3C YXZ device frame → Right-multiply _q1 (-90° X) →
       Left-multiply _q0 (screen orientation angle) → cameraRig.quaternion.
       pitchObject is bypassed and zeroed out.
   - Touch lockout: pointermove and pointerdown are strict no-ops when gyroActive === true.
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  /* ─── Locomotion constants ───────────────────────────────────────────────── */
  var WASD_SPEED = 8.5;       // WASD desktop debug speed (units/sec)

  /* ─── Module-scope references ────────────────────────────────────────────── */
  var cameraRig   = null;
  var pitchObject = null;
  var cameraL     = null;

  /* ─── Module-scope cached allocations (Zero per-frame GC) ────────────────── */
  var _lookDir    = new THREE.Vector3();
  var _flatDir    = new THREE.Vector3();
  var _euler      = new THREE.Euler();
  var _q0         = new THREE.Quaternion(); // screen orientation correction
  var _q1         = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° X, constant
  var _qFinal     = new THREE.Quaternion();
  var _forwardVec = new THREE.Vector3();

  var velocity         = new THREE.Vector3();
  var currentSwimSpeed = 0;
  var swimState        = 'HOVERING';
  var gyroActive       = false;
  var isPointerDown    = false;

  var _keys          = {};
  var _lastX         = 0;
  var _lastY         = 0;
  var _yaw           = 0;
  var _pitchAngle    = 0;

  /* ─── clampRig — enforce world boundaries ───────────────────────────────── */
  function _clampRig() {
    if (!cameraRig) return;
    cameraRig.position.x = THREE.MathUtils.clamp(cameraRig.position.x, -40,  40);
    cameraRig.position.y = THREE.MathUtils.clamp(cameraRig.position.y,  -7,   8);
    cameraRig.position.z = THREE.MathUtils.clamp(cameraRig.position.z, -60,  10);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     handleOrientation(e)
     W3C Device Frame → Three.js World Frame.
     Latches gyroActive = true on first valid event.
     Bypasses pitchObject entirely and writes directly to cameraRig.quaternion.
     ═══════════════════════════════════════════════════════════════════════════ */
  function handleOrientation(e) {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    if (!gyroActive) gyroActive = true;

    // Step 1: W3C device frame → Three.js using YXZ (correct for landscape)
    _euler.set(
      THREE.MathUtils.degToRad(e.beta),   // X: device tilt front/back
      THREE.MathUtils.degToRad(e.alpha),  // Y: compass heading
      THREE.MathUtils.degToRad(-e.gamma), // Z: device roll (negated)
      'YXZ'
    );
    _qFinal.setFromEuler(_euler);

    // Step 2: Right-multiply to correct portrait-up → world Y-up (_q1 is constant)
    _qFinal.multiply(_q1);

    // Step 3: Left-multiply for current screen orientation (re-read every event)
    var screenAngle = (window.screen && window.screen.orientation && window.screen.orientation.angle !== undefined)
      ? window.screen.orientation.angle
      : (window.orientation || 0);

    _q0.setFromAxisAngle(
      _forwardVec.set(0, 0, 1),
      -THREE.MathUtils.degToRad(screenAngle)
    );
    _qFinal.premultiply(_q0);

    // Step 4: Write to rig only — pitchObject stays zeroed
    if (cameraRig) {
      cameraRig.quaternion.copy(_qFinal);
    }
    if (pitchObject) {
      pitchObject.rotation.set(0, 0, 0);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     requestGyro()
     Async permission flow. Call strictly from a user-gesture handler.
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
    window.addEventListener('deviceorientation', handleOrientation, { passive: false });
    return true;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     getCameraPitchY() & getPitchDeg()
     Samples cameraL direction directly (already normalized by Three.js, with
     explicit normalization defense).
     ═══════════════════════════════════════════════════════════════════════════ */
  function getCameraPitchY() {
    if (cameraL) {
      cameraL.getWorldDirection(_lookDir);
      _lookDir.normalize();
      return _lookDir.y;
    }
    return 0;
  }

  function getPitchDeg() {
    if (cameraL) {
      cameraL.getWorldDirection(_lookDir);
      _lookDir.normalize();
      var clampedY = Math.max(-1.0, Math.min(1.0, _lookDir.y));
      return THREE.MathUtils.radToDeg(Math.asin(clampedY));
    }
    return 0;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     init(inCameraRig, inPitchObject, inCameraL)
     Store all three references at module scope.
     cameraL is used exclusively for direction sampling.
     ═══════════════════════════════════════════════════════════════════════════ */
  function init(inCameraRig, inPitchObject, inCameraL) {
    cameraRig   = inCameraRig;
    pitchObject = inPitchObject;
    cameraL     = inCameraL || null;

    _keys            = {};
    isPointerDown    = false;
    _yaw             = 0;
    _pitchAngle      = 0;
    velocity.set(0, 0, 0);
    currentSwimSpeed = 0;
    swimState        = 'HOVERING';

    /* ── Keyboard fallback (WASD) ── */
    window.addEventListener('keydown', function (e) { _keys[e.key.toLowerCase()] = true;  });
    window.addEventListener('keyup',   function (e) { _keys[e.key.toLowerCase()] = false; });

    /* ── Touch / Pointer Lockout (Strict lockout when gyroActive) ── */
    window.addEventListener('pointerdown', function (e) {
      if (gyroActive) return;
      isPointerDown = true;
      _lastX = e.clientX;
      _lastY = e.clientY;
    });

    window.addEventListener('pointermove', function (e) {
      if (!isPointerDown || gyroActive) return;
      var dx = e.clientX - _lastX;
      var dy = e.clientY - _lastY;
      _lastX = e.clientX;
      _lastY = e.clientY;

      _yaw        -= dx * 0.003;
      _pitchAngle -= dy * 0.003;
      _pitchAngle  = THREE.MathUtils.clamp(_pitchAngle, -Math.PI / 2, Math.PI / 2);

      if (cameraRig)   cameraRig.rotation.y   = _yaw;
      if (pitchObject) pitchObject.rotation.x = _pitchAngle;
    });

    window.addEventListener('pointerup',     function () { isPointerDown = false; });
    window.addEventListener('pointercancel', function () { isPointerDown = false; });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     update(delta)
     Called every frame AFTER cameraL.updateMatrixWorld() has been invoked.
     ═══════════════════════════════════════════════════════════════════════════ */
  function update(delta) {
    if (!cameraRig || !pitchObject) return;

    /* ── 1. WASD debug translation (desktop fallback) ── */
    var fwd    = (_keys['w'] || _keys['arrowup']    ? -1 : 0)
               + (_keys['s'] || _keys['arrowdown']   ?  1 : 0);
    var strafe = (_keys['a'] || _keys['arrowleft']   ? -1 : 0)
               + (_keys['d'] || _keys['arrowright']   ?  1 : 0);

    if (fwd !== 0 || strafe !== 0) {
      var wasdVec = _forwardVec.set(strafe, 0, fwd);
      var currentYaw = gyroActive ? 0 : cameraRig.rotation.y;
      var wasdQ = _q0.setFromEuler(_euler.set(0, currentYaw, 0));
      if (gyroActive) {
        wasdQ.copy(cameraRig.quaternion);
      }
      wasdVec.applyQuaternion(wasdQ);
      wasdVec.y = 0;
      if (wasdVec.lengthSq() > 0.0001) wasdVec.normalize();
      cameraRig.position.addScaledVector(wasdVec, WASD_SPEED * delta);
      _clampRig();
    }

    /* ── 2. Sample gaze direction from cameraL ── */
    if (cameraL) {
      cameraL.getWorldDirection(_lookDir);
      _lookDir.normalize();
    } else {
      _lookDir.set(0, 0, -1);
    }

    /* ── 3. Locomotion zones based on _lookDir.y ──
       HOVERING  : >= -0.20 && <= 0.28 → all velocity lerps to 0
       SWIMMING  : <  -0.20 && >= -0.68 → forward thrust along XZ heading
       DIVING    : <  -0.68             → downward Y thrust, reduced XZ
       ASCENDING : >   0.28             → upward Y thrust, reduced XZ
    ── */
    var targetSwimSpeed = 0;

    if (_lookDir.y > 0.28) {
      // ASCENDING
      swimState = 'ASCENDING';
      targetSwimSpeed = 1.5; // reduced XZ
      velocity.y = THREE.MathUtils.lerp(velocity.y, 2.8, delta * 4.0);
    } else if (_lookDir.y < -0.68) {
      // DIVING
      swimState = 'DIVING';
      targetSwimSpeed = 1.8; // reduced XZ
      velocity.y = THREE.MathUtils.lerp(velocity.y, -2.5, delta * 4.0);
    } else if (_lookDir.y < -0.20) {
      // SWIMMING (forward thrust along XZ heading, neutral vertical)
      swimState = 'SWIMMING';
      // t: 0 at boundary (-0.20), 1 at full swim (-0.68)
      var t = Math.min(1.0, (_lookDir.y + 0.20) / -0.48);
      targetSwimSpeed = THREE.MathUtils.lerp(0, 6.5, t);
      velocity.y = THREE.MathUtils.lerp(velocity.y, 0.0, delta * 4.0);
    } else {
      // HOVERING (-0.20 <= _lookDir.y <= 0.28)
      swimState = 'HOVERING';
      targetSwimSpeed = 0.0;
      velocity.y = THREE.MathUtils.lerp(velocity.y, 0.0, delta * 4.0);
    }

    // Lerp horizontal swim speed
    currentSwimSpeed = THREE.MathUtils.lerp(
      currentSwimSpeed,
      targetSwimSpeed,
      Math.min(delta * 3.5, 1.0)
    );
    if (currentSwimSpeed < 0.008 && targetSwimSpeed === 0) {
      currentSwimSpeed = 0;
    }

    // Forward heading extraction: project lookDir onto XZ plane (no Y bleed)
    _flatDir.set(_lookDir.x, 0, _lookDir.z);
    if (_flatDir.lengthSq() > 0.0001) {
      _flatDir.normalize();
    }

    velocity.x = _flatDir.x * currentSwimSpeed;
    velocity.z = _flatDir.z * currentSwimSpeed;

    // Zero out velocity when hovering and nearly stopped
    if (swimState === 'HOVERING' && currentSwimSpeed === 0 && Math.abs(velocity.y) < 0.008) {
      velocity.set(0, 0, 0);
    }

    /* ── 4. Position Integration & Clamping ── */
    cameraRig.position.addScaledVector(velocity, delta);
    _clampRig();

    /* ── 5. Publish rig position for entity proximity checks (shark, etc.) ── */
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
    get gyroActive()   { return gyroActive; },
    get isGyroActive() { return gyroActive; },
    getCameraPitchY:   getCameraPitchY,
    getPitchDeg:       getPitchDeg,
    get swimStatus() {
      return (Math.abs(velocity.x) > 0.05 || Math.abs(velocity.z) > 0.05) ? 'ON' : 'OFF';
    }
  };

  // Legacy alias — backward compatible with window.Controls references
  window.Controls = window.ABYSS.Controls;

}());
