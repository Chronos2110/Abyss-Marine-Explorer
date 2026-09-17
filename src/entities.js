import * as THREE from 'three';

export function createFauna(scene, interactables) {
  const faunaList = [];

  // 1. Clownfish School
  const fishMat = new THREE.MeshStandardMaterial({ color: 0xff7b00, emissive: 0x331100 });
  for (let i = 0; i < 5; i++) {
    const fish = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.8, 8), fishMat);
    fish.rotation.x = Math.PI / 2;
    fish.position.set(-8 + i * 0.8, 2 + Math.sin(i), -10 + i * 0.5);
    fish.userData = { type: 'fauna', id: 'clownfish' };
    scene.add(fish);
    interactables.push(fish);
    faunaList.push({ mesh: fish, speed: 1.2, basePos: fish.position.clone() });
  }

  // 2. Sea Turtle
  const turtleGroup = new THREE.Group();
  turtleGroup.position.set(10, 5, -20);
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 8), new THREE.MeshStandardMaterial({ color: 0x2a9d8f }));
  shell.scale.set(1, 0.4, 1.4);
  turtleGroup.add(shell);
  turtleGroup.userData = { type: 'fauna', id: 'turtle' };
  scene.add(turtleGroup);
  interactables.push(shell); // Reticle targets outer shell
  shell.userData = turtleGroup.userData;
  faunaList.push({ mesh: turtleGroup, speed: 0.8, basePos: turtleGroup.position.clone() });

  // 3. Bioluminescent Jellyfish
  const jellyMat = new THREE.MeshStandardMaterial({ color: 0x9d4edd, emissive: 0x7b2cbf, transparent: true, opacity: 0.8 });
  const jelly = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 16, 0, Math.PI * 2, 0, Math.PI / 1.5), jellyMat);
  jelly.position.set(-18, 8, -25);
  jelly.userData = { type: 'fauna', id: 'jellyfish' };
  scene.add(jelly);
  interactables.push(jelly);
  faunaList.push({ mesh: jelly, speed: 0.5, basePos: jelly.position.clone() });

  // 4. Scripted Shark (The "WOW" Moment)
  const sharkGroup = new THREE.Group();
  sharkGroup.position.set(-60, 12, -50);
  const sharkMat = new THREE.MeshStandardMaterial({ color: 0x48cae4, roughness: 0.3 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(1.5, 7, 8), sharkMat);
  body.rotation.x = Math.PI / 2;
  sharkGroup.add(body);
  sharkGroup.userData = { type: 'fauna', id: 'shark' };
  body.userData = sharkGroup.userData;
  scene.add(sharkGroup);
  interactables.push(body);

  return { faunaList, sharkGroup };
}