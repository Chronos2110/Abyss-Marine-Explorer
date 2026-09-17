import * as THREE from 'three';

export class Controls {
  constructor(cameraRig) {
    this.cameraRig = cameraRig;
    this.enabled = false;
    this.sensitivity = 1.0;
    this.swimSpeed = 5.5;

    this.pitch = 0;
    this.yaw = 0;

    this.keys = { KeyW: false, KeyS: false, KeyA: false, KeyD: false };
    this.isPointerDown = false;
    this.touchSwimming = false;

    this.initListeners();
  }

  initListeners() {
    window.addEventListener('keydown', (e) => { if (this.keys.hasOwnProperty(e.code)) this.keys[e.code] = true; });
    window.addEventListener('keyup', (e) => { if (this.keys.hasOwnProperty(e.code)) this.keys[e.code] = false; });

    window.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      this.isPointerDown = true;
      this.touchSwimming = true;
    });

    window.addEventListener('pointerup', () => {
      this.isPointerDown = false;
      this.touchSwimming = false;
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.isPointerDown) return;
      this.yaw -= e.movementX * 0.002 * this.sensitivity;
      this.pitch -= e.movementY * 0.002 * this.sensitivity;
      this.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.pitch));
    });

    // Gyroscope tracking
    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', (e) => {
        if (!e.alpha || !this.enabled) return;
        const beta = THREE.MathUtils.degToRad(e.beta || 0);
        const gamma = THREE.MathUtils.degToRad(e.gamma || 0);
        this.pitch = beta - Math.PI / 2;
        this.yaw = gamma;
      });
    }
  }

  update(delta) {
    if (!this.enabled) return;

    // Head orientation update
    const euler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    this.cameraRig.quaternion.setFromEuler(euler);

    // Swimming Direction Vector derived from look vector
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.cameraRig.quaternion);

    let moveVector = new THREE.Vector3();

    if (this.keys.KeyW || this.touchSwimming) moveVector.add(forward);
    if (this.keys.KeyS) moveVector.sub(forward);

    if (moveVector.lengthSq() > 0) {
      moveVector.normalize().multiplyScalar(this.swimSpeed * delta);
      this.cameraRig.position.add(moveVector);
      // Floor height constraint
      this.cameraRig.position.y = Math.max(1.5, Math.min(30, this.cameraRig.position.y));
    }
  }
}