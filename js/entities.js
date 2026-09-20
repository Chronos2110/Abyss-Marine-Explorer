/* =============================================================================
   ABYSS: Marine Explorer — Core Entities & Biological Systems Module
   =============================================================================
   * Procedural Fauna Mesh Generation & Anatomical Construction
   * GLTF/GLB Async Biological Asset Pipeline & Fallback System
   * 360-Degree Spatial Ecosystem Distribution Across 8 World Quadrants
   * Kinematic Animation Engines (Sinusoidal Undulation, Wing Flapping, Schooling)
   * Interactive Metadata Registration & Scanning Payload Binding
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

ABYSS.Entities = (function () {
  'use strict';

  /* ===========================================================================
     1. PRIVATE MODULE STATE & REGISTRIES
     =========================================================================== */

  var _scene = null;
  var _interactables = [];
  var _faunaRegistry = [];
  var _gltfLoader = null;
  var _isGltfSupported = false;

  /* ===========================================================================
     2. MODULE INITIALIZATION & SPAWN TABLE
     =========================================================================== */

  function init(scene, interactablesArray) {
    _scene = scene;
    _interactables = interactablesArray;

    _initializeLoader();

    // Quadrant 1: North-West Trench (Depth -10 to -22)
    _buildSeaTurtle(-85, -8, -110, 'fauna_turtle_01', 'Hawksbill Sea Turtle Alpha');
    _buildJellyfishCluster(-120, -2, -90, 6, 'fauna_jelly_q1');

    // Quadrant 2: North-East Abyssal Plain (Depth -5 to -20)
    _buildClownfishSchool(95, -16, -120, 10, 'fauna_clown_q2');
    _buildMantaRay(140, 2, -80, 'fauna_manta_01', 'Giant Oceanic Manta Ray');

    // Quadrant 3: South-East Coral Shelf (Depth -12 to -25)
    _buildBioluminescentEel(110, -21, 95, 'fauna_eel_01', 'Abyssal Bioluminescent Eel');
    _buildJellyfishCluster(75, 4, 130, 8, 'fauna_jelly_q3');

    // Quadrant 4: South-West Shipwreck Zone (Depth -15 to -26)
    _buildApexShark(-150, -6, 110, 'fauna_shark_01', 'Apex Deep Sea Predator');
    _buildClownfishSchool(-90, -18, 140, 8, 'fauna_clown_q4');

    // Quadrant 5: Outer Deep Rim & Hydrothermal Vents (360 Scatter Fill)
    _buildSeaTurtle(160, -12, -150, 'fauna_turtle_02', 'Hawksbill Sea Turtle Beta');
    _buildMantaRay(-170, 8, -160, 'fauna_manta_02', 'Pelagic Manta Ray');
    _buildAnglerfish(-45, -23, -170, 'fauna_angler_01', 'Deep-Trench Anglerfish');
    _buildAnglerfish(130, -22, 160, 'fauna_angler_02', 'Abyssal Anglerfish');
    _buildGiantIsopod(-65, -26, 75, 'fauna_isopod_01', 'Benthic Giant Isopod');
    _buildGiantIsopod(85, -26, -65, 'fauna_isopod_02', 'Seabed Scavenger Isopod');
  }

  function _initializeLoader() {
    if (typeof THREE !== 'undefined' && typeof THREE.GLTFLoader !== 'undefined') {
      _gltfLoader = new THREE.GLTFLoader();
      _isGltfSupported = true;
    } else {
      console.warn('ABYSS.Entities: THREE.GLTFLoader unavailable. Running procedural fallback mode.');
      _isGltfSupported = false;
    }
  }

  /* ===========================================================================
     3. ASYNC EXTERNAL ASSET PIPELINE (GLTF/GLB)
     =========================================================================== */

  function loadGLBModel(assetUrl, posX, posY, posZ, scaleFactor, id, displayName, onSuccessCallback) {
    if (!_isGltfSupported || !_gltfLoader) {
      console.warn('ABYSS.Entities: GLTFLoader engine not mounted. Cannot load ' + assetUrl);
      return;
    }

    _gltfLoader.load(
      assetUrl,
      function (gltfContainer) {
        var loadedModel = gltfContainer.scene;
        loadedModel.position.set(posX, posY, posZ);
        loadedModel.scale.set(scaleFactor, scaleFactor, scaleFactor);

        loadedModel.userData = {
          type: 'fauna',
          id: id || ('glb_entity_' + Math.random().toString(36).substr(2, 7)),
          name: displayName || 'Unidentified Marine Species',
          scanned: false,
          isExternalModel: true
        };

        _scene.add(loadedModel);
        _interactables.push(loadedModel);

        _faunaRegistry.push({
          mesh: loadedModel,
          animType: 'glb_custom',
          basePosition: new THREE.Vector3(posX, posY, posZ),
          rotationSpeed: 0.2
        });

        if (typeof onSuccessCallback === 'function') {
          onSuccessCallback(loadedModel);
        }
      },
      function (xhrProgress) {
        if (xhrProgress.lengthComputable) {
          var percentComplete = (xhrProgress.loaded / xhrProgress.total) * 100;
          console.log('Asset Loading [' + id + ']: ' + percentComplete.toFixed(1) + '%');
        }
      },
      function (loadError) {
        console.error('ABYSS.Entities: Error loading external GLB asset (' + assetUrl + '):', loadError);
      }
    );
  }

  /* ===========================================================================
     4. ENTITY REGISTRATION & METADATA BINDING
     =========================================================================== */

  function _registerFaunaNode(groupNode, entityId, displayName, animationCategory, x, y, z) {
    groupNode.position.set(x, y, z);

    groupNode.userData = {
      type: 'fauna',
      id: entityId,
      name: displayName,
      scanned: false,
      timestampLogged: 0
    };

    _scene.add(groupNode);
    _interactables.push(groupNode);

    _faunaRegistry.push({
      mesh: groupNode,
      animType: animationCategory,
      basePosition: new THREE.Vector3(x, y, z),
      phaseOffset: Math.random() * Math.PI * 2,
      velocity: new THREE.Vector3(0, 0, 0)
    });
  }

  /* ===========================================================================
     5. PROCEDURAL ANATOMICAL MESH BUILDERS
     =========================================================================== */

  /* --- A. TURTLE BUILDER --- */
  function _buildSeaTurtle(x, y, z, id, name) {
    var turtleGroup = new THREE.Group();

    // Carapace (Shell)
    var shellMat = new THREE.MeshPhongMaterial({
      color: 0x2e5a3c,
      roughness: 0.6,
      shininess: 25,
      flatShading: true
    });
    var shellGeo = new THREE.SphereGeometry(2.4, 14, 12, 0, Math.PI * 2, 0, Math.PI / 1.9);
    var shellMesh = new THREE.Mesh(shellGeo, shellMat);
    shellMesh.scale.set(1.0, 0.42, 1.35);
    turtleGroup.add(shellMesh);

    // Plastron (Under-shell)
    var plastronMat = new THREE.MeshPhongMaterial({ color: 0x8a9a5b, roughness: 0.8 });
    var plastronGeo = new THREE.CylinderGeometry(2.1, 2.1, 0.3, 12);
    var plastronMesh = new THREE.Mesh(plastronGeo, plastronMat);
    plastronMesh.position.y = -0.2;
    turtleGroup.add(plastronMesh);

    // Front Flippers
    var flipperMat = new THREE.MeshPhongMaterial({ color: 0x3b7a51, roughness: 0.5 });

    var leftFlipperGeo = new THREE.BoxGeometry(2.8, 0.12, 0.9);
    var leftFlipper = new THREE.Mesh(leftFlipperGeo, flipperMat);
    leftFlipper.position.set(-2.2, -0.1, 0.9);
    leftFlipper.rotation.z = -0.25;
    leftFlipper.rotation.y = 0.3;
    leftFlipper.name = 'leftFlipper';
    turtleGroup.add(leftFlipper);

    var rightFlipper = new THREE.Mesh(leftFlipperGeo, flipperMat);
    rightFlipper.position.set(2.2, -0.1, 0.9);
    rightFlipper.rotation.z = 0.25;
    rightFlipper.rotation.y = -0.3;
    rightFlipper.name = 'rightFlipper';
    turtleGroup.add(rightFlipper);

    // Hind Flippers
    var rearFlipperGeo = new THREE.BoxGeometry(1.2, 0.1, 0.7);
    var leftRear = new THREE.Mesh(rearFlipperGeo, flipperMat);
    leftRear.position.set(-1.1, -0.15, -2.1);
    turtleGroup.add(leftRear);

    var rightRear = new THREE.Mesh(rearFlipperGeo, flipperMat);
    rightRear.position.set(1.1, -0.15, -2.1);
    turtleGroup.add(rightRear);

    // Head & Neck
    var headMat = new THREE.MeshPhongMaterial({ color: 0x3b7a51, shininess: 15 });
    var headGeo = new THREE.SphereGeometry(0.75, 10, 10);
    var headMesh = new THREE.Mesh(headGeo, headMat);
    headMesh.position.set(0, 0.1, 2.4);
    headMesh.scale.set(0.85, 0.75, 1.2);
    turtleGroup.add(headMesh);

    // Eyes
    var eyeMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
    var leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), eyeMat);
    leftEye.position.set(-0.45, 0.25, 2.7);
    turtleGroup.add(leftEye);

    var rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), eyeMat);
    rightEye.position.set(0.45, 0.25, 2.7);
    turtleGroup.add(rightEye);

    _registerFaunaNode(turtleGroup, id, name, 'turtle', x, y, z);
  }

  /* --- B. JELLYFISH CLUSTER BUILDER --- */
  function _buildJellyfishCluster(centerX, centerY, centerZ, population, idPrefix) {
    for (var i = 0; i < population; i++) {
      var jellyGroup = new THREE.Group();

      var capMat = new THREE.MeshPhongMaterial({
        color: 0xff02aa,
        transparent: true,
        opacity: 0.65,
        emissive: 0x660033,
        emissiveIntensity: 0.6,
        shininess: 90
      });

      var capGeo = new THREE.SphereGeometry(1.3, 16, 16, 0, Math.PI * 2, 0, Math.PI / 1.7);
      var capMesh = new THREE.Mesh(capGeo, capMat);
      jellyGroup.add(capMesh);

      var innerCoreMat = new THREE.MeshBasicMaterial({
        color: 0x00ffff,
        transparent: true,
        opacity: 0.8
      });
      var innerCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 2), innerCoreMat);
      innerCore.position.y = -0.3;
      jellyGroup.add(innerCore);

      var tentacleMat = new THREE.MeshBasicMaterial({
        color: 0xff66cc,
        transparent: true,
        opacity: 0.6
      });

      var tentacleCount = 8;
      for (var t = 0; t < tentacleCount; t++) {
        var angle = (t / tentacleCount) * Math.PI * 2;
        var tentacleGeo = new THREE.CylinderGeometry(0.03, 0.01, 3.8, 6);
        var tentacleMesh = new THREE.Mesh(tentacleGeo, tentacleMat);
        tentacleMesh.position.set(Math.cos(angle) * 0.75, -2.0, Math.sin(angle) * 0.75);
        jellyGroup.add(tentacleMesh);
      }

      var offsetX = centerX + (Math.random() - 0.5) * 18.0;
      var offsetY = centerY + (Math.random() - 0.5) * 8.0;
      var offsetZ = centerZ + (Math.random() - 0.5) * 18.0;

      _registerFaunaNode(jellyGroup, idPrefix + '_' + i, 'Bioluminescent Jellyfish', 'jellyfish', offsetX, offsetY, offsetZ);
    }
  }

  /* --- C. CLOWNFISH SCHOOL BUILDER --- */
  function _buildClownfishSchool(centerX, centerY, centerZ, population, idPrefix) {
    var clownCanvas = document.createElement('canvas');
    clownCanvas.width = 256;
    clownCanvas.height = 256;
    var ctx = clownCanvas.getContext('2d');

    ctx.fillStyle = '#ff4500';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(60, 0, 40, 256);
    ctx.fillRect(160, 0, 30, 256);
    ctx.fillStyle = '#000000';
    ctx.fillRect(55, 0, 5, 256);
    ctx.fillRect(100, 0, 5, 256);
    ctx.fillRect(155, 0, 5, 256);
    ctx.fillRect(190, 0, 5, 256);

    var clownTex = new THREE.CanvasTexture(clownCanvas);
    var fishMat = new THREE.MeshPhongMaterial({ map: clownTex, shininess: 40 });

    for (var i = 0; i < population; i++) {
      var fishGroup = new THREE.Group();

      var bodyGeo = new THREE.SphereGeometry(0.55, 12, 12);
      var bodyMesh = new THREE.Mesh(bodyGeo, fishMat);
      bodyMesh.scale.set(0.55, 0.95, 1.7);
      fishGroup.add(bodyMesh);

      var tailGeo = new THREE.ConeGeometry(0.45, 0.9, 4);
      var tailMesh = new THREE.Mesh(tailGeo, fishMat);
      tailMesh.rotation.x = Math.PI / 2;
      tailMesh.position.z = -1.15;
      tailMesh.name = 'tail';
      fishGroup.add(tailMesh);

      var finMat = new THREE.MeshBasicMaterial({ color: 0xff4500 });
      var dorsalFin = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.6, 3), finMat);
      dorsalFin.position.set(0, 0.7, 0.1);
      dorsalFin.rotation.x = -0.4;
      fishGroup.add(dorsalFin);

      var offsetX = centerX + (Math.random() - 0.5) * 10.0;
      var offsetY = centerY + (Math.random() - 0.5) * 5.0;
      var offsetZ = centerZ + (Math.random() - 0.5) * 10.0;

      _registerFaunaNode(fishGroup, idPrefix + '_' + i, 'Anemone Clownfish', 'clownfish', offsetX, offsetY, offsetZ);
    }
  }

  /* --- D. MANTA RAY BUILDER --- */
  function _buildMantaRay(x, y, z, id, name) {
    var mantaGroup = new THREE.Group();

    var bodyMat = new THREE.MeshPhongMaterial({ color: 0x182430, side: THREE.DoubleSide, roughness: 0.4 });
    var bellyMat = new THREE.MeshPhongMaterial({ color: 0xe0e6ed, side: THREE.DoubleSide });

    // Main Central Body Disc
    var bodyGeo = new THREE.ConeGeometry(2.8, 6.5, 10);
    var bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.rotation.x = Math.PI / 2;
    bodyMesh.scale.set(1.1, 0.18, 1.0);
    mantaGroup.add(bodyMesh);

    // Left Wing
    var wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.lineTo(-7.5, -1.5);
    wingShape.lineTo(-2.0, -4.5);
    wingShape.lineTo(0, -2.5);
    wingShape.closePath();

    var wingExtrude = new THREE.ExtrudeGeometry(wingShape, { depth: 0.15, bevelEnabled: true, bevelThickness: 0.05 });
    var leftWing = new THREE.Mesh(wingExtrude, bodyMat);
    leftWing.rotation.x = Math.PI / 2;
    leftWing.position.set(0, 0, 1.5);
    leftWing.name = 'leftWing';
    mantaGroup.add(leftWing);

    // Right Wing
    var rightWing = new THREE.Mesh(wingExtrude, bodyMat);
    rightWing.scale.set(-1, 1, 1);
    rightWing.rotation.x = Math.PI / 2;
    rightWing.position.set(0, 0, 1.5);
    rightWing.name = 'rightWing';
    mantaGroup.add(rightWing);

    // Whip Tail
    var tailGeo = new THREE.CylinderGeometry(0.08, 0.02, 8.0, 6);
    var tailMesh = new THREE.Mesh(tailGeo, bodyMat);
    tailMesh.rotation.x = Math.PI / 2;
    tailMesh.position.set(0, 0, -6.5);
    mantaGroup.add(tailMesh);

    _registerFaunaNode(mantaGroup, id, name, 'manta', x, y, z);
  }

  /* --- E. BIOLUMINESCENT EEL BUILDER --- */
  function _buildBioluminescentEel(x, y, z, id, name) {
    var eelGroup = new THREE.Group();

    var eelMat = new THREE.MeshPhongMaterial({
      color: 0x00ffaa,
      emissive: 0x00aa66,
      emissiveIntensity: 0.8,
      wireframe: true
    });

    var segmentedBodyGeo = new THREE.CylinderGeometry(0.35, 0.08, 11.0, 8, 24);
    var eelMesh = new THREE.Mesh(segmentedBodyGeo, eelMat);
    eelMesh.rotation.x = Math.PI / 2;
    eelGroup.add(eelMesh);

    var headGeo = new THREE.SphereGeometry(0.42, 8, 8);
    var headMesh = new THREE.Mesh(headGeo, eelMat);
    headMesh.position.set(0, 0, 5.5);
    headMesh.scale.set(0.9, 0.8, 1.4);
    eelGroup.add(headMesh);

    _registerFaunaNode(eelGroup, id, name, 'eel', x, y, z);
  }

  /* --- F. APEX SHARK BUILDER --- */
  function _buildApexShark(x, y, z, id, name) {
    var sharkGroup = new THREE.Group();

    var sharkMat = new THREE.MeshPhongMaterial({ color: 0x2c3e50, shininess: 50, roughness: 0.3 });
    var bellyMat = new THREE.MeshPhongMaterial({ color: 0xd5dbdb, shininess: 20 });

    // Torso
    var bodyGeo = new THREE.SphereGeometry(2.0, 14, 14);
    var bodyMesh = new THREE.Mesh(bodyGeo, sharkMat);
    bodyMesh.scale.set(0.75, 0.85, 3.4);
    sharkGroup.add(bodyMesh);

    // Dorsal Fin
    var finGeo = new THREE.ConeGeometry(0.9, 2.6, 5);
    var dorsalFin = new THREE.Mesh(finGeo, sharkMat);
    dorsalFin.position.set(0, 2.0, -0.2);
    dorsalFin.rotation.x = -0.45;
    sharkGroup.add(dorsalFin);

    // Pectoral Fins
    var pecFinGeo = new THREE.BoxGeometry(2.2, 0.12, 1.1);
    var leftPec = new THREE.Mesh(pecFinGeo, sharkMat);
    leftPec.position.set(-1.8, -0.5, 1.0);
    leftPec.rotation.z = -0.35;
    leftPec.rotation.y = 0.4;
    sharkGroup.add(leftPec);

    var rightPec = new THREE.Mesh(pecFinGeo, sharkMat);
    rightPec.position.set(1.8, -0.5, 1.0);
    rightPec.rotation.z = 0.35;
    rightPec.rotation.y = -0.4;
    sharkGroup.add(rightPec);

    // Tail Fin
    var tailFinGeo = new THREE.ConeGeometry(1.2, 3.2, 4);
    var tailFin = new THREE.Mesh(tailFinGeo, sharkMat);
    tailFin.position.set(0, 0.4, -6.2);
    tailFin.rotation.x = Math.PI / 2;
    tailFin.name = 'sharkTail';
    sharkGroup.add(tailFin);

    _registerFaunaNode(sharkGroup, id, name, 'shark', x, y, z);
  }

  /* --- G. ANGLERFISH BUILDER --- */
  function _buildAnglerfish(x, y, z, id, name) {
    var anglerGroup = new THREE.Group();

    var bodyMat = new THREE.MeshPhongMaterial({ color: 0x1c120c, roughness: 0.9, flatShading: true });
    var bodyGeo = new THREE.DodecahedronGeometry(1.8, 1);
    var bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.scale.set(0.9, 1.1, 1.3);
    anglerGroup.add(bodyMesh);

    // Lure Stalk (Illium)
    var stalkGeo = new THREE.CylinderGeometry(0.04, 0.04, 2.2, 6);
    var stalkMesh = new THREE.Mesh(stalkGeo, bodyMat);
    stalkMesh.position.set(0, 1.6, 1.2);
    stalkMesh.rotation.x = 0.6;
    anglerGroup.add(stalkMesh);

    // Lure Esca (Glowing Sphere)
    var escaMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
    var escaMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 10), escaMat);
    escaMesh.position.set(0, 2.3, 2.1);
    anglerGroup.add(escaMesh);

    // Esca Light Source
    var escaLight = new THREE.PointLight(0x00ffff, 1.8, 12);
    escaLight.position.set(0, 2.3, 2.1);
    anglerGroup.add(escaLight);

    // Fangs
    var toothMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
    for (var f = 0; f < 8; f++) {
      var fang = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.4, 4), toothMat);
      var angle = (f / 8) * Math.PI - Math.PI / 2;
      fang.position.set(Math.sin(angle) * 0.9, -0.4 + (f % 2) * 0.1, 1.8 + Math.cos(angle) * 0.3);
      fang.rotation.x = Math.PI - 0.3;
      anglerGroup.add(fang);
    }

    _registerFaunaNode(anglerGroup, id, name, 'anglerfish', x, y, z);
  }

  /* --- H. GIANT ISOPOD BUILDER --- */
  function _buildGiantIsopod(x, y, z, id, name) {
    var isopodGroup = new THREE.Group();

    var shellMat = new THREE.MeshPhongMaterial({ color: 0x8d7d6f, roughness: 0.7, flatShading: true });

    // Segmented Carapace
    for (var s = 0; s < 6; s++) {
      var segGeo = new THREE.CylinderGeometry(1.2 - s * 0.12, 1.3 - s * 0.12, 0.5, 8);
      var segMesh = new THREE.Mesh(segGeo, shellMat);
      segMesh.rotation.x = Math.PI / 2;
      segMesh.scale.set(1.2, 0.5, 1.0);
      segMesh.position.set(0, 0.2, (s * 0.42) - 1.0);
      isopodGroup.add(segMesh);
    }

    // Antennae
    var antMat = new THREE.MeshBasicMaterial({ color: 0x4a3f35 });
    var leftAnt = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.01, 1.8), antMat);
    leftAnt.position.set(-0.4, 0.2, 1.6);
    leftAnt.rotation.x = 1.2;
    leftAnt.rotation.z = -0.4;
    isopodGroup.add(leftAnt);

    var rightAnt = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.01, 1.8), antMat);
    rightAnt.position.set(0.4, 0.2, 1.6);
    rightAnt.rotation.x = 1.2;
    rightAnt.rotation.z = 0.4;
    isopodGroup.add(rightAnt);

    _registerFaunaNode(isopodGroup, id, name, 'isopod', x, y, z);
  }

  /* ===========================================================================
     6. KINEMATIC ANIMATION ENGINE
     =========================================================================== */

  function update(delta, time) {
    for (var i = 0; i < _faunaRegistry.length; i++) {
      var item = _faunaRegistry[i];
      var mesh = item.mesh;
      var bp = item.basePosition;
      var offset = item.phaseOffset || 0.0;

      if (item.animType === 'turtle') {
        mesh.position.x = bp.x + Math.sin(time * 0.35 + offset) * 16.0;
        mesh.position.z = bp.z + Math.cos(time * 0.35 + offset) * 16.0;
        mesh.position.y = bp.y + Math.sin(time * 0.8 + offset) * 1.5;
        mesh.rotation.y = time * 0.35 + offset + Math.PI / 2;

        var lw = mesh.getObjectByName('leftFlipper');
        var rw = mesh.getObjectByName('rightFlipper');
        if (lw && rw) {
          lw.rotation.z = Math.sin(time * 2.8 + offset) * 0.35 - 0.2;
          rw.rotation.z = -Math.sin(time * 2.8 + offset) * 0.35 + 0.2;
        }

      } else if (item.animType === 'jellyfish') {
        mesh.position.y = bp.y + Math.sin(time * 1.4 + offset) * 2.2;
        var scalePulse = 1.0 + Math.sin(time * 2.2 + offset) * 0.12;
        mesh.scale.set(scalePulse, 1.0 / scalePulse, scalePulse);

      } else if (item.animType === 'clownfish') {
        mesh.position.x = bp.x + Math.sin(time * 2.2 + offset + i) * 3.2;
        mesh.position.z = bp.z + Math.cos(time * 2.2 + offset + i) * 3.2;
        mesh.position.y = bp.y + Math.sin(time * 3.0 + offset) * 0.6;

        var tail = mesh.getObjectByName('tail');
        if (tail) {
          tail.rotation.y = Math.sin(time * 10.0 + i) * 0.4;
        }

      } else if (item.animType === 'manta') {
        mesh.position.x = bp.x + Math.sin(time * 0.25 + offset) * 30.0;
        mesh.position.z = bp.z + Math.cos(time * 0.25 + offset) * 30.0;
        mesh.position.y = bp.y + Math.sin(time * 0.5 + offset) * 2.5;
        mesh.rotation.y = time * 0.25 + offset + Math.PI / 2;

        var leftWing = mesh.getObjectByName('leftWing');
        var rightWing = mesh.getObjectByName('rightWing');
        if (leftWing && rightWing) {
          var flap = Math.sin(time * 1.8 + offset) * 0.25;
          leftWing.rotation.z = flap;
          rightWing.rotation.z = -flap;
        }

      } else if (item.animType === 'eel') {
        mesh.position.y = bp.y + Math.sin(time * 1.1 + offset) * 1.4;
        mesh.rotation.z = Math.sin(time * 1.8 + offset) * 0.2;
        mesh.rotation.y = Math.cos(time * 1.2 + offset) * 0.15;

      } else if (item.animType === 'shark') {
        mesh.position.x = bp.x + Math.sin(time * 0.45 + offset) * 45.0;
        mesh.position.z = bp.z + Math.cos(time * 0.45 + offset) * 45.0;
        mesh.position.y = bp.y + Math.sin(time * 0.7 + offset) * 2.0;
        mesh.rotation.y = time * 0.45 + offset + Math.PI / 2;

        var sharkTail = mesh.getObjectByName('sharkTail');
        if (sharkTail) {
          sharkTail.rotation.y = Math.sin(time * 5.0) * 0.35;
        }

      } else if (item.animType === 'anglerfish') {
        mesh.position.y = bp.y + Math.sin(time * 0.9 + offset) * 0.8;
        mesh.rotation.y = bp.y + Math.sin(time * 0.3 + offset) * 0.4;

      } else if (item.animType === 'isopod') {
        mesh.position.x = bp.x + Math.sin(time * 0.2 + offset) * 2.0;
        mesh.position.z = bp.z + Math.cos(time * 0.2 + offset) * 2.0;

      } else if (item.animType === 'glb_custom') {
        mesh.rotation.y += (item.rotationSpeed || 0.2) * delta;
      }
    }
  }

  /* ===========================================================================
     7. PUBLIC MODULE EXPORTS
     =========================================================================== */

  return {
    init: init,
    loadGLBModel: loadGLBModel,
    update: update
  };
})();