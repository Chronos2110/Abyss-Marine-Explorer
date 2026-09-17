import * as THREE from 'three';

export function buildEnvironment(scene) {
  const interactables = [];

  // 1. Seabed Mesh
  const geo = new THREE.PlaneGeometry(250, 250, 64, 64);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = Math.sin(x * 0.08) * Math.cos(z * 0.08) * 2.5 + Math.sin(x * 0.03) * 3;
    pos.setY(i, y);
  }
  geo.computeVertexNormals();

  const sandMat = new THREE.MeshStandardMaterial({ color: 0x1b4965, roughness: 0.9, metalness: 0.1 });
  const seabed = new THREE.Mesh(geo, sandMat);
  scene.add(seabed);

  // 2. Volumetric-style Underwater Fog & Lights
  scene.fog = new THREE.FogExp2(0x041b33, 0.025);
  
  const ambLight = new THREE.AmbientLight(0x0d3b66, 1.8);
  scene.add(ambLight);

  const sunLight = new THREE.DirectionalLight(0x00ffff, 2.5);
  sunLight.position.set(20, 50, -10);
  scene.add(sunLight);

  // 3. Research Station Dome & Airlock
  const stationGroup = new THREE.Group();
  stationGroup.position.set(0, 2, -45);
  
  const domeMat = new THREE.MeshStandardMaterial({ color: 0x3a5a40, metalness: 0.8, roughness: 0.2 });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
  stationGroup.add(dome);

  const airlockMat = new THREE.MeshStandardMaterial({ color: 0x00ffcc, emissive: 0x00ffcc, emissiveIntensity: 0.5 });
  const airlock = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.5, 16), airlockMat);
  airlock.position.set(0, 1.5, 6);
  airlock.rotateX(Math.PI / 2);
  airlock.userData = { type: 'station', id: 'station_airlock' };
  stationGroup.add(airlock);
  interactables.push(airlock);

  scene.add(stationGroup);

  // 4. Sunken Shipwreck
  const shipGroup = new THREE.Group();
  shipGroup.position.set(-35, 1, -20);
  shipGroup.rotation.y = 0.6;
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x2b1e17, roughness: 0.9 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 22), hullMat);
  shipGroup.add(hull);
  scene.add(shipGroup);

  // 5. Oxygen Pod Dispenser
  createOxygenPod(scene, interactables, new THREE.Vector3(-10, 2, -15));
  createOxygenPod(scene, interactables, new THREE.Vector3(15, 2, -30));

  // 6. Pollution Items Scatter
  createPollution(scene, interactables, 'p_bottle', new THREE.Vector3(-5, 0.8, -12));
  createPollution(scene, interactables, 'p_net', new THREE.Vector3(12, 0.8, -18));
  createPollution(scene, interactables, 'p_metal', new THREE.Vector3(-20, 0.8, -25));
  createPollution(scene, interactables, 'p_barrel', new THREE.Vector3(8, 0.8, -38));

  // 7. Marine Snow Particles
  const partGeo = new THREE.BufferGeometry();
  const partPos = [];
  for (let i = 0; i < 300; i++) {
    partPos.push((Math.random() - 0.5) * 100, Math.random() * 30, (Math.random() - 0.5) * 100);
  }
  partGeo.setAttribute('position', new THREE.Float32BufferAttribute(partPos, 3));
  const partMat = new THREE.PointsMaterial({ color: 0x00ffcc, size: 0.15, transparent: true, opacity: 0.6 });
  const particles = new THREE.Points(partGeo, partMat);
  scene.add(particles);

  return { interactables, particles };
}

function createOxygenPod(scene, interactables, pos) {
  const group = new THREE.Group();
  group.position.copy(pos);

  const mat = new THREE.MeshStandardMaterial({ color: 0x00b4d8, emissive: 0x00b4d8, emissiveIntensity: 0.8 });
  const pod = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 16), mat);
  pod.userData = { type: 'oxygen_pod' };
  group.add(pod);

  scene.add(group);
  interactables.push(pod);
}

function createPollution(scene, interactables, id, pos) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xff4444, emissive: 0xaa0000 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), mat);
  mesh.position.copy(pos);
  mesh.userData = { type: 'pollution', id };
  scene.add(mesh);
  interactables.push(mesh);
}