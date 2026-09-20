import {
  FilesetResolver,
  HandLandmarker
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

let handLandmarker = null;
let videoElement = null;
let lastVideoTime = -1;
let animationFrameId = null;

export const HandMotion = {
  isMoving: false,
  thrust: 0.0,
  gesture: 'none'
};

export async function setupHandTracker() {
  const hud = document.getElementById('vision-hud');
  try {
    if (hud) hud.innerText = "Vision: Loading WASM...";

    // Must match the exact @0.10.14 version:
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );

    if (hud) hud.innerText = "Vision: Loading AI Model...";

    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.35,
      minHandPresenceConfidence: 0.35,
      minTrackingConfidence: 0.35
    });

    if (hud) hud.innerText = "Vision: Ready | Hand: NONE";
    console.log("MediaPipe HandLandmarker successfully loaded!");
    
    if (!animationFrameId) {
      _loop();
    }
    
    return true;
  } catch (err) {
    console.error("Hand Tracker failed to initialize:", err);
    if (hud) hud.innerText = "Vision Err: " + (err.message || "Failed");
    return false;
  }
}

export async function startRearCamera() {
  videoElement = document.getElementById("rear-camera-feed") || document.getElementById("webcam");
  if (!videoElement) {
    videoElement = document.createElement("video");
    videoElement.id = "rear-camera-feed";
    videoElement.setAttribute("playsinline", "");
    videoElement.setAttribute("autoplay", "");
    videoElement.setAttribute("muted", "");
    videoElement.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-10;";
    document.body.appendChild(videoElement);
  }

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 480 },
      height: { ideal: 360 }
    }
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoElement.srcObject = stream;
  await videoElement.play();
  return true;
}

export function updateHandGestures() {
  const hud = document.getElementById('vision-hud');
  if (!handLandmarker || !videoElement || videoElement.readyState < 2) return;

  if (videoElement.currentTime !== lastVideoTime) {
    lastVideoTime = videoElement.currentTime;
    const startTimeMs = performance.now();
    const results = handLandmarker.detectForVideo(videoElement, startTimeMs);

    if (results.landmarks && results.landmarks.length > 0) {
      const landmarks = results.landmarks[0];
      const wrist = landmarks[0];
      const indexTip = landmarks[8];
      const middleTip = landmarks[12];
      const ringTip = landmarks[16];

      const dIndex = Math.hypot(indexTip.x - wrist.x, indexTip.y - wrist.y);
      const dMiddle = Math.hypot(middleTip.x - wrist.x, middleTip.y - wrist.y);
      const dRing = Math.hypot(ringTip.x - wrist.x, ringTip.y - wrist.y);
      const avgExtension = (dIndex + dMiddle + dRing) / 3.0;

      // Open palm threshold
      if (avgExtension > 0.30) {
        HandMotion.isMoving = true;
        HandMotion.gesture = 'open_palm';
        HandMotion.thrust = Math.min(Math.max((avgExtension - 0.30) * 3.5, 0.2), 1.0);
        if (hud) hud.innerText = "Vision: PALM DETECTED (SWIMMING)";
      } else {
        HandMotion.isMoving = false;
        HandMotion.gesture = 'fist';
        HandMotion.thrust = 0.0;
        if (hud) hud.innerText = "Vision: FIST (STOPPED)";
      }
    } else {
      HandMotion.isMoving = false;
      HandMotion.gesture = 'none';
      HandMotion.thrust = 0.0;
      if (hud) hud.innerText = "Vision: Ready | Hand: NONE";
    }
  }
}

function _loop() {
  updateHandGestures();
  animationFrameId = requestAnimationFrame(_loop);
}

// Ensure compatibility with existing architecture
window.ABYSS = window.ABYSS || {};
window.ABYSS.HandTracker = {
  setupHandTracker,
  startRearCamera,
  updateHandGestures,
  getThrust: () => HandMotion.thrust,
  HandMotion: HandMotion
};
