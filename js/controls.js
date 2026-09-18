/* =============================================================================
   ABYSS: Marine Explorer — js/controls.js  v9
   1:1 Head Steering & Landscape Gyroscope Pipeline

   CRITICAL RUNTIME ARCHITECTURE:
   - Controls.init(cameraRig, pitchObject, cameraL):
     cameraL reference stored at module scope exclusively for direction sampling.
   - Module-scoped allocations (Zero Runtime Allocation Rule):
     _lookDir, _moveDir, _euler, _q0, _q1, _zee allocated once at parse time.
   - Gyroscope Pipeline (ZXY — canonical W3C landscape):
       Step 1: _euler.set(beta, alpha, -gamma, 'ZXY') → cameraRig.quaternion.setFromEuler()
       Step 2: Right-multiply _q1 (constant -90° X) → cameraRig.quaternion.multiply(_q1)
       Step 3: Right-multiply _q0 (dynamic screen orient on Z) → multiply(_q0)
       pitchObject is zeroed and bypassed entirely.
   - Touch lockout: pointermove immediately returns when gyroActive === true.
   - Locomotion Zones (Y-component of normalized _lookDir):
       HOVERING  : -0.20 <= y <= +0.30 → full stop, speeds lerp to 0
       SWIMMING  : -0.65 <= y <  -0.20 → fwd 1.5→6.5 u/s ramp
       Dead-band : -0.70 <= y <  -0.65 → fwd clamped at 6.5 u/s, no Y thrust
       DIVING    :          y <  -0.70 → vert -2.5 u/s, reduced fwd 1.8 u/s
       ASCENDING :          y >  +0.30 → vert +2.8 u/s, gentle 2.0 u/s fwd
   - Forward translation: strictly XZ via _moveDir — zero Y-bleed.
   - Vertical translation: applied directly to cameraRig.position.y.
   - Position clamped: X [-40, 40], Y [-7.0, 8.0], Z [-60, 10].
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  /* ─── Locomotion constants ───────────────────────────────────────────────── */
  var WASD_SPEED = 8.5;        // WASD desktop debug speed (units/sec)

  /* ─── Module-scope scene references ─────────────────────────────────────── */
  var cameraRig   = null;
  var pitchObject = null;
  var cameraL     = null;      // left-eye camera — sole source of world direction

  /* ─── Module-scope cached allocations — Zero per-frame GC ───────────────── */
  // Gyro working objects
  var _zee   = new THREE.Vector3(0, 0, 1);           // Z-axis for screen orient correction
  var _euler = new THREE.Euler();                     // reused every orientation event
  var _q0    = new THREE.Quaternion();               // screen orientation compensation
  var _q1    = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° X, constant

  // Locomotion working objects
  var _lookDir = new THREE.Vector3();                // world-space gaze direction from cameraL
  var _moveDir = new THREE.Vector3();                // XZ-only forward translation vector

  /* ─── Per-frame locomotion state ────────────────────────────────────────── */
  var _currentFwdSpeed  = 0;   // lerped horizontal swim speed (units/sec)
  var _currentVertSpeed = 0;   // lerped vertical speed (units/sec, signed)
  var swimState         = 'HOVERING';
  var gyroActive        = false;
  var isPointerDown     = false;

  /* ─── Desktop drag state ─────────────────────────────────────────────────── */
  var _keys       = {};
  var _lastX      = 0;
  var _lastY      = 0;
  var _yaw        = 0;
  var _pitchAngle = 0;

  /* ─── Public velocity vector — kept for API compatibility ────────────────── */
  // velocity.x/.z are informational (fwd * lookDir components).
  // velocity.y mirrors _currentVertSpeed for external callers (HUD, audio, etc.).
  var velocity = new THREE.Vector3();

  /* ═══════════════════════════════════════════════════════════════════════════
     _clampRig()
     Enforce world-space position boundaries on cameraRig.
     ═══════════════════════════════════════════════════════════════════════════ */
  function _clampRig() {
    if (!cameraRig) return;
    cameraRig.position.x = THREE.MathUtils.clamp(cameraRig.position.x, -40,  40);
    cameraRig.position.y = THREE.MathUtils.clamp(cameraRig.position.y,  -7,   8);
    cameraRig.position.z = THREE.MathUtils.clamp(cameraRig.position.z, -60,  10);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     handleOrientation(e)
     Canonical W3C → Three.js landscape pipeline using ZXY Euler order.

     WHY ZXY (not YXZ):
       The W3C DeviceOrientationEvent defines alpha/beta/gamma as intrinsic ZXY
       rotations in the device frame. Using ZXY preserves that convention and
       eliminates the cross-axis swap (tilt↔pan confusion) that occurs when YXZ
       is applied in landscape orientation.

     Pipeline:
       1. ZXY Euler from raw sensor radians → setFromEuler → quaternion.
       2. Right-multiply _q1 (-90° X): rotates portrait-Y-up sensor frame to
          landscape Three.js world Y-up frame.
       3. Right-multiply _q0 (screen orient on Z): compensates for landscape
          rotation angle without corrupting primary axes.
       4. Write to cameraRig.quaternion; zero pitchObject so it never fights
          the gyro transform.
     ═══════════════════════════════════════════════════════════════════════════ */
  function handleOrientation(e) {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    if (!gyroActive) gyroActive = true;

    // Step 1: ZXY Euler — canonical W3C device frame (values in radians)
    _euler.set(
      THREE.MathUtils.degToRad(e.beta),    // X: device tilt front/back
      THREE.MathUtils.degToRad(e.alpha),   // Y: compass/azimuth heading
      THREE.MathUtils.degToRad(-e.gamma),  // Z: device roll (negated for Three.js handedness)
      'ZXY'
    );
    cameraRig.quaternion.setFromEuler(_euler);

    // Step 2: Right-multiply constant -90° X correction
    cameraRig.quaternion.multiply(_q1);

    // Step 3: Right-multiply dynamic screen orientation correction about Z-axis
    var orient = (window.screen && window.screen.orientation &&
                  window.screen.orientation.angle !== undefined)
      ? THREE.MathUtils.degToRad(window.screen.orientation.angle)
      : (typeof window.orientation === 'number'
          ? THREE.MathUtils.degToRad(window.orientation)
          : 0);

    _q0.setFromAxisAngle(_zee, -orient);
    cameraRig.quaternion.multiply(_q0);

    // Step 4: Zero pitchObject — must never fight or double-apply gyro transforms
    if (pitchObject) {
      pitchObject.rotation.set(0, 0, 0);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     requestGyro()
     Async iOS 13+ permission flow. MUST be called from inside a user gesture.
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
     Sample cameraL world-space direction for HUD readout only.
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
     Call once from main.js _initRenderer() and again on _reset().
     inCameraL = left-eye PerspectiveCamera; used only for getWorldDirection().
     ═══════════════════════════════════════════════════════════════════════════ */
  function init(inCameraRig, inPitchObject, inCameraL) {
    cameraRig   = inCameraRig;
    pitchObject = inPitchObject;
    cameraL     = inCameraL || null;

    // Reset locomotion state in-place (zero allocations)
    _keys             = {};
    isPointerDown     = false;
    _yaw              = 0;
    _pitchAngle       = 0;
    _currentFwdSpeed  = 0;
    _currentVertSpeed = 0;
    swimState         = 'HOVERING';
    velocity.set(0, 0, 0);

    /* ── Keyboard fallback (WASD / arrow keys) — desktop debug ── */
    window.addEventListener('keydown', function (e) { _keys[e.key.toLowerCase()] = true;  });
    window.addEventListener('keyup',   function (e) { _keys[e.key.toLowerCase()] = false; });

    /* ── Pointer/Touch — hard lockout when gyroActive ── */
    window.addEventListener('pointerdown', function (e) {
      if (gyroActive) return;   // physical sensors take priority
      isPointerDown = true;
      _lastX = e.clientX;
      _lastY = e.clientY;
    });

    window.addEventListener('pointermove', function (e) {
      if (gyroActive) return;   // hard lockout — immediately exit, no processing at all
      if (!isPointerDown) return;

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
     Called every frame by main.js AFTER _rig and _camL updateMatrixWorld().

     Locomotion model:
       - _lookDir sampled fresh from cameraL.getWorldDirection() each frame.
       - _currentFwdSpeed  lerps toward targetFwdSpeed  at (delta * 4.0).
       - _currentVertSpeed lerps toward targetVertSpeed at (delta * 4.0).
       - Forward: _moveDir = normalize(_lookDir.x, 0, _lookDir.z) * fwdSpeed * delta
                  → strictly XZ, zero Y-bleed regardless of gaze pitch.
       - Vertical: cameraRig.position.y += _currentVertSpeed * delta
                  → independent of forward, no axis coupling.
     ═══════════════════════════════════════════════════════════════════════════ */
  function update(delta) {
    if (!cameraRig || !pitchObject) return;

    /* ── 1. WASD keyboard translation — desktop fallback ── */
    var fwd    = (_keys['w'] || _keys['arrowup']    ? -1 : 0)
               + (_keys['s'] || _keys['arrowdown']   ?  1 : 0);
    var strafe = (_keys['a'] || _keys['arrowleft']   ? -1 : 0)
               + (_keys['d'] || _keys['arrowright']   ?  1 : 0);

    if (fwd !== 0 || strafe !== 0) {
      _moveDir.set(strafe, 0, fwd);
      if (gyroActive) {
        // On device: orient WASD by full rig quaternion
        _moveDir.applyQuaternion(cameraRig.quaternion);
      } else {
        // Desktop: orient by rig yaw only
        _moveDir.applyEuler(_euler.set(0, cameraRig.rotation.y, 0, 'YXZ'));
      }
      _moveDir.y = 0;
      if (_moveDir.lengthSq() > 0.0001) _moveDir.normalize();
      cameraRig.position.addScaledVector(_moveDir, WASD_SPEED * delta);
      _clampRig();
    }

    /* ── 2. Sample world-space gaze direction from the left-eye camera ── */
    if (cameraL) {
      cameraL.getWorldDirection(_lookDir);
      _lookDir.normalize();
    } else {
      _lookDir.set(0, 0, -1);   // safe fallback: forward along -Z
    }

    /* ── 3. Classify locomotion zone from _lookDir.y ──────────────────────────
       Zone boundaries (spec-exact):
         HOVERING  : -0.20 <= y <= +0.30  → full stop; all speeds lerp to 0
         SWIMMING  : -0.65 <= y <  -0.20  → fwd ramp 1.5→6.5 u/s, vert neutral
         Dead-band : -0.70 <= y <  -0.65  → fwd stays at 6.5 u/s, vert neutral
         DIVING    :          y <  -0.70  → vert -2.5 u/s, fwd 1.8 u/s (reduced)
         ASCENDING :          y >  +0.30  → vert +2.8 u/s, gentle 2.0 u/s fwd
    ── */
    var targetFwdSpeed  = 0;
    var targetVertSpeed = 0;

    if (_lookDir.y > 0.30) {
      // ── ASCENDING: tilted nose-up toward the surface ──
      swimState       = 'ASCENDING';
      targetFwdSpeed  = 2.0;    // gentle forward drift during ascent
      targetVertSpeed = 2.8;    // upward velocity (units/sec)

    } else if (_lookDir.y < -0.70) {
      // ── DIVING: steep nose-down gaze into the trench ──
      swimState       = 'DIVING';
      targetFwdSpeed  = 1.8;    // reduced horizontal while diving
      targetVertSpeed = -2.5;   // downward velocity (units/sec)

    } else if (_lookDir.y < -0.20) {
      // ── SWIMMING: gaze angled slightly down toward the reef ──
      //    t ramps 0→1 from -0.20 to -0.65; dead-band [-0.65, -0.70] clamps at 1.0
      swimState = 'SWIMMING';
      var t = Math.min(1.0, (_lookDir.y + 0.20) / -0.45);   // window width = 0.45
      targetFwdSpeed  = THREE.MathUtils.lerp(1.5, 6.5, t);  // 1.5→6.5 u/s
      targetVertSpeed = 0;

    } else {
      // ── HOVERING: gaze near horizon [-0.20, +0.30] ──
      swimState       = 'HOVERING';
      targetFwdSpeed  = 0;
      targetVertSpeed = 0;
    }

    /* ── 4. Lerp all speeds toward targets ── */
    _currentFwdSpeed  = THREE.MathUtils.lerp(_currentFwdSpeed,  targetFwdSpeed,  delta * 4.0);
    _currentVertSpeed = THREE.MathUtils.lerp(_currentVertSpeed, targetVertSpeed, delta * 4.0);

    // Snap micro-speeds to zero when hovering — prevents endless micro-drift
    if (swimState === 'HOVERING') {
      if (Math.abs(_currentFwdSpeed)  < 0.008) _currentFwdSpeed  = 0;
      if (Math.abs(_currentVertSpeed) < 0.008) _currentVertSpeed = 0;
    }

    /* ── 5. Translate cameraRig ──────────────────────────────────────────────
       Forward: XZ projection of _lookDir → normalize → scale → add to position.
                Strictly horizontal — no Y bleed regardless of gaze pitch.
       Vertical: applied independently to position.y — no coupling to forward.
    ── */
    if (_currentFwdSpeed !== 0) {
      _moveDir.set(_lookDir.x, 0, _lookDir.z);
      if (_moveDir.lengthSq() > 0.0001) {
        _moveDir.normalize().multiplyScalar(_currentFwdSpeed * delta);
        cameraRig.position.add(_moveDir);
      }
    }

    if (_currentVertSpeed !== 0) {
      cameraRig.position.y += _currentVertSpeed * delta;
    }

    /* ── 6. World boundary clamp ── */
    _clampRig();

    /* ── 7. Sync public velocity vector for external callers (HUD, audio) ── */
    velocity.set(
      _currentFwdSpeed * _lookDir.x,
      _currentVertSpeed,
      _currentFwdSpeed * _lookDir.z
    );

    /* ── 8. Publish rig position for entity proximity checks (shark, etc.) ── */
    if (window.ABYSS) {
      if (!window.ABYSS._rigPosition) {
        window.ABYSS._rigPosition = new THREE.Vector3();
      }
      window.ABYSS._rigPosition.copy(cameraRig.position);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PUBLIC API — window.ABYSS.Controls
     All existing call sites in main.js, entities.js, audio.js preserved.
     ═══════════════════════════════════════════════════════════════════════════ */
  window.ABYSS.Controls = {
    init:              init,
    update:            update,
    getSwimState:      function () { return swimState; },
    getVelocity:       function () { return velocity; },
    requestGyro:       requestGyro,
    getCameraPitchY:   getCameraPitchY,
    getPitchDeg:       getPitchDeg,
    get gyroActive()   { return gyroActive; },
    get isGyroActive() { return gyroActive; },   // legacy alias
    get swimStatus()   {
      return (_currentFwdSpeed > 0.05) ? 'ON' : 'OFF';
    }
  };

  // Legacy alias — backward compatible with window.Controls references
  window.Controls = window.ABYSS.Controls;

}());
