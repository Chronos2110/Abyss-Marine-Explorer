import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Audio } from './audio.js';

export class GameplayManager {
  constructor(scene, camera, interactables, faunaData, ui) {
    this.scene = scene;
    this.camera = camera;
    this.interactables = interactables;
    this.faunaData = faunaData;
    this.ui = ui;

    this.status = 'MENU';
    this.oxygen = CONFIG.OXYGEN_MAX;
    
    this.speciesDiscovered = 0;
    this.discoveredSet = new Set();
    this.pollutionCollected = 0;
    this.stationUnlocked = false;

    this.gazeTarget = null;
    this.gazeTimer = 0;
    this.gazeProgress = 0;

    this.raycaster = new THREE.Raycaster();
    this.sharkTriggered = false;
  }

  startDive() {
    this.status = 'PLAYING';
    this.oxygen = CONFIG.OXYGEN_MAX;
    Audio.playOceanHum();
  }

  update(delta) {
    if (this.status !== 'PLAYING') return;

    // 1. Oxygen Depletion
    this.oxygen -= CONFIG.OXYGEN_DEPLETION_RATE * delta;
    if (this.oxygen <= 0) {
      this.endGame(false, 'Oxygen Depleted! You ran out of air before completing the mission.');
      return;
    }

    // 2. Gaze Raycasting Interaction
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera);
    const hits = this.raycaster.intersectObjects(this.interactables, true);

    if (hits.length > 0) {
      const target = hits[0].object;
      if (this.gazeTarget !== target) {
        this.gazeTarget = target;
        this.gazeTimer = 0;
      }
      this.gazeTimer += delta;
      this.gazeProgress = Math.min(1, this.gazeTimer / CONFIG.GAZE_TIME_REQUIRED);

      if (this.gazeTimer >= CONFIG.GAZE_TIME_REQUIRED) {
        this.triggerInteraction(target);
        this.gazeTimer = 0;
      }
    } else {
      this.gazeTarget = null;
      this.gazeTimer = 0;
      this.gazeProgress = 0;
    }

    // 3. Scripted Shark Encounter Trigger
    if (!this.sharkTriggered && this.camera.position.z < -20) {
      this.sharkTriggered = true;
      Audio.playSonarPing();
    }
    if (this.sharkTriggered) {
      this.faunaData.sharkGroup.position.x += 6 * delta; // Swim across horizon
    }
  }

  triggerInteraction(obj) {
    const data = obj.userData;
    if (!data) return;

    if (data.type === 'fauna' && !this.discoveredSet.has(data.id)) {
      this.discoveredSet.add(data.id);
      this.speciesDiscovered++;
      Audio.playScanChime();
    } else if (data.type === 'pollution' && obj.visible) {
      obj.visible = false;
      this.pollutionCollected++;
      Audio.playCollect();
    } else if (data.type === 'oxygen_pod' && obj.visible) {
      obj.visible = false;
      this.oxygen = Math.min(CONFIG.OXYGEN_MAX, this.oxygen + CONFIG.OXYGEN_REFILL_POD_VALUE);
      Audio.playBubble();
    } else if (data.type === 'station') {
      if (this.speciesDiscovered >= CONFIG.TARGET_SPECIES_COUNT && this.pollutionCollected >= CONFIG.TARGET_POLLUTION_COUNT) {
        this.endGame(true, 'ECOSYSTEM RESTORED! Research station unlocked and environmental balance saved.');
      }
    }
  }

  endGame(success, message) {
    this.status = success ? 'WIN' : 'GAMEOVER';
    document.getElementById('endTitle').textContent = success ? 'MISSION SUCCESS' : 'DIVE FAILED';
    document.getElementById('endMessage').textContent = message;
    document.getElementById('gameEndOverlay').classList.remove('hidden');
  }
}