/* =============================================================================
   ABYSS: Marine Explorer — js/hand_tracking.js
   MODULE 2: Vision-Based Hand Tracking & Gesture Propulsion Pipeline
   MediaPipe Tasks Vision @0.10.14
   ============================================================================= */

import {
  FilesetResolver,
  HandLandmarker
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

window.ABYSS = window.ABYSS || {};

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/**
 * HandMotion Data Structure
 */
export const HandMotion = {
  isMoving: false,
  gesture: 'none',
  thrust: 0.0,
  avgExtension: 0.0
};

let handLandmarker = null;
let videoElement = null;
let mediaStream = null;
let animFrameId = null;
let lastVideoTime = -1;
let isSettingUp = false;

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function updateHud(statusText) {
  const hud = document.getElementById('vision-hud');
  if (hud) {
    hud.textContent = statusText;
  }
}

/**
 * setupHandTracker()
 * Initializes MediaPipe FilesetResolver & HandLandmarker with model and delegate.
 */
export async function setupHandTracker() {
  if (handLandmarker) return handLandmarker;
  if (isSettingUp) return;
  isSettingUp = true;

  try {
    updateHud('Vision: Loading MediaPipe @0.10.14...');
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

    // Try GPU delegate first, fallback to CPU if WebGL context is unavailable
    try {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_PATH,
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numHands: 1
      });
      console.log('[ABYSS HandTracker] HandLandmarker loaded with GPU delegate.');
    } catch (gpuErr) {
      console.warn('[ABYSS HandTracker] GPU delegate failed, falling back to CPU:', gpuErr);
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_PATH,
          delegate: 'CPU'
        },
        runningMode: 'VIDEO',
        numHands: 1
      });
      console.log('[ABYSS HandTracker] HandLandmarker loaded with CPU delegate.');
    }

    updateHud('Vision: Ready');
    return handLandmarker;
  } catch (err) {
    console.error('[ABYSS HandTracker] setupHandTracker failed:', err);
    updateHud('Vision: Load Error');
    throw err;
  } finally {
    isSettingUp = false;
  }
}

/**
 * startRearCamera()
 * Creates or binds #rear-camera-feed and acquires the environment camera stream.
 */
export async function startRearCamera() {
  // Bind or create video element
  videoElement = document.getElementById('rear-camera-feed');
  if (!videoElement) {
    videoElement = document.createElement('video');
    videoElement.id = 'rear-camera-feed';
    videoElement.setAttribute('playsinline', '');
    videoElement.setAttribute('webkit-playsinline', '');
    videoElement.setAttribute('muted', '');
    videoElement.muted = true;
    videoElement.autoplay = true;
    videoElement.style.cssText = 'position:fixed; top:-9999px; left:-9999px; width:1px; height:1px; opacity:0; pointer-events:none;';
    document.body.appendChild(videoElement);
  }

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 480 },
      height: { ideal: 360 }
    }
  };

  try {
    updateHud('Vision: Requesting Camera...');
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = mediaStream;

    await new Promise((resolve) => {
      videoElement.onloadedmetadata = () => {
        videoElement.play().then(resolve).catch(resolve);
      };
    });

    console.log('[ABYSS HandTracker] Rear camera active.');
    updateHud('Vision: Camera Active');

    // Kick off detection loop
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = requestAnimationFrame(updateHandGestures);

    return videoElement;
  } catch (err) {
    console.error('[ABYSS HandTracker] startRearCamera failed:', err);
    updateHud('Vision: Camera Denied');
    throw err;
  }
}

/**
 * updateHandGestures()
 * Detection step running every animation frame.
 * Tracks landmarks:
 *   0: Wrist
 *   8: Index Tip
 *  12: Middle Tip
 *  16: Ring Tip
 */
export function updateHandGestures() {
  animFrameId = requestAnimationFrame(updateHandGestures);

  if (!videoElement || videoElement.readyState < 2) return;

  if (!handLandmarker) {
    updateHud('Vision: Waiting for Model...');
    return;
  }

  const currentTime = performance.now();
  if (currentTime <= lastVideoTime) return;
  lastVideoTime = currentTime;

  try {
    const results = handLandmarker.detectForVideo(videoElement, currentTime);

    if (results && results.landmarks && results.landmarks.length > 0) {
      const landmarks = results.landmarks[0];
      const wrist = landmarks[0];
      const indexTip = landmarks[8];
      const middleTip = landmarks[12];
      const ringTip = landmarks[16];

      // Compute distances from wrist to fingertips
      const dIndex = Math.hypot(indexTip.x - wrist.x, indexTip.y - wrist.y);
      const dMiddle = Math.hypot(middleTip.x - wrist.x, middleTip.y - wrist.y);
      const dRing = Math.hypot(ringTip.x - wrist.x, ringTip.y - wrist.y);

      const avgExtension = (dIndex + dMiddle + dRing) / 3.0;
      HandMotion.avgExtension = avgExtension;

      if (avgExtension > 0.30) {
        HandMotion.isMoving = true;
        HandMotion.gesture = 'open_palm';
        HandMotion.thrust = clamp((avgExtension - 0.30) * 3.5, 0.2, 1.0);
      } else {
        HandMotion.isMoving = false;
        HandMotion.gesture = 'fist';
        HandMotion.thrust = 0.0;
      }

      updateHud(`Vision: ${HandMotion.gesture} | Thrust: ${HandMotion.thrust.toFixed(2)} (Ext: ${avgExtension.toFixed(2)})`);
    } else {
      HandMotion.isMoving = false;
      HandMotion.gesture = 'no_hand';
      HandMotion.thrust = 0.0;
      HandMotion.avgExtension = 0.0;

      updateHud('Vision: No Hand Detected');
    }
  } catch (err) {
    // MediaPipe frame processing drop protection
    console.warn('[ABYSS HandTracker] Processing error:', err);
  }
}

/**
 * getThrust()
 * Returns the current normalized thrust value [0.0, 1.0].
 */
export function getThrust() {
  return HandMotion.thrust;
}

/**
 * stop()
 * Halts processing loop and releases all camera stream tracks.
 */
export function stop() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (e) {}
    });
    mediaStream = null;
  }

  if (videoElement) {
    try {
      videoElement.pause();
      videoElement.srcObject = null;
    } catch (e) {}
  }

  HandMotion.isMoving = false;
  HandMotion.gesture = 'none';
  HandMotion.thrust = 0.0;
  HandMotion.avgExtension = 0.0;
  lastVideoTime = -1;

  updateHud('Vision: Stopped');
  console.log('[ABYSS HandTracker] Pipeline stopped.');
}

/**
 * Attach the module cleanly to window.ABYSS.HandTracker
 */
window.ABYSS.HandTracker = {
  setupHandTracker,
  startRearCamera,
  updateHandGestures,
  getThrust,
  stop,
  HandMotion,
  // Backward compatibility:
  get isPalmActive() {
    return HandMotion.isMoving;
  },
  get isTracking() {
    return mediaStream !== null;
  },
  init: async function () {
    await startRearCamera();
    await setupHandTracker();
    return true;
  }
};
