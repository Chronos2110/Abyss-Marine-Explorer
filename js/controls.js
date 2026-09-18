/* =============================================================================
   ABYSS: Marine Explorer — js/controls.js  v5
   MODULE 1: Explicit-Thrust Locomotion — pitch decoupled from propulsion.

   ── WHAT CHANGED (v4 → v5) ──────────────────────────────────────────────────
   v4 ("pitch-to-swim"):  looking down automatically triggered forward thrust
     and looking up triggered ascent — making it impossible to hover while
     examining objects above or below eye level.

   v5 ("explicit-thrust"):  pitch/gyro controls ORIENTATION ONLY.
     Propulsion fires only on explicit key input:
       W / ↑          — thrust forward along full 3D camera vector (pitch-steered)
       S / ↓          — thrust backward
       A / ←          — strafe left  (XZ plane, yaw-relative)
       D / →          — strafe right (XZ plane, yaw-relative)
       Space          — ascend (independent vertical thrust)
       C / Shift      — descend (independent vertical thrust)

   ── LOCOMOTION MODEL ─────────────────────────────────────────────────────────
   Forward thrust:
     - Direction = camera forward vector (includes pitch).
     - Y-component is KEPT (not stripped) so pitching down while thrusting dives,
       pitching up while thrusting ascends — fully intentional, explicitly driven.
   Strafe (A/D):
     - XZ-only: yaw-relative sideways movement, no Y component.
   Vertical (Space/C):
     - Additive to whatever Y motion comes from forward thrust.
     - Hard-clamped to [FLOOR_BOUND, SURFACE_BOUND].
   Deceleration:
     - Both swimVel and vertVel lerp to 0 when their input is released.
     - Smooth stop via SWIM_DECEL_K and VERT_DECEL_K (unchanged from v4).

   ── PUBLIC API (unchanged from v4) ──────────────────────────────────────────
     init(cameraRig, pitchObject)
     update(delta)
     requestGyro()    → Promise<boolean>
     getVelocity()    → number   (current forward speed scalar, units/sec)
     getSwimState()   → 'HOVERING' | 'SWIMMING' | 'ASCENDING' | 'DIVING'
     getPitchDeg()    → number   (current pitch in degrees, + = up)
     swimStatus       → 'ON' | 'OFF'  (legacy compat)
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

window.ABYSS.Controls = (function () {
  'use strict';

  /* ─── Locomotion constants ───────────────────────────────────────────────── */
  // TUNE: forward/backward thrust speed (units/sec) — range 4.0–10.0
  var SWIM_MAX     = 6.5;
  // TUNE: strafe speed (units/sec) — range 3.0–8.0
  var STRAFE_SPEED = 4.5;
  // TUNE: vertical thrust speed (units/sec) — range 2.0–5.0
  var VERT_MAX     = 3.5;

  // TUNE: lerp acceleration factors — higher = snappier response
  var SWIM_ACCEL_K  = 3.5;   // forward/back acceleration
  var VERT_ACCEL_K  = 3.0;   // vertical acceleration

  // TUNE: deceleration (seconds to reach near-zero) — lower = shorter slide
  var SWIM_DECEL_K  = 0.08;  // forward/back decel time constant
  var VERT_DECEL_K  = 0.08;  // vertical decel time constant

  // Depth bounds (world Y) — must match environment.js seabed at Y=-8
  var FLOOR_Y       = -8;
  var SURFACE_Y     =  20;
  var FLOOR_BOUND   = FLOOR_Y   + 1.5;   // -6.5
  var SURFACE_BOUND = SURFACE_Y - 0.5;   //  19.5

  /* ─── Private state ─────────────────────────────────────────────────────── */
  var _rig   = null;
  var _pitch = null;

  var _keys          = {};
  var _isPointerDown = false;
  var _lastX         = 0;
  var _lastY         = 0;
  var _yaw           = 0;
  var _pitchAngle    = 0;   // desktop mouse drag accumulated pitch (radians)

  // [CHANGED] _swimVel is now exclusively driven by W/S input, not by pitch angle.
  var _swimVel   = 0;   // signed: + = forward, – = backward (units/sec)
  var _vertVel   = 0;   // vertical velocity (units/sec), + = up
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

    /* ── WASD / Arrow keys + Space / C / Shift ── */
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

      // [UNCHANGED] Drag updates yaw + pitch for camera orientation only.
      // No propulsion side-effect from this block.
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
       1. Read explicit thrust inputs (W/S, Space/C/Shift, A/D)
       2. Compute target forward swim velocity from W/S input ONLY
          [CHANGED] No pitch-zone logic here — pitch does NOT drive swimVel.
       3. Lerp swimVel toward target (accel) or 0 (decel)
       4. Compute target vertical velocity from Space/C input ONLY
          [CHANGED] Ascent/dive are not triggered by pitch angle alone.
       5. Lerp vertVel toward target
       6. Apply swimVel along full 3D camera-forward vector (pitch-steered)
          [CHANGED] Y-component is NO LONGER stripped — when you thrust forward
          while pitched down, you intentionally dive; pitched up, you intentionally
          ascend. This replaces both the old swim-zone AND the old vertical-zone
          for the gyro/VR case where no keyboard is available.
       7. Apply dedicated vertical velocity (Space/C) additively
       8. Enforce depth bounds
       9. Derive swimState string for HUD
      10. Publish rig position for entity proximity / radar system
  ═══════════════════════════════════════════════════════════════════════════ */
  function update(delta) {
    if (!_rig || !_pitch) return;

    /* ── 1. Read explicit thrust inputs ─────────────────────────────────────
       [CHANGED] W/S control forward/backward thrust only.
       [CHANGED] Space/C/Shift control vertical thrust only.
       [CHANGED] A/D strafe as before, XZ-plane only.
       Pitch angle is now ORIENTATION-ONLY — it is not read here for velocity.
    ── */
    var thrustFwd  = (_keys['w'] || _keys['arrowup']    ? 1 : 0)   // W = thrust forward
                   + (_keys['s'] || _keys['arrowdown']   ? -1 : 0); // S = thrust backward
    var thrustUp   = (_keys[' ']                          ? 1 : 0)   // Space = ascend
                   + (_keys['c'] || _keys['shift']        ? -1 : 0); // C/Shift = descend
    var thrustStrafe = (_keys['a'] || _keys['arrowleft']  ? -1 : 0)  // A = strafe left
                     + (_keys['d'] || _keys['arrowright']  ?  1 : 0); // D = strafe right

    /* ── 2. Target forward swim velocity — key-driven only ──────────────────
       [CHANGED] Removed all lookDownRad / SWIM_DEAD_LO / SWIM_DEAD_HI logic.
       swimVel target is now simply SWIM_MAX (or 0) based on W/S key state.
    ── */
    var targetSwimVel = thrustFwd * SWIM_MAX;   // +SWIM_MAX, 0, or –SWIM_MAX

    /* ── 3. Lerp swimVel toward target ── */
    if (Math.abs(targetSwimVel) > 0.001) {
      _swimVel = THREE.MathUtils.lerp(_swimVel, targetSwimVel,
                   Math.min(SWIM_ACCEL_K * delta, 1.0));
    } else {
      // Smooth deceleration to a full stop when no thrust key is held
      _swimVel = THREE.MathUtils.lerp(_swimVel, 0,
                   Math.min(delta / SWIM_DECEL_K, 1.0));
      if (Math.abs(_swimVel) < 0.008) _swimVel = 0;
    }

    /* ── 4. Target vertical velocity — dedicated keys only ──────────────────
       [CHANGED] Removed all lookUpRad / ASCENT_THRESH / lookDownRad / DIVE_THRESH logic.
       Vertical thrust is now exclusively Space (up) and C/Shift (down).
    ── */
    var targetVertVel = thrustUp * VERT_MAX;    // +VERT_MAX, 0, or –VERT_MAX

    /* ── 5. Lerp vertVel toward target ── */
    if (Math.abs(targetVertVel) > 0.008) {
      _vertVel = THREE.MathUtils.lerp(_vertVel, targetVertVel,
                   Math.min(VERT_ACCEL_K * delta, 1.0));
    } else {
      _vertVel = THREE.MathUtils.lerp(_vertVel, 0,
                   Math.min(delta / VERT_DECEL_K, 1.0));
      if (Math.abs(_vertVel) < 0.008) _vertVel = 0;
    }

    /* ── 6. Apply forward swim velocity — full 3D camera-forward vector ─────
       [CHANGED] No longer XZ-only. The Y component is kept so that pitching
       down while thrusting forward descends, pitching up ascends. This is the
       intentional 3D swim direction that the player is deliberately choosing.
       Without thrust (W/S), pitch alone produces ZERO movement (hover).
    ── */
    if (Math.abs(_swimVel) > 0.008) {
      // Full camera-forward vector (includes pitch rotation)
      var camFwd = new THREE.Vector3(0, 0, -1);
      // Combine rig yaw + pitch object pitch into one quaternion
      var fullQ = new THREE.Quaternion();
      fullQ.multiplyQuaternions(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, _rig.rotation.y, 0)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(_pitch.rotation.x, 0, 0))
      );
      camFwd.applyQuaternion(fullQ).normalize();
      camFwd.multiplyScalar(_swimVel * delta);
      _rig.position.add(camFwd);
    }

    /* ── 6b. Apply A/D strafe — XZ-only, yaw-relative ──────────────────────
       Strafe is always horizontal so it does not interact with pitch.
    ── */
    if (Math.abs(thrustStrafe) > 0) {
      var strafeVec = new THREE.Vector3(thrustStrafe, 0, 0);
      var yawQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, _rig.rotation.y, 0));
      strafeVec.applyQuaternion(yawQ).normalize()
               .multiplyScalar(STRAFE_SPEED * delta);
      _rig.position.add(strafeVec);
    }

    /* ── 7. Apply dedicated vertical velocity ───────────────────────────────
       Additive to the Y motion already applied by forward thrust + pitch.
    ── */
    if (Math.abs(_vertVel) > 0.008) {
      _rig.position.y += _vertVel * delta;
    }

    /* ── 8. Enforce depth bounds ── */
    _rig.position.y = THREE.MathUtils.clamp(_rig.position.y, FLOOR_BOUND, SURFACE_BOUND);
    _clampRig();

    /* ── 9. Derive swimState string for HUD ──────────────────────────────────
       [CHANGED] State is derived from actual velocity, not from pitch zone.
       'SWIMMING'  — forward or backward thrust active.
       'ASCENDING' — net upward velocity (from thrust+pitch OR Space).
       'DIVING'    — net downward velocity.
       'HOVERING'  — all velocities at rest.
    ── */
    var totalVertMotion = _vertVel;
    // Include the Y-component contribution from the forward thrust vector
    if (Math.abs(_swimVel) > 0.008) {
      totalVertMotion += Math.sin(_pitch.rotation.x) * _swimVel;
    }

    if (totalVertMotion > 0.08) {
      _swimState = 'ASCENDING';
    } else if (totalVertMotion < -0.08) {
      _swimState = 'DIVING';
    } else if (Math.abs(_swimVel) > 0.08) {
      _swimState = 'SWIMMING';
    } else {
      _swimState = 'HOVERING';
    }

    /* ── 10. Publish rig position for entity proximity / radar ── */
    if (window.ABYSS) {
      if (!window.ABYSS._rigPosition) {
        window.ABYSS._rigPosition = new THREE.Vector3();
      }
      window.ABYSS._rigPosition.copy(_rig.position);
      if (_gyroActive) {
        var yawE = new THREE.Euler().setFromQuaternion(_rig.quaternion, 'YXZ');
        window.ABYSS._rigYaw = yawE.y;
      } else {
        window.ABYSS._rigYaw = _rig.rotation.y;
      }
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
     landscape rotation.

     [CHANGED] Gyro now drives ORIENTATION ONLY — exactly as in v4, but the
     pitch value it writes to _pitch.rotation.x no longer implicitly triggers
     swimVel in update(). update() reads thrustFwd from _keys, not from pitch.

     VR/Cardboard users: tilt device to aim, tap or use a paired Bluetooth
     controller for W/S thrust. On Android the volume keys can be bound to
     W/S via a custom controller bridge if needed.
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

      // Apply to rig — orientation only, no velocity side-effect
      _rig.quaternion.copy(_gyroQ);

      // Derive pitch angle via YXZ decomposition so _pitch.rotation.x
      // correctly reflects head tilt for getPitchDeg() readout.
      // [CHANGED] This value no longer drives swimVel.
      var rigEuler = new THREE.Euler().setFromQuaternion(_gyroQ, 'YXZ');
      _pitch.rotation.x = rigEuler.x;
      _pitch.rotation.y = 0;
      _pitch.rotation.z = 0;
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PUBLIC INTERFACE — window.ABYSS.Controls  (API surface unchanged from v4)
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
      return Math.abs(_swimVel) > 0.05 ? 'ON' : 'OFF';
    }
  };

  return publicControls;

}());

