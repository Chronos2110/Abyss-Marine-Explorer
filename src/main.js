import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Audio } from './audio.js';
import { Controls } from './controls.js';
import { buildEnvironment } from './environment.js';
import { createFauna } from './entities.js';
import { UIManager } from './ui.js';
import { GameplayManager } from './gameplay.js';

let renderer, scene, cameraRig, cameraL, cameraR, cameraNormal;
let controls, ui, gameplay;
let mode = 'sbs'; // 'sbs' or 'normal'

function init() {
  const canvas = document.getElementById('vrCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene = new THREE.Scene();
  cameraRig = new THREE.Group();
  scene.add(cameraRig);

  const aspect = (window.innerWidth / 2) / window.innerHeight;
  cameraL = new THREE.PerspectiveCamera(75, aspect, 0.1, 200);
  cameraR = new THREE.PerspectiveCamera(75, aspect, 0.1, 200);
  cameraL.position.x = -CONFIG.IPD / 2;
  cameraR.position.x = CONFIG.IPD / 2;
  cameraRig.add(cameraL);
  cameraRig.add(cameraR);

  cameraNormal = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
  cameraRig.add(cameraNormal);

  controls = new Controls(cameraRig);
  ui = new UIManager();

  const env = buildEnvironment(scene);
  const fauna = createFauna(scene, env.interactables);

  gameplay = new GameplayManager(scene, cameraL, env.interactables, fauna, ui);

  setupUIEvents();

  let lastTime = performance.now();
  function animate(now) {
    requestAnimationFrame(animate);
    const delta = (now - lastTime) / 1000;
    lastTime = now;

    controls.update(delta);
    gameplay.update(delta);
    ui.drawHUD(gameplay, mode);

    render();
  }
  requestAnimationFrame(animate);
}

function render() {
  const W = window.innerWidth;
  const H = window.innerHeight;

  if (mode === 'sbs') {
    renderer.setScissorTest(true);
    
    renderer.setViewport(0, 0, W / 2, H);
    renderer.setScissor(0, 0, W / 2, H);
    renderer.render(scene, cameraL);

    renderer.setViewport(W / 2, 0, W / 2, H);
    renderer.setScissor(W / 2, 0, W / 2, H);
    renderer.render(scene, cameraR);
  } else {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.render(scene, cameraNormal);
  }
}

function setupUIEvents() {
  document.getElementById('btnStartNormal').addEventListener('click', () => {
    mode = 'normal';
    startGame();
  });

  document.getElementById('btnStartSBS').addEventListener('click', () => {
    mode = 'sbs';
    startGame();
  });

  document.getElementById('btnMarineLog').addEventListener('click', () => {
    ui.updateMarineLog(gameplay.discoveredSet);
    document.getElementById('marineLogModal').classList.remove('hidden');
  });

  document.getElementById('btnCloseLog').addEventListener('click', () => {
    document.getElementById('marineLogModal').classList.add('hidden');
  });

  document.getElementById('btnSettings').addEventListener('click', () => {
    document.getElementById('settingsModal').classList.remove('hidden');
  });

  document.getElementById('btnCloseSettings').addEventListener('click', () => {
    document.getElementById('settingsModal').classList.add('hidden');
  });

  document.getElementById('btnRestart').addEventListener('click', () => {
    location.reload();
  });
}

function startGame() {
  Audio.init();
  controls.enabled = true;
  gameplay.startDive();
  document.getElementById('mainMenu').classList.add('hidden');
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  cameraNormal.aspect = window.innerWidth / window.innerHeight;
  cameraNormal.updateProjectionMatrix();
});

document.addEventListener('DOMContentLoaded', init);