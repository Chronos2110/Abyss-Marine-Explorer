/* =============================================================================
   ABYSS: Marine Explorer — js/controls.js  v5
   FIX 2: Gyroscope Initialization & Touch Lockout
   
   CRITICAL RUNTIME ARCHITECTURE:
   - requestGyro(): async/await permission flow for iOS 13+ and Android.
     Invoked strictly from user-gesture handler (never on page load).
   - handleOrientation(): Latches _gyroActive = true on first valid event.
     W3C ZXY Device Frame → -90° X premultiply → Screen angle correction → cameraRig.quaternion.
     pitchObject is bypassed completely (rotation.set(0,0,0)).
   - Cached quaternion & Euler objects allocated once at module scope (zero per-frame GC).
   - Touch lockout: pointermove is a strict no-op whenever _gyroActive is true.
   - getCameraPitchDeg(): Extracts forward vector from cameraRig.quaternion when gyroActive,
     or pitchObject.rotation.x on desktop fallback.
   - Pitch Zones Locomotion (XZ-projected forward swim):
       Dead zone     :   0° → -18° (nose down) — no movement
       Swim zone     : -18° → -38° (nose down) — forward swim 0 → SWIM_MAX
       Full swim     :      > -38° (nose down) — clamped at SWIM_MAX
       Ascent        :      > +25° (nose up)   — upward velocity 0 → ASCENT_MAX
       Dive          :      < -45° (nose down) — downward velocity 0 → -DIVE_MAX
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  /* ─── Locomotion constants ───────────────────────────────────────────────── */
  var WASD_SPEED   = 8.5;       // WASD desktop debug speed (units/sec)
  var SWIM_MAX     = 6.5;       // max forward speed (units/sec)
  var SWIM_DECEL_K = 0.08;      // lerp decel factor (seconds to near-zero)
  var ASCENT_MAX   = 3.0;       // max upward speed (units/sec)
  var DIVE_MAX     = 2.5;       // max downward speed (units/sec)
  var VERT_DECEL_K = 0.08;      // lerp decel factor for vertical velocity

  // Depth bounds (world Y) — must match environment.js seabed at Y=-8
  var FLOOR_Y       = -8;
  var SURFACE_Y     =  20;
  var FLOOR_BOUND   = FLOOR_Y   + 1.5;   // -6.5
  var SURFACE_BOUND = SURFACE_Y - 0.5;   //  19.5

  // Lerp acceleration factors
  var SWIM_ACCEL_K = 3.5;
  var VERT_ACCEL_K = 3.0;

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
  var _gyroActive = false;

  /* ─── Module-scoped cached objects (Allocated ONCE, reused every frame) ─── */
  var _euler          = new THREE.Euler();
  var _q              = new THREE.Quaternion();
  var _qScreen        = new THREE.Quaternion();
  var _mDeviceToWorld = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  var _correction     = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
  var _axisZ          = new THREE.Vector3(0, 0, 1);
  var _fwdVector      = new THREE.Vector3();
  var _worldFwd       = new THREE.Vector3();
  var _swimYawQ       = new THREE.Quaternion();
  var _yawEuler       = new THREE.Euler();

  /* ─── clampRig — enforce world boundaries ───────────────────────────────── */
  function _clampRig() {
    if (!_rig) return;
    _rig.position.x = THREE.MathUtils.clamp(_rig.position.x, -55, 55);
    _rig.position.y = THREE.MathUtils.clamp(_rig.position.y, FLOOR_BOUND, SURFACE_BOUND);
    _rig.position.z = THREE.MathUtils.clamp(_rig.position.z, -85, 10);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     handleOrientation(e)
     W3C Device Frame → Three.js World Frame.
     Latches _gyroActive = true on first valid event.
     Bypasses pitchObject entirely and writes directly to cameraRig.quaternion.
     ═══════════════════════════════════════════════════════════════════════════ */
  function handleOrientation(e) {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    if (!_gyroActive) _gyroActive = true;

    // 1. Build device quaternion using ZXY order (W3C spec)
    _euler.set(
      THREE.MathUtils.degToRad(e.beta),
      THREE.MathUtils.degToRad(e.alpha),
      THREE.MathUtils.degToRad(-e.gamma),
      'ZXY'
    );
    _q.setFromEuler(_euler);

    // 2. Premultiply -90° X to convert portrait-up → world Y-up
    _q.premultiply(_correction);

    // 3. Adjust for landscape orientation lock
    var screenAngle = (window.screen && window.screen.orientation && window.screen.orientation.angle !== undefined)
      ? window.screen.orientation.angle
      : (window.orientation || 0);

    _qScreen.setFromAxisAngle(
      _axisZ,
      -THREE.MathUtils.degToRad(screenAngle)
    );
    _q.multiply(_qScreen);

    // 4. Write directly to rig — bypass pitchObject entirely
    if (_rig) {
      _rig.quaternion.copy(_q);
    }
    if (_pitch) {
      _pitch.rotation.set(0, 0, 0);
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
        var state = await DeviceOrientationEvent.requestPermission();
        if (state !== 'granted') {
          console.warn('[ABYSS Controls] DeviceOrientation permission denied:', state);
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
     getCameraPitchDeg()
     When gyroActive, extracts pitch from cameraRig.quaternion via forward vector.
     Otherwise reads pitchObject.rotation.x.
     Returns pitch in degrees: positive = nose-up, negative = nose-down (-90 to +90).
     ═══════════════════════════════════════════════════════════════════════════ */
  function getCameraPitchDeg() {
    if (_gyroActive && _rig) {
      _fwdVector.set(0, 0, -1).applyQuaternion(_rig.quaternion);
      return THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(_fwdVector.y, -1, 1)));
    }
    if (_pitch) {
      return THREE.MathUtils.radToDeg(_pitch.rotation.x);
    }
    return 0;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     init(cameraRig, pitchObject)
     ═══════════════════════════════════════════════════════════════════════════ */
  function init(cameraRig, pitchObject) {
    _rig   = cameraRig;
    _pitch = pitchObject;

    _keys          = {};
    _isPointerDown = false;
    _yaw           = 0;
    _pitchAngle    = 0;
    _swimVel       = 0;
    _vertVel       = 0;
    _swimState     = 'HOVERING';

    /* ── Keyboard fallback (WASD) ── */
    window.addEventListener('keydown', function (e) { _keys[e.key.toLowerCase()] = true;  });
    window.addEventListener('keyup',   function (e) { _keys[e.key.toLowerCase()] = false; });

    /* ── Desktop pointer drag-look (Strict lockout when gyroActive) ── */
    window.addEventListener('pointerdown', function (e) {
      if (_gyroActive) return;
      _isPointerDown = true;
      _lastX = e.clientX;
      _lastY = e.clientY;
    });

    window.addEventListener('pointermove', function (e) {
      if (!_isPointerDown || _gyroActive) return;  // gyro owns orientation
      var dx = e.clientX - _lastX;
      var dy = e.clientY - _lastY;
      _lastX = e.clientX;
      _lastY = e.clientY;

      _yaw        -= dx * 0.003;
      _pitchAngle -= dy * 0.003;
      _pitchAngle  = THREE.MathUtils.clamp(_pitchAngle, -Math.PI / 2, Math.PI / 2);

      if (_rig)   _rig.rotation.y   = _yaw;
      if (_pitch) _pitch.rotation.x = _pitchAngle;
    });

    window.addEventListener('pointerup', function () { _isPointerDown = false; });
    window.addEventListener('pointercancel', function () { _isPointerDown = false; });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     update(delta)
     Pitch-driven locomotion loop.
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
      var currentYaw = _gyroActive ? 0 : _rig.rotation.y;
      _yawEuler.set(0, currentYaw, 0);
      _swimYawQ.setFromEuler(_yawEuler);
      if (_gyroActive) {
        _swimYawQ.copy(_rig.quaternion);
      }
      wasdVec.applyQuaternion(_swimYawQ);
      wasdVec.y = 0;
      wasdVec.normalize().multiplyScalar(WASD_SPEED * delta);
      _rig.position.add(wasdVec);
      _clampRig();
    }

    /* ── 2. Read pitch angle from getCameraPitchDeg() ──
       pitchDeg > 0 → nose-up (ascent)
       pitchDeg < 0 → nose-down (swim & dive)
    ── */
    var pitchDeg    = getCameraPitchDeg();
    var lookDownDeg = -pitchDeg;   // positive when tilted nose-down
    var lookUpDeg   =  pitchDeg;   // positive when tilted nose-up

    /* ── 3. Target forward swim velocity ──
       Dead zone : 0° → 18° (nose down) — targetSwimVel = 0
       Swim zone : 18° → 38° (nose down) — linear ramp 0 → SWIM_MAX
       Full swim : > 38° (nose down) — SWIM_MAX (clamped)
    ── */
    var targetSwimVel = 0;
    if (lookDownDeg > 18 && lookDownDeg <= 38) {
      var tSwim = (lookDownDeg - 18) / (38 - 18);
      targetSwimVel = tSwim * SWIM_MAX;
    } else if (lookDownDeg > 38) {
      targetSwimVel = SWIM_MAX;
    }

    /* ── 4. Lerp swimVel toward target ── */
    if (targetSwimVel > 0.001) {
      _swimVel = THREE.MathUtils.lerp(_swimVel, targetSwimVel,
                   Math.min(SWIM_ACCEL_K * delta, 1.0));
    } else {
      _swimVel = THREE.MathUtils.lerp(_swimVel, 0,
                   Math.min(delta / SWIM_DECEL_K, 1.0));
      if (_swimVel < 0.008) _swimVel = 0;
    }

    /* ── 5. Target vertical velocity ──
       Ascent zone: lookUpDeg   > 25° (nose up)   — upward velocity 0 → ASCENT_MAX
       Dive zone  : lookDownDeg > 45° (nose down) — downward velocity 0 → -DIVE_MAX
    ── */
    var targetVertVel = 0;
    if (lookUpDeg > 25) {
      var tUp = Math.min((lookUpDeg - 25) / 45, 1.0); // 25° → 70°
      targetVertVel = tUp * ASCENT_MAX;
    } else if (lookDownDeg > 45) {
      var tDown = Math.min((lookDownDeg - 45) / 30, 1.0); // 45° → 75°
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

    /* ── 7. Apply forward swim velocity — XZ projection ONLY ── */
    if (_swimVel > 0.008) {
      if (_gyroActive) {
        _worldFwd.set(0, 0, -1).applyQuaternion(_rig.quaternion);
      } else {
        _yawEuler.set(0, _rig.rotation.y, 0);
        _swimYawQ.setFromEuler(_yawEuler);
        _worldFwd.set(0, 0, -1).applyQuaternion(_swimYawQ);
      }
      _worldFwd.y = 0;
      _worldFwd.normalize();
      _worldFwd.multiplyScalar(_swimVel * delta);
      _rig.position.add(_worldFwd);
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
     PUBLIC API — window.ABYSS.Controls
     ═══════════════════════════════════════════════════════════════════════════ */
  window.ABYSS.Controls = {
    init:              init,
    update:            update,
    requestGyro:       requestGyro,
    getVelocity:       function () { return _swimVel; },
    getSwimState:      function () { return _swimState; },
    getPitchDeg:       getCameraPitchDeg,
    getCameraPitchDeg: getCameraPitchDeg,
    get swimStatus() {
      return _swimVel > 0.05 ? 'ON' : 'OFF';
    },
    get isGyroActive() {
      return _gyroActive;
    }
  };

  // Legacy alias — backward compatible with window.Controls references
  window.Controls = window.ABYSS.Controls;

}());
