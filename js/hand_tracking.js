/* =============================================================================
   ABYSS: Marine Explorer — js/hand_tracking.js
   MODULE 2: Vision-Based Hand / Palm Tracking Sensor Pipeline

   CRITICAL ARCHITECTURAL CONTRACT:
   - Registers window.ABYSS.HandTracker = { isPalmActive: false, isTracking: false, init, stop }
   - Pure sensor contract: ONLY sets isPalmActive (boolean). Does NOT mutate velocity or rig.
   - Dual-Tier Detection Pipeline:
       1. Primary: MediaPipe HandLandmarker with strict confidence score (>= 0.65).
          Verifies palm extension geometry (fingertips extended beyond PIP joints).
       2. Secondary: Calibrated YCrCb + strict HSV skin-tone segmentation fallback:
          - YCrCb: Cr in [133, 173], Cb in [77, 127], Y in [35, 245].
          - HSV: H in [0, 50], S in [0.23, 0.68], V > 0.35.
          - Contrast Check: Center region density must exceed perimeter density
            (centerDensity > perimeterDensity * 1.30 && centerDensity >= 0.30)
            preventing false positives from uniform beige walls, wood, or lamps.
          - Coverage Window: Palm held 15–30cm requires 25% to 65% total coverage.
            Coverage > 85% indicates lens blockage/occlusion -> evaluates to FALSE.
       3. Debouncing:
          - Requires 2 consecutive positive frames to switch isPalmActive = true.
          - Immediate drop to false on 1 negative frame.
   - stop() releases all camera tracks, clears video/canvas, and resets state.
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  /* ─── Processing Resolution & Analysis Constants ─────────────────────────── */
  var PROC_W = 160;
  var PROC_H = 120;
  var TOTAL_PIXELS = PROC_W * PROC_H;

  // Central Region ROI Boundaries (normalized 22% to 78%)
  var ROI_X_MIN = Math.floor(PROC_W * 0.22); // ~35
  var ROI_X_MAX = Math.floor(PROC_W * 0.78); // ~125
  var ROI_Y_MIN = Math.floor(PROC_H * 0.22); // ~26
  var ROI_Y_MAX = Math.floor(PROC_H * 0.78); // ~94
  var ROI_CENTER_PIXELS = (ROI_X_MAX - ROI_X_MIN) * (ROI_Y_MAX - ROI_Y_MIN);
  var ROI_PERIMETER_PIXELS = TOTAL_PIXELS - ROI_CENTER_PIXELS;

  /* ─── Module Scope Elements (Zero Per-Frame GC) ─────────────────────────── */
  var _video          = null;
  var _stream         = null;
  var _canvas         = null;
  var _ctx            = null;
  var _animId         = null;
  var _handLandmarker = null;
  var _isInitializing = false;

  // Debounce State (2 consecutive positives to activate, 1 negative to drop)
  var _consecutivePositives = 0;

  /* ─── HandTracker Public Contract ────────────────────────────────────────── */
  var HandTracker = {
    isPalmActive: false,
    isTracking:   false,
    init:         init,
    stop:         stop
  };

  /* ─── Debounce Transition Helper ─────────────────────────────────────────── */
  function _updateDebounce(rawPositive) {
    if (rawPositive) {
      _consecutivePositives++;
      if (_consecutivePositives >= 2) {
        HandTracker.isPalmActive = true;
      }
    } else {
      _consecutivePositives    = 0;
      HandTracker.isPalmActive = false; // Immediate drop on 1 negative frame
    }
  }

  /* ─── MediaPipe Tasks Vision 0.10.3 Initialization ───────────────────────── */
  async function _initMediaPipe() {
    try {
      var visionModule = null;

      if (window.FilesetResolver && window.HandLandmarker) {
        visionModule = {
          FilesetResolver: window.FilesetResolver,
          HandLandmarker:  window.HandLandmarker
        };
      } else {
        visionModule = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.js');
      }

      if (visionModule && visionModule.FilesetResolver && visionModule.HandLandmarker) {
        var vision = await visionModule.FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm'
        );

        _handLandmarker = await visionModule.HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate: 'GPU'
          },
          runningMode:                'VIDEO',
          numHands:                   1,
          minHandDetectionConfidence: 0.65,
          minHandPresenceConfidence:  0.65,
          minTrackingConfidence:      0.65
        });
        console.log('[ABYSS HandTracker] MediaPipe HandLandmarker online (confidence >= 0.65).');
      }
    } catch (err) {
      console.warn('[ABYSS HandTracker] MediaPipe unavailable, using calibrated fallback:', err);
      _handLandmarker = null;
    }
  }

  /* ─── Calibrated YCrCb + Strict HSV Fallback Analyzer ─────────────────────── */
  function _evaluateCalibratedFallback() {
    if (!_video || !_ctx || _video.videoWidth === 0) {
      _updateDebounce(false);
      return;
    }

    _ctx.drawImage(_video, 0, 0, PROC_W, PROC_H);
    var imgData = _ctx.getImageData(0, 0, PROC_W, PROC_H);
    var data = imgData.data;

    var centerSkinCount    = 0;
    var perimeterSkinCount = 0;

    for (var y = 0; y < PROC_H; y++) {
      var isRowCenter = (y >= ROI_Y_MIN && y < ROI_Y_MAX);
      var rowOffset = y * PROC_W;

      for (var x = 0; x < PROC_W; x++) {
        var idx = (rowOffset + x) * 4;
        var r = data[idx];
        var g = data[idx + 1];
        var b = data[idx + 2];

        // 1. Calibrated YCrCb calculation
        // Y  =  0.299*R + 0.587*G + 0.114*B
        // Cr = (R - Y) * 0.713 + 128
        // Cb = (B - Y) * 0.564 + 128
        var lum = 0.299 * r + 0.587 * g + 0.114 * b;
        var cr  = (r - lum) * 0.713 + 128;
        var cb  = (b - lum) * 0.564 + 128;

        var isSkinYCrCb = (cr >= 133 && cr <= 173 && cb >= 77 && cb <= 127 && lum >= 35 && lum <= 245);

        // 2. Strict HSV calculation
        var max = Math.max(r, g, b);
        var min = Math.min(r, g, b);
        var delta = max - min;
        var v = max / 255;
        var s = max === 0 ? 0 : delta / max;
        var h = 0;

        if (delta !== 0) {
          if (max === r) {
            h = ((g - b) / delta) % 6;
          } else if (max === g) {
            h = (b - r) / delta + 2;
          } else {
            h = (r - g) / delta + 4;
          }
          h = h * 60;
          if (h < 0) h += 360;
        }

        // H between 0 and 50, S between 0.23 and 0.68, V > 0.35
        var isSkinHSV = (h >= 0 && h <= 50 && s >= 0.23 && s <= 0.68 && v > 0.35);

        // Dual confirmation rejects ambient wall paint and indoor incandescent lighting
        if (isSkinYCrCb && isSkinHSV) {
          if (isRowCenter && x >= ROI_X_MIN && x < ROI_X_MAX) {
            centerSkinCount++;
          } else {
            perimeterSkinCount++;
          }
        }
      }
    }

    var totalSkinPixels = centerSkinCount + perimeterSkinCount;
    var totalCoverage   = totalSkinPixels / TOTAL_PIXELS;

    // Rule 1: Lens blocked/occluded (> 85%) -> must evaluate to FALSE
    if (totalCoverage > 0.85) {
      _updateDebounce(false);
      return;
    }

    // Rule 2: Require 25% to 65% total frame coverage (palm held 15–30cm away)
    if (totalCoverage < 0.25 || totalCoverage > 0.65) {
      _updateDebounce(false);
      return;
    }

    // Rule 3: Contrast Check — central region must exhibit higher skin density
    // than perimeter (verifies an actual hand in lens center, not background beige walls)
    var centerDensity    = centerSkinCount / ROI_CENTER_PIXELS;
    var perimeterDensity = perimeterSkinCount / ROI_PERIMETER_PIXELS;

    var isCentralHand = (centerDensity > perimeterDensity * 1.30 && centerDensity >= 0.30);
    _updateDebounce(isCentralHand);
  }

  /* ─── Processing Loop (15fps throttle) ───────────────────────────────────── */
  var _lastProcessTime = 0;
  var PROCESS_INTERVAL = 1000 / 15; // ~66.6ms for 15fps

  function _processLoop(timestamp) {
    if (!HandTracker.isTracking) return;

    _animId = requestAnimationFrame(_processLoop);

    if (timestamp - _lastProcessTime < PROCESS_INTERVAL) return;
    _lastProcessTime = timestamp;

    if (!_video || _video.readyState < 2) return;

    var evaluatedWithMediaPipe = false;
    var detectedHand           = false;

    if (_handLandmarker) {
      try {
        var results = _handLandmarker.detectForVideo(_video, performance.now());
        evaluatedWithMediaPipe = true;

        if (results && results.landmarks && results.landmarks.length > 0) {
          // Strict confidence score check (>= 0.65)
          var confidence = 1.0;
          if (results.handedness && results.handedness.length > 0 && results.handedness[0].length > 0) {
            confidence = results.handedness[0][0].score ?? 1.0;
          }

          if (confidence >= 0.65) {
            var landmarks = results.landmarks[0];
            var wrist     = landmarks[0];
            var middleTip = landmarks[12];
            var middlePip = landmarks[10];
            var indexTip  = landmarks[8];
            var indexPip  = landmarks[6];

            // Open palm test: middle and index fingertips extended away from wrist past PIP joints
            var distMiddleTip = Math.hypot(middleTip.x - wrist.x, middleTip.y - wrist.y);
            var distMiddlePip = Math.hypot(middlePip.x - wrist.x, middlePip.y - wrist.y);
            var distIndexTip  = Math.hypot(indexTip.x - wrist.x, indexTip.y - wrist.y);
            var distIndexPip  = Math.hypot(indexPip.x - wrist.x, indexPip.y - wrist.y);

            if (distMiddleTip > distMiddlePip * 1.15 && distIndexTip > distIndexPip * 1.15) {
              detectedHand = true;
            }
          }
        }
      } catch (err) {
        evaluatedWithMediaPipe = false;
      }
    }

    if (evaluatedWithMediaPipe) {
      _updateDebounce(detectedHand);
    } else {
      _evaluateCalibratedFallback();
    }
  }

  /* ─── init() ─────────────────────────────────────────────────────────────── */
  async function init() {
    if (HandTracker.isTracking || _isInitializing) return true;
    _isInitializing = true;

    // 1. Offscreen Video element
    if (!_video) {
      _video = document.createElement('video');
      _video.setAttribute('playsinline', '');
      _video.setAttribute('webkit-playsinline', '');
      _video.setAttribute('muted', '');
      _video.muted = true;
      _video.autoplay = true;
      _video.style.position = 'fixed';
      _video.style.top = '-9999px';
      _video.style.left = '-9999px';
      _video.style.width = '1px';
      _video.style.height = '1px';
      _video.style.opacity = '0';
      _video.style.pointerEvents = 'none';
      document.body.appendChild(_video);
    }

    // 2. Offscreen Canvas for skin-tone mask analysis
    if (!_canvas) {
      _canvas = document.createElement('canvas');
      _canvas.width  = PROC_W;
      _canvas.height = PROC_H;
      _ctx = _canvas.getContext('2d', { willReadFrequently: true });
    }

    // 3. Request environment camera stream
    var constraints = {
      video: {
        facingMode: 'environment',
        width:      { ideal: PROC_W },
        height:     { ideal: PROC_H },
        frameRate:  { ideal: 15 }
      },
      audio: false
    };

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn('[ABYSS HandTracker] getUserMedia unsupported.');
        _isInitializing = false;
        return false;
      }

      var stream = await navigator.mediaDevices.getUserMedia(constraints);
      _stream = stream;
      _video.srcObject = stream;

      await new Promise(function (resolve) {
        _video.onloadedmetadata = function () {
          _video.play().then(resolve).catch(resolve);
        };
      });

      _consecutivePositives    = 0;
      HandTracker.isPalmActive = false;
      HandTracker.isTracking   = true;
      _isInitializing          = false;

      // Start processing loop
      _lastProcessTime = performance.now();
      _animId = requestAnimationFrame(_processLoop);

      // Initialize MediaPipe Tasks Vision in background
      _initMediaPipe().catch(function () {});

      console.log('[ABYSS HandTracker] Environment camera stream acquired.');
      return true;
    } catch (err) {
      console.warn('[ABYSS HandTracker] Camera stream error:', err);
      _isInitializing          = false;
      HandTracker.isTracking   = false;
      HandTracker.isPalmActive = false;
      return false;
    }
  }

  /* ─── stop() ─────────────────────────────────────────────────────────────── */
  function stop() {
    if (_animId) {
      cancelAnimationFrame(_animId);
      _animId = null;
    }

    // Stop all camera stream tracks
    if (_stream) {
      _stream.getTracks().forEach(function (track) {
        try {
          track.stop();
        } catch (e) {}
      });
      _stream = null;
    }

    if (_video) {
      try {
        _video.pause();
        _video.srcObject = null;
      } catch (e) {}
    }

    _consecutivePositives    = 0;
    HandTracker.isTracking   = false;
    HandTracker.isPalmActive = false;
    _isInitializing          = false;
    console.log('[ABYSS HandTracker] Stopped.');
  }

  /* ─── Export Contract ────────────────────────────────────────────────────── */
  window.ABYSS.HandTracker = HandTracker;

}());
