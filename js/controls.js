/* =============================================================================
   ABYSS: Marine Explorer — js/controls.js  v4
   MODULE 1: True 3D Pitch-Driven Locomotion.
   Hands-free VR Box navigation: pitch-to-swim, vertical gaze steering,
   W3C DeviceOrientation gyro, WASD/pointer-drag desktop fallback.

   PITCH ZONES (per module spec):
     Dead zone     :   0° → -18°  (nose down) — no movement
     Swim zone     : -18° → -38°  (nose down) — forward swim 0 → SWIM_MAX
     Full swim     :      > -38°  (nose down) — clamped at SWIM_MAX
     Ascent        :      > +25°  (nose up)   — upward velocity 0 → ASCENT_MAX
     Dive          :      < -45°  (nose down past swim) — downward velocity

   LOCOMOTION RULES:
     - Forward swim XZ-projected only: worldFwd.y = 0 before multiply.
       This prevents the player sinking into the seabed when nose-down.
     - All velocity transitions use THREE.MathUtils.lerp for smooth ramp-up/down.
     - swimVel deceleration: lerp toward 0 at SWIM_DECEL_K per-frame.
     - Depth clamped to [FLOOR_Y+1.5, SURFACE_Y-0.5] = [-6.5, 19.5].

   PUBLIC API — window.ABYSS.Controls
     init(cameraRig, pitchObject)
     update(delta)
     requestGyro()    → Promise<boolean>
     getVelocity()    → number  (current forward speed, units/sec)
     getSwimState()   → 'HOVERING' | 'SWIMMING' | 'ASCENDING' | 'DIVING'
     getPitchDeg()    → number  (current pitch in degrees, + = up)
     swimStatus       → 'ON' | 'OFF'  (legacy tap-toggle compat)
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

window.ABYSS.Controls = (function () {
  'use strict';

  /* ─── Locomotion constants ───────────────────────────────────────────────── */
  var WASD_SPEED = 8.5;           // WASD desktop debug speed (units/sec)

  // Pitch-to-swim forward zone (nose DOWN = negative pitch.rotation.x)
  var SWIM_DEAD_LO  = THREE.MathUtils.degToRad(18);   // 18° — dead zone boundary
  var SWIM_DEAD_HI  = THREE.MathUtils.degToRad(38);   // 38° — full speed boundary
  var SWIM_MAX      = 6.5;        // max forward speed (units/sec)
  var SWIM_DECEL_K  = 0.08;       // lerp decel factor (seconds to near-zero)

  // Vertical steering zones
  var ASCENT_THRESH  = THREE.MathUtils.degToRad(25);  // +25° nose-up → start ascending
  var DIVE_THRESH    = THREE.MathUtils.degToRad(45);  // -45° nose-down → start diving
  var ASCENT_MAX     = 3.0;       // max upward speed (units/sec)
  var DIVE_MAX       = 2.5;       // max downward speed (units/sec)
  var VERT_DECEL_K   = 0.08;      // lerp decel factor for vertical velocity

  // Depth bounds (world Y) — must match environment.js seabed at Y=-8
  var FLOOR_Y         = -8;
  var SURFACE_Y       =  20;
  var FLOOR_BOUND     = FLOOR_Y   + 1.5;   // -6.5
  var SURFACE_BOUND   = SURFACE_Y - 0.5;   //  19.5

  // Lerp acceleration factors
  var SWIM_ACCEL_K  = 3.5;    // multiplied by delta for approach speed
  var VERT_ACCEL_K  = 3.0;

  /* ─── Private state ─────────────────────────────────────────────────────── */
  var _rig   = null;
  var _pitch = null;

  var _keys          = {};
  var _isPointerDown = false;
  var _lastX         = 0;
  var _lastY         = 0;
  var _yaw           = 0;
  var _pitchAngle    = 0;   // desktop mouse drag accumulated pitch (radians)

  var _swimVel   = 0;       // forward velocity (units/sec), always ≥ 0
  var _vertVel   = 0;       // vertical velocity (units/sec), + = up
  var _swimState = 'HOVERING';

  var _gyroActive  = false;
  var _gyroQ       = new THREE.Quaternion();
  var _screenAngle = 0;

  /* ─────────────────────────────────────────────────────────────────────────
     clampRig — enforce world boundaries
  ───────────────────────────────────────────────────────────────────────── */
  function _clampRig() {
    _rig.position.x = THREE.MathUtils.clamp(_rig.position.x, -55, 55);
    _rig.position.y = THREE.MathUtils.clamp(_rig.position.y, FLOOR_BOUND, SURFACE_BOUND);
    _rig.position.z = THREE.MathUtils.clamp(_rig.position.z, -85, 10);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     init(cameraRig, pitchObject)
     cameraRig    — THREE.Group that carries position + yaw
     pitchObject  — child Group inside rig that carries pitch (cameras attached)
  ═══════════════════════════════════════════════════════════════════════════ */
  function init(cameraRig, pitchObject) {
    _rig   = cameraRig;
    _pitch = pitchObject;

    // Reset mutable locomotion state for session reuse
    _keys          = {};
    _isPointerDown = false;
    _yaw           = 0;
    _pitchAngle    = 0;
    _swimVel       = 0;
    _vertVel       = 0;
    _swimState     = 'HOVERING';

    /* ── WASD / Arrow keys ── */
    window.addEventListener('keydown', function (e) { _keys[e.key.toLowerCase()] = true;  });
    window.addEventListener('keyup',   function (e) { _keys[e.key.toLowerCase()] = false; });

    /* ── Desktop pointer drag-look (disabled when gyro is active) ── */
    window.addEventListener('pointerdown', function (e) {
      _isPointerDown = true;
      _lastX = e.clientX;
      _lastY = e.clientY;
    });
    window.addEventListener('pointermove', function (e) {
      if (!_isPointerDown || _gyroActive) return;
      var dx = e.clientX - _lastX;
      var dy = e.clientY - _lastY;
      _lastX = e.clientX;
      _lastY = e.clientY;

      _yaw        -= dx * 0.003;
      _pitchAngle -= dy * 0.003;
      _pitchAngle  = THREE.MathUtils.clamp(_pitchAngle, -Math.PI / 2, Math.PI / 2);

      _rig.rotation.y   = _yaw;
      _pitch.rotation.x = _pitchAngle;
    });
    window.addEventListener('pointerup', function () { _isPointerDown = false; });

    /* ── Screen orientation for gyro axis correction ── */
    if (window.screen && window.screen.orientation) {
      window.screen.orientation.addEventListener('change', function () {
        _screenAngle = window.screen.orientation.angle || 0;
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     update(delta)

     Execution order each frame:
       1. WASD debug translation (additive, does not affect pitch-swim)
       2. Read pitch angle from _pitch.rotation.x
       3. Compute target forward swim velocity from pitch zones
       4. Lerp swimVel toward target (acceleration) or 0 (deceleration)
       5. Compute target vertical velocity from pitch zones
       6. Lerp vertVel toward target
       7. Apply swimVel as XZ-only forward displacement (no vertical drift)
       8. Apply vertVel with depth bounds
       9. Derive swimState string
      10. Publish rig position for shark proximity check (entities.js)
  ═══════════════════════════════════════════════════════════════════════════ */
  function update(delta) {
    if (!_rig || !_pitch) return;

    /* ── 1. WASD debug translation ── */
    var fwd    = (_keys['w'] || _keys['arrowup']    ? -1 : 0)
               + (_keys['s'] || _keys['arrowdown']   ?  1 : 0);
    var strafe = (_keys['a'] || _keys['arrowleft']   ? -1 : 0)
               + (_keys['d'] || _keys['arrowright']   ?  1 : 0);

    if (fwd !== 0 || strafe !== 0) {
      var wasdVec = new THREE.Vector3(strafe, 0, fwd);
      var yawQ    = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, _rig.rotation.y, 0));
      wasdVec.applyQuaternion(yawQ).normalize().multiplyScalar(WASD_SPEED * delta);
      _rig.position.add(wasdVec);
      _clampRig();
    }

    /* ── 2. Read current pitch angle ──
       pitch.rotation.x convention in Three.js:
         Negative value → camera tilted nose-DOWN (looking at seabed)
         Positive value → camera tilted nose-UP   (looking at surface)
       lookDownRad > 0  → nose-down (used for swim + dive zones)
       lookUpRad   > 0  → nose-up   (used for ascent zone)
    ── */
    var lookDownRad = -_pitch.rotation.x;   // positive = nose-down
    var lookUpRad   =  _pitch.rotation.x;   // positive = nose-up

    /* ── 3. Target forward swim velocity ──
       Dead zone    : 0       → SWIM_DEAD_LO (0°→18°)   → targetSwimVel = 0
       Swim zone    : DEAD_LO → SWIM_DEAD_HI (18°→38°)  → linear ramp 0→SWIM_MAX
       Full speed   :         > SWIM_DEAD_HI (>38°)     → SWIM_MAX (clamped)
    ── */
    var targetSwimVel = 0;
    if (lookDownRad > SWIM_DEAD_LO && lookDownRad <= SWIM_DEAD_HI) {
      var tSwim     = (lookDownRad - SWIM_DEAD_LO) / (SWIM_DEAD_HI - SWIM_DEAD_LO);
      targetSwimVel = tSwim * SWIM_MAX;
    } else if (lookDownRad > SWIM_DEAD_HI) {
      targetSwimVel = SWIM_MAX;
    }

    /* ── 4. Lerp swimVel toward target ── */
    if (targetSwimVel > 0.001) {
      _swimVel = THREE.MathUtils.lerp(_swimVel, targetSwimVel,
                   Math.min(SWIM_ACCEL_K * delta, 1.0));
    } else {
      // Smooth deceleration — lerp to zero over SWIM_DECEL_K seconds
      _swimVel = THREE.MathUtils.lerp(_swimVel, 0,
                   Math.min(delta / SWIM_DECEL_K, 1.0));
      if (_swimVel < 0.008) _swimVel = 0;
    }

    /* ── 5. Target vertical velocity ──
       Ascent zone: lookUpRad   > ASCENT_THRESH (+25°→+70° maps to 0→ASCENT_MAX)
       Dive zone  : lookDownRad > DIVE_THRESH   (-45° onward → negative vertVel)
       Dive does NOT overlap swim: swim ends at 38°, dive begins at 45°.
       Between 38° and 45° = dead zone for vertical (only horizontal swim).
    ── */
    var targetVertVel = 0;
    if (lookUpRad > ASCENT_THRESH) {
      // Ramp: +25° → +70° gives 0 → ASCENT_MAX
      var tUp       = Math.min((lookUpRad - ASCENT_THRESH) / THREE.MathUtils.degToRad(45), 1.0);
      targetVertVel = tUp * ASCENT_MAX;
    } else if (lookDownRad > DIVE_THRESH) {
      // Ramp: -45° → -75° gives 0 → -DIVE_MAX
      var tDown     = Math.min((lookDownRad - DIVE_THRESH) / THREE.MathUtils.degToRad(30), 1.0);
      targetVertVel = -tDown * DIVE_MAX;
    }

    /* ── 6. Lerp vertVel toward target ── */
    if (Math.abs(targetVertVel) > 0.008) {
      _vertVel = THREE.MathUtils.lerp(_vertVel, targetVertVel,
                   Math.min(VERT_ACCEL_K * delta, 1.0));
    } else {
      _vertVel = THREE.MathUtils.lerp(_vertVel, 0,
                   Math.min(delta / VERT_DECEL_K, 1.0));
      if (Math.abs(_vertVel) < 0.008) _vertVel = 0;
    }

    /* ── 7. Apply forward swim velocity — XZ projection ONLY ──
       Project camera forward onto the XZ plane before applying.
       This prevents the player from sinking toward the seabed
       just because they are swimming with a nose-down pitch.
    ── */
    if (_swimVel > 0.008) {
      var worldFwd = new THREE.Vector3(0, 0, -1);
      var swimYawQ = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, _rig.rotation.y, 0)
      );
      worldFwd.applyQuaternion(swimYawQ);
      worldFwd.y = 0;               // strip vertical component
      worldFwd.normalize();
      worldFwd.multiplyScalar(_swimVel * delta);
      _rig.position.add(worldFwd);
    }

    /* ── 8. Apply vertical velocity with hard depth bounds ── */
    if (Math.abs(_vertVel) > 0.008) {
      _rig.position.y += _vertVel * delta;
    }
    _rig.position.y = THREE.MathUtils.clamp(_rig.position.y, FLOOR_BOUND, SURFACE_BOUND);
    _clampRig();

    /* ── 9. Derive swimState string for HUD ── */
    if (_vertVel > 0.08) {
      _swimState = 'ASCENDING';
    } else if (_vertVel < -0.08) {
      _swimState = 'DIVING';
    } else if (_swimVel > 0.08) {
      _swimState = 'SWIMMING';
    } else {
      _swimState = 'HOVERING';
    }

    /* ── 10. Publish rig position for entity proximity checks ── */
    if (window.ABYSS) {
      if (!window.ABYSS._rigPosition) {
        window.ABYSS._rigPosition = new THREE.Vector3();
      }
      window.ABYSS._rigPosition.copy(_rig.position);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     requestGyro() → Promise<boolean>
     Must be called INSIDE a user-gesture handler (iOS 13+ requirement).
     On Android non-permission browsers the deviceorientation event fires
     immediately — resolve after first valid event.
  ═══════════════════════════════════════════════════════════════════════════ */
  function requestGyro() {
    // iOS 13+ requires explicit permission request
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      return DeviceOrientationEvent.requestPermission().then(function (res) {
        if (res !== 'granted') return _gyroFallback();
        return _waitForFirstGyroEvent();
      }).catch(function () {
        return _gyroFallback();
      });
    }

    // Android / desktop — attempt without permission
    return _waitForFirstGyroEvent();
  }

  function _waitForFirstGyroEvent() {
    return new Promise(function (resolve) {
      var timeout = setTimeout(function () {
        resolve(_gyroFallback());
      }, 1500);

      window.addEventListener('deviceorientation', function handler(e) {
        if (e.alpha === null && e.beta === null && e.gamma === null) return;
        clearTimeout(timeout);
        window.removeEventListener('deviceorientation', handler);
        _attachGyro();
        resolve(true);
      });
    });
  }

  function _gyroFallback() {
    console.warn('[ABYSS Controls] Gyro unavailable — using pointer/WASD controls');
    _gyroActive = false;
    return false;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     _attachGyro()
     W3C DeviceOrientationEvent → Three.js quaternion, Y-up frame.
     Pre-multiplied by −90° X to convert from W3C device frame (Z-up) to
     Three.js world frame (Y-up). Screen orientation quaternion corrects for
     landscape rotation without conditional axis-swap logic.

     After applying to rig.quaternion we extract pitch via YXZ Euler so that
     pitch.rotation.x correctly feeds the swim-zone calculations in update().
  ═══════════════════════════════════════════════════════════════════════════ */
  function _attachGyro() {
    _gyroActive = true;

    var _euler   = new THREE.Euler();
    var _screenQ = new THREE.Quaternion();
    var _worldQ  = new THREE.Quaternion();
    _worldQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

    window.addEventListener('deviceorientation', function (e) {
      if (e.alpha === null) return;

      var alpha = THREE.MathUtils.degToRad(e.alpha);
      var beta  = THREE.MathUtils.degToRad(e.beta);
      var gamma = THREE.MathUtils.degToRad(e.gamma);

      _euler.set(beta, alpha, -gamma, 'ZXY');
      _gyroQ.setFromEuler(_euler);
      _gyroQ.premultiply(_worldQ);

      // Screen orientation correction (landscape mode)
      _screenAngle = (window.screen.orientation && window.screen.orientation.angle)
        ? window.screen.orientation.angle : 0;
      _screenQ.setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        -THREE.MathUtils.degToRad(_screenAngle)
      );
      _gyroQ.multiply(_screenQ);

      // Apply to rig — full 6DOF orientation
      _rig.quaternion.copy(_gyroQ);

      // Derive pitch angle via YXZ decomposition so swim zones read correctly
      // even when rig.rotation.y is mixed into the quaternion
      var rigEuler = new THREE.Euler().setFromQuaternion(_gyroQ, 'YXZ');
      _pitch.rotation.x = rigEuler.x;
      _pitch.rotation.y = 0;
      _pitch.rotation.z = 0;
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PUBLIC INTERFACE — window.ABYSS.Controls
  ═══════════════════════════════════════════════════════════════════════════ */
  var publicControls = {
    init:         init,
    update:       update,
    requestGyro:  requestGyro,
    getVelocity:  function () { return _swimVel; },
    getSwimState: function () { return _swimState; },
    getPitchDeg:  function () {
      // Returns current pitch in degrees (+up, -down) from pitch object
      if (_pitch) return THREE.MathUtils.radToDeg(_pitch.rotation.x);
      return 0;
    },
    get swimStatus() {
      return _swimVel > 0.05 ? 'ON' : 'OFF';
    }
  };

  return publicControls;

}());
