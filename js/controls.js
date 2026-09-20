/* =============================================================================
   ABYSS: Marine Explorer — js/controls.js  v6
   MODULE 1: Gaze-Driven Locomotion — pitch steers both orientation AND propulsion.

   ── WHAT CHANGED (v5 → v6) ──────────────────────────────────────────────────
   v5 ("explicit-thrust"): pitch controlled orientation only; propulsion
     required explicit W/S key input — no hands-free movement possible.
     This made Cardboard/gyro play unworkable without a controller.

   v6 ("gaze-driven"):  pitch drives BOTH orientation AND forward speed.
     The camera look direction is the engine — glancing down dives forward,
     looking up ascends forward, and near-level pitch gives a gentle cruise.

   ── LOCOMOTION MODEL ─────────────────────────────────────────────────────────
   Three pitch zones, evaluated every frame from _pitch.rotation.x:

   1. NEUTRAL HOVER BAND  (|pitchDeg| ≤ NEUTRAL_BAND_DEG  i.e. ±5°)
      → targetSpeed = NEUTRAL_CRUISE (1.2 u/s gentle drift forward).
        Player is never fully frozen — they always drift slowly ahead.

   2. PITCH ZONE  (|pitchDeg| > NEUTRAL_BAND_DEG)
      → targetSpeed scales linearly from NEUTRAL_CRUISE up to CRUISE_SPEED
        as pitch angle increases toward ±90°. Direction (up/down) is encoded
        in the camera-forward Y component, not the sign of speed.

   3. SCAN-ASSIST SLOWDOWN  (window.ABYSS._gazeProgress > 0)
      → targetSpeed multiplied by SCAN_SLOWDOWN_MULTIPLIER (0.25).
        Player glides near-still while the scan arc fills.
        Speed eases back up automatically once the scan completes or fails.

   W / ↑  — explicit forward override (boosts up to CRUISE_SPEED regardless
             of pitch). Desktop players can still use keys normally.
   S / ↓  — explicit brake / reverse thrust.
   A / ←  — strafe left  (XZ-only, yaw-relative)
   D / →  — strafe right (XZ-only, yaw-relative)
   Space  — ascend (additive vertical, independent of pitch)
   C / Shift — descend (additive vertical)

   Forward velocity is applied along the FULL 3D camera-forward vector so
   pitching down while moving dives, pitching up ascends — exactly the
   original v4 "pitch-to-swim" feel, but at rebalanced speeds.

   ── PUBLIC API (unchanged from v4/v5) ───────────────────────────────────────
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

  /* ═══════════════════════════════════════════════════════════════════════════
     TUNABLE CONSTANTS — adjust these to shape the feel of locomotion.
     All values carry their intended range in the comment.
  ═══════════════════════════════════════════════════════════════════════════ */

  // ── Forward / pitch-driven speed ──────────────────────────────────────────

  // CRUISE_SPEED: maximum forward speed reached when pitch is at full tilt
  // (units/sec). Applies once pitch exceeds NEUTRAL_BAND_DEG. At ±90° pitch
  // the player reaches this speed; intermediate angles scale linearly.
  // TUNE: range 1.5–5.0  (was SWIM_MAX 6.5 in v5 — cut ~57%)
  var CRUISE_SPEED      = 2.8;

  // NEUTRAL_CRUISE: gentle drift speed when pitch is within ±NEUTRAL_BAND_DEG
  // of level (the "hover" band). Player is never fully stationary — they
  // always cruise slowly forward, making it easy to stay on a target.
  // TUNE: range 0.5–2.0
  var NEUTRAL_CRUISE    = 1.2;

  // NEUTRAL_BAND_DEG: half-width of the neutral hover band in degrees.
  // Inside this band, speed = NEUTRAL_CRUISE. Outside, speed ramps up.
  // TUNE: range 3–10
  var NEUTRAL_BAND_DEG  = 5;

  // ── Scan-assist slowdown ───────────────────────────────────────────────────

  // SCAN_SLOWDOWN_MULTIPLIER: speed scale applied to targetSpeed whenever
  // window.ABYSS._gazeProgress > 0 (i.e. the scanner reticle is actively
  // dwelling on an interactable). Brings speed down to ~0.3 u/s at cruise,
  // which is slow enough to keep any target inside the scan reticle.
  // Set to 0.0 for a full freeze, 1.0 to disable the slowdown entirely.
  // TUNE: range 0.0–0.5
  var SCAN_SLOWDOWN_MULTIPLIER = 0.1;

  // ── Acceleration / deceleration ────────────────────────────────────────────

  // ACCELERATION_LERP: lerp factor toward targetSpeed each frame.
  // Higher = snappier ramp-up (more responsive); lower = floatier glide.
  // Applied as: swimVel = lerp(swimVel, target, ACCELERATION_LERP * delta)
  // TUNE: range 1.5–6.0
  var ACCELERATION_LERP = 2.8;

  // DECEL_LERP: lerp factor back toward zero when velocity overshoots target
  // (currently only used for explicit W/S key release — gaze locomotion
  // naturally decelerates by chasing a lower targetSpeed, not zero).
  // TUNE: range 4.0–12.0
  var DECEL_LERP        = 8.0;

  // ── Scan cone / lock radius ────────────────────────────────────────────────

  // SCAN_CONE_RADIUS: exposed here as a named constant for clarity. The actual
  // authoritative value is SCAN_RADIUS in main.js (set to 26 u). This constant
  // is informational only — controls.js does not perform its own raycasting.
  // TUNE: mirror any change to SCAN_RADIUS in main.js
  var SCAN_CONE_RADIUS  = 26;  // informational — matches main.js SCAN_RADIUS

  // ── Strafe / vertical ──────────────────────────────────────────────────────

  // STRAFE_SPEED: A/D lateral fin-kick speed (XZ-only, yaw-relative).
  // TUNE: range 1.0–4.0
  var STRAFE_SPEED  = 2.2;

  // VERT_MAX: Space/C manual vertical thrust speed (units/sec).
  // Additive to whatever Y-motion pitch-forward already produces.
  // TUNE: range 1.5–4.0
  var VERT_MAX      = 2.5;

  // VERT_ACCEL_K: lerp factor for vertical velocity (Space/C).
  // TUNE: range 2.0–5.0
  var VERT_ACCEL_K  = 3.0;

  // VERT_DECEL_K: decel time-constant for vertical velocity (seconds).
  // TUNE: range 0.05–0.15
  var VERT_DECEL_K  = 0.08;

  // ── Depth bounds ───────────────────────────────────────────────────────────
  // Must match environment.js seabed Y = -8 and surface Y = 20.
  var FLOOR_Y       = -8;
  var SURFACE_Y     =  20;
  var FLOOR_BOUND   = FLOOR_Y   + 1.5;   // -6.5  (soft floor cushion)
  var SURFACE_BOUND = SURFACE_Y - 0.5;   //  19.5 (soft ceiling cushion)

  /* ═══════════════════════════════════════════════════════════════════════════
     PRIVATE STATE
  ═══════════════════════════════════════════════════════════════════════════ */
  var _rig   = null;
  var _pitch = null;

  var _keys          = {};
  var _isPointerDown = false;
  var _pointerDisabled = false;
  var _lastX         = 0;
  var _lastY         = 0;
  var _yaw           = 0;
  var _pitchAngle    = 0;   // accumulated pitch from desktop drag (radians)
  var _lastPitchDeg  = 0;

  var _swimVel   = 0;       // signed forward speed (+ = forward, – = backward)
  var _vertVel   = 0;       // vertical velocity (+ = up)
  var _swimState = 'HOVERING';

  var _gyroActive  = false;
  var _gyroQ       = new THREE.Quaternion();
  var _screenAngle = 0;

  /* ─────────────────────────────────────────────────────────────────────────
     _clampRig — enforce world boundaries
  ───────────────────────────────────────────────────────────────────────── */
  function _clampRig() {
    var bounds = window.ABYSS.BOUNDS || { minX: -55, maxX: 55, minZ: -85, maxZ: 10 };
    _rig.position.x = THREE.MathUtils.clamp(_rig.position.x, bounds.minX, bounds.maxX);
    _rig.position.z = THREE.MathUtils.clamp(_rig.position.z, bounds.minZ, bounds.maxZ);
    
    var floorBound = FLOOR_BOUND;
    if (window.ABYSS && window.ABYSS.EnvironmentBuilder && window.ABYSS.EnvironmentBuilder.getElevation) {
      floorBound = window.ABYSS.EnvironmentBuilder.getElevation(_rig.position.x, _rig.position.z) + 1.2; 
    }
    _rig.position.y = THREE.MathUtils.clamp(_rig.position.y, floorBound, SURFACE_BOUND);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     init(cameraRig, pitchObject)
     cameraRig    — THREE.Group carrying position + yaw
     pitchObject  — child Group inside rig carrying pitch (cameras attached)
  ═══════════════════════════════════════════════════════════════════════════ */
  function init(cameraRig, pitchObject) {
    _rig   = cameraRig;
    _pitch = pitchObject;

    // Reset all locomotion state for session reuse / restart
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

    /* ── Desktop pointer drag-look ──
       Drag updates yaw + pitch for camera orientation.
       The pitch angle it writes is then READ by update() for pitch-to-swim.
       No separate propulsion side-effect needed — the update() loop handles it.
    ── */
    window.addEventListener('pointerdown', function (e) {
      _isPointerDown = true;
      if (_pointerDisabled) return;
      _lastX = e.clientX;
      _lastY = e.clientY;
    });
    window.addEventListener('pointermove', function (e) {
      if (_pointerDisabled || !_isPointerDown || _gyroActive) return;
      var dx = e.clientX - _lastX;
      var dy = e.clientY - _lastY;
      _lastX = e.clientX;
      _lastY = e.clientY;

      _yaw        -= dx * 0.003;
      _pitchAngle -= dy * 0.003;
      _pitchAngle  = THREE.MathUtils.clamp(_pitchAngle, -Math.PI / 2, Math.PI / 2);

      if (_rig && _rig.rotation) _rig.rotation.y   = _yaw;
      if (_pitch && _pitch.rotation) _pitch.rotation.x = _pitchAngle;
    });
    window.addEventListener('pointerup', function () { _isPointerDown = false; });
    window.addEventListener('pointercancel', function () { _isPointerDown = false; });

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
       1. Read explicit key inputs (W/S override, Space/C, A/D)
       2. Read current pitch angle from _pitch.rotation.x
       3. Compute pitch-zone targetSpeed (neutral / ramp / cruise)
       4. Apply scan-assist slowdown if gaze progress > 0
       5. W/S key override: W raises target to CRUISE_SPEED, S brakes/reverses
       6. Lerp _swimVel toward targetSpeed (smooth acceleration)
       7. Apply _swimVel along full 3D camera-forward vector (Y component kept)
       8. Apply A/D strafe (XZ-only, yaw-relative)
       9. Lerp _vertVel toward Space/C target; apply vertically
      10. Enforce depth bounds
      11. Derive swimState string for HUD
      12. Publish rig position / yaw for entity proximity + radar
  ═══════════════════════════════════════════════════════════════════════════ */
  function update(delta) {
    if (!_rig || !_pitch) return;

    /* ── 1. Read explicit key inputs ─────────────────────────────────────── */
    var keyFwd    = (_keys['w'] || _keys['arrowup'])    ? 1  : 0;
    var keyBack   = (_keys['s'] || _keys['arrowdown'])  ? -1 : 0;
    var keyThrust = keyFwd + keyBack;   // –1, 0, or +1

    var thrustUp     = (_keys[' '])                          ? 1  : 0;
    var thrustDown   = (_keys['c'] || _keys['shift'])        ? -1 : 0;
    var thrustStrafe = (_keys['a'] || _keys['arrowleft']  ?  -1 : 0)
                     + (_keys['d'] || _keys['arrowright'] ?   1 : 0);

    /* ── 2. Derive camera forward vector & pitch ─────────────────────────────
       Instead of relying on Euler decomposition which is prone to gimbal lock,
       we derive the forward vector directly from the quaternion.
       Pitch angle is the arcsin of the forward vector's Y component.
    ── */
    var camFwd = new THREE.Vector3(0, 0, -1);
    if (_gyroActive) {
      // Pure quaternion rotation (landscape/portrait orientation baked in)
      camFwd.applyQuaternion(_rig.quaternion).normalize();
    } else {
      // Desktop fallback: compose yaw and pitch groups
      var fullQ  = new THREE.Quaternion();
      fullQ.multiplyQuaternions(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, _rig.rotation.y, 0)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(_pitch.rotation.x, 0, 0))
      );
      camFwd.applyQuaternion(fullQ).normalize();
    }

    var pitchRad = Math.asin(camFwd.y);
    var pitchDeg = THREE.MathUtils.radToDeg(pitchRad);
    _lastPitchDeg = pitchDeg;
    var absPitch = Math.abs(pitchDeg);

    /* ── 3. Pitch-zone target speed ─────────────────────────────────────────
       Zone A — Neutral hover band (|pitch| ≤ NEUTRAL_BAND_DEG):
         targetSpeed = NEUTRAL_CRUISE → gentle perpetual drift, easy to scan.

       Zone B — Pitch zone (|pitch| > NEUTRAL_BAND_DEG):
         Speed ramps linearly from NEUTRAL_CRUISE at the band edge up to
         CRUISE_SPEED at ±90°.  Blended so there is no step discontinuity
         at the band boundary:
           t = (absPitch - NEUTRAL_BAND_DEG) / (90 - NEUTRAL_BAND_DEG)
           targetSpeed = lerp(NEUTRAL_CRUISE, CRUISE_SPEED, clamp(t, 0, 1))
    ── */
    var targetSpeed = 0;
    
    // Hand tracking propulsion with screen-touch fallback
    var handThrust = (window.ABYSS && window.ABYSS.HandTracker && window.ABYSS.HandTracker.getThrust) 
      ? window.ABYSS.HandTracker.getThrust() 
      : 0;

    if (handThrust > 0) {
      targetSpeed = handThrust * CRUISE_SPEED;
    } else if (_isPointerDown) {
      targetSpeed = CRUISE_SPEED; // Temporary touch fallback
    }

    /* ── 4. Scan-assist slowdown ─────────────────────────────────────────────
       Read the gaze-progress value published by main.js _handleGaze().
       When the scanner reticle is actively dwelling on a target, multiply
       the target speed down to ~20–25% so the player near-stops while scanning.
       Speed eases back naturally as soon as _gazeProgress returns to 0.
    ── */
    var gazeProgress = (window.ABYSS && typeof window.ABYSS._gazeProgress === 'number')
      ? window.ABYSS._gazeProgress : 0;

    if (gazeProgress > 0) {
      targetSpeed *= SCAN_SLOWDOWN_MULTIPLIER;
    }

    /* ── 5. W/S explicit override ────────────────────────────────────────────
       W: override raises targetSpeed to CRUISE_SPEED (full forward sprint),
          bypassing pitch zone and scan slowdown. Lets desktop players burst
          forward to chase a target or navigate quickly.
       S: overrides to negative CRUISE_SPEED (brake/reverse).
          When S is held while gaze-drifting, the explicit reverse always wins.
    ── */
    if (keyThrust !== 0) {
      targetSpeed = keyThrust * CRUISE_SPEED;
    }

    /* ── 6. Lerp _swimVel toward targetSpeed ─────────────────────────────────
       Single lerp toward targetSpeed — works for both acceleration (going from
       slow to fast) and deceleration (pitch returns to neutral, target drops
       from CRUISE_SPEED back to NEUTRAL_CRUISE). The lerp naturally smooths
       both transitions. A separate hard-decel case runs only when a keyThrust
       has just been released and the pitch-zone itself is in the neutral band,
       to avoid a float-off artifact after key release.
    ── */
    _swimVel = THREE.MathUtils.lerp(
      _swimVel,
      targetSpeed,
      Math.min(ACCELERATION_LERP * delta, 1.0)
    );


    /* ── 7. Apply _swimVel along full 3D camera-forward vector ───────────────
       Y-component is KEPT so pitching down drives the player forward-and-down
       (diving) and pitching up drives forward-and-up (ascending). This is the
       intentional pitch-steered 3D navigation.
    ── */
    if (Math.abs(_swimVel) > 0.008) {
      _rig.position.addScaledVector(camFwd, _swimVel * delta);
    }

    /* ── 8. A/D strafe — XZ-only, yaw-relative ───────────────────────────── */
    if (Math.abs(thrustStrafe) > 0) {
      var strafeVec = new THREE.Vector3(thrustStrafe, 0, 0);
      var yawQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, _rig.rotation.y, 0));
      strafeVec.applyQuaternion(yawQ).normalize()
               .multiplyScalar(STRAFE_SPEED * delta);
      _rig.position.add(strafeVec);
    }

    /* ── 9. Space/C vertical thrust — additive, independent of pitch ────────
       Additive to whatever Y component pitch-forward already applies.
       Lerp toward target; snap to zero to avoid perpetual micro-drift.
    ── */
    var targetVertVel = (thrustUp + thrustDown) * VERT_MAX;
    if (Math.abs(targetVertVel) > 0.008) {
      _vertVel = THREE.MathUtils.lerp(_vertVel, targetVertVel,
                   Math.min(VERT_ACCEL_K * delta, 1.0));
    } else {
      _vertVel = THREE.MathUtils.lerp(_vertVel, 0,
                   Math.min(delta / VERT_DECEL_K, 1.0));
      if (Math.abs(_vertVel) < 0.008) _vertVel = 0;
    }
    if (Math.abs(_vertVel) > 0.008) {
      _rig.position.y += _vertVel * delta;
    }

    /* ── 10. Enforce depth bounds ── */
    _rig.position.y = THREE.MathUtils.clamp(_rig.position.y, FLOOR_BOUND, SURFACE_BOUND);
    _clampRig();

    /* ── 11. Derive swimState for HUD ────────────────────────────────────────
       State derived from actual net vertical motion to give the HUD correct
       ASCENDING / DIVING / SWIMMING / HOVERING labels.
    ── */
    var totalVertMotion = _vertVel;
    if (Math.abs(_swimVel) > 0.008) {
      totalVertMotion += Math.sin(pitchRad) * _swimVel;
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

    /* ── 12. Publish rig position + yaw for entity proximity / radar ── */
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
    // Attempt to lock screen to landscape when entering VR mode
    if (window.screen && window.screen.orientation && window.screen.orientation.lock) {
      window.screen.orientation.lock('landscape').catch(function (err) {
        console.warn('[ABYSS Controls] Could not lock screen orientation:', err);
      });
    }

    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      return DeviceOrientationEvent.requestPermission().then(function (res) {
        if (res !== 'granted') return _gyroFallback();
        return _waitForFirstGyroEvent();
      }).catch(function () {
        return _gyroFallback();
      });
    }
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

     LANDSCAPE FIX:
     The screen-orientation angle is now read with an explicit != null guard
     rather than a truthy check. The truthy check silently treated angle=0
     (portrait) identically to undefined (iOS Safari before the first
     orientationchange event fires) — causing landscape mode to fall back to
     0° and leaving the device axes uncompensated (tilt up = look right).

     Priority chain for landscape angle:
       1. screen.orientation.angle != null  →  use it (0 / 90 / 180 / 270)
       2. typeof window.orientation === 'number'  →  iOS fallback (0 / 90 / -90)
       3. else 0  →  safe default

     All per-frame scratch objects (_screenAxis, _rigEuler, _worldQ) are
     allocated ONCE outside the event handler. At 60 Hz this eliminates ~180
     object allocations/sec and avoids GC pauses on low-RAM VR devices.

     Gyro drives ORIENTATION — it writes _pitch.rotation.x, which update()
     reads as the pitch-zone input for pitch-to-swim speed calculation.
     Tilting device forward dives; tilting back ascends.
  ═══════════════════════════════════════════════════════════════════════════ */
  function _attachGyro() {
    _gyroActive = true;

    // Pre-allocated scratch objects — NOT recreated on every sensor event
    var _euler      = new THREE.Euler();
    var _screenQ    = new THREE.Quaternion();
    var _worldQ     = new THREE.Quaternion();
    var _screenAxis = new THREE.Vector3(0, 0, 1); // screen normal (Z-axis)
    
    // q1 from reference project: new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5))
    // This is mathematically identical to a -90 deg rotation on the X axis.
    _worldQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

    window.addEventListener('deviceorientation', function (e) {
      if (e.alpha === null) return;

      var alpha = THREE.MathUtils.degToRad(e.alpha);
      var beta  = THREE.MathUtils.degToRad(e.beta);
      var gamma = THREE.MathUtils.degToRad(e.gamma);

      // Reference project exact math: YXZ order, multiply _worldQ (not premultiply)
      _euler.set(beta, alpha, -gamma, 'YXZ');
      _gyroQ.setFromEuler(_euler);
      _gyroQ.multiply(_worldQ);

      // ── Landscape screen compensation ─────────────────────────────────────
      var ang = 0;
      if (window.screen && window.screen.orientation &&
          window.screen.orientation.angle != null) {
        ang = window.screen.orientation.angle;
      } else if (typeof window.orientation === 'number') {
        ang = window.orientation;
      }
      _screenQ.setFromAxisAngle(_screenAxis, -THREE.MathUtils.degToRad(ang));
      _gyroQ.multiply(_screenQ);

      // Apply final pure orientation quaternion to the camera rig
      _rig.quaternion.copy(_gyroQ);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PUBLIC INTERFACE — window.ABYSS.Controls  (API surface unchanged from v4/v5)
  ═══════════════════════════════════════════════════════════════════════════ */
  var publicControls = {
    init:         init,
    update:       update,
    requestGyro:  requestGyro,
    disablePointerDrag: function () { _pointerDisabled = true; },
    getVelocity:  function () { return _swimVel; },
    getSwimState: function () { return _swimState; },
    getPitchDeg:  function () { return _lastPitchDeg; },
    get swimStatus() {
      return Math.abs(_swimVel) > 0.05 ? 'ON' : 'OFF';
    }
  };

  return publicControls;

}());
