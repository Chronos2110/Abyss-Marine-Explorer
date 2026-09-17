/* =============================================================================
   ABYSS: Marine Explorer — Ocean Environment Module
   =============================================================================
   * Procedural Sea Floor & Trench Terrain Generation
   * Atmospheric Water Fog & Volumetric Lighting Setup
   * Marine Snow & Dynamic Bubble Particle Systems
   * Hydrothermal Vent Plumes, Coral Formations, & Sunken Shipwreck Debris
   * Scan/Clean Debris Target Registry
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

ABYSS.Environment = (function () {
  'use strict';

  var _scene = null;
  var _interactables = [];

  // Particle Systems State
  var _marineSnowGeo = null;
  var _marineSnowMat = null;
  var _marineSnowParticles = null;

  var _bubblesGeo = null;
  var _bubblesMat = null;
  var _bubblesParticles = null;
  var _bubbleVelocities = [];

  function init(scene, interactablesArray) {
    _scene = scene;
    _interactables = interactablesArray;

    _setupLightingAndFog();
    _buildSeaFloor();
    _buildHydrothermalVents();
    _buildCoralReefs();
    _buildSunkenDebris();
    _buildParticleSystems();
  }

  function _setupLightingAndFog() {
  // Lower fog density so terrain and fauna are clearly visible
  _scene.background = new THREE.Color(0x02162e);
  _scene.fog = new THREE.FogExp2(0x02162e, 0.006); // Changed from 0.018 to 0.006

  // Boost ambient and directional lights
  var ambientLight = new THREE.AmbientLight(0x1a5276, 2.5); // Increased intensity
  _scene.add(ambientLight);

  var sunLight = new THREE.DirectionalLight(0x00ffff, 2.5);
  sunLight.position.set(0, 100, 0);
  _scene.add(sunLight);

  var subSpotlight = new THREE.PointLight(0x00ffcc, 3.0, 60);
  subSpotlight.position.set(0, 0, 0);
  _scene.add(subSpotlight);
}

  function _buildSeaFloor() {
    var width = 600;
    var height = 600;
    var segments = 120;

    var geo = new THREE.PlaneGeometry(width, height, segments, segments);
    geo.rotateX(-Math.PI / 2);

    var posAttr = geo.attributes.position;
    for (var i = 0; i < posAttr.count; i++) {
      var x = posAttr.getX(i);
      var z = posAttr.getZ(i);

      // Multi-frequency noise for ocean seabed, trenches, and mounds
      var y = Math.sin(x * 0.015) * Math.cos(z * 0.015) * 6.0 +
              Math.sin(x * 0.04) * Math.cos(z * 0.04) * 2.5 +
              Math.cos(x * 0.005 + z * 0.008) * 12.0;

      // Deep abyssal trench running diagonally
      var trenchDist = Math.abs(x - z);
      if (trenchDist < 80) {
        y -= (80 - trenchDist) * 0.25;
      }

      posAttr.setY(i, y - 26.0); // Baseline depth
    }
    geo.computeVertexNormals();

    var mat = new THREE.MeshStandardMaterial({
      color: 0x071b2c,
      roughness: 0.95,
      metalness: 0.1,
      flatShading: true
    });

    var seaFloorMesh = new THREE.Mesh(geo, mat);
    seaFloorMesh.receiveShadow = true;
    _scene.add(seaFloorMesh);
  }

  function _buildHydrothermalVents() {
    var ventPositions = [
      { x: -120, z: -140 },
      { x: 140, z: 120 },
      { x: -50, z: -180 }
    ];

    var ventMat = new THREE.MeshStandardMaterial({
      color: 0x1a110b,
      roughness: 0.9,
      flatShading: true
    });

    ventPositions.forEach(function (pos) {
      var ventGroup = new THREE.Group();

      // Vent Chimney Tower
      var geo = new THREE.CylinderGeometry(1.5, 4.5, 12.0, 8);
      var mesh = new THREE.Mesh(geo, ventMat);
      mesh.position.y = -20.0;
      ventGroup.add(mesh);

      // Glowing Vent Mouth
      var mouthGeo = new THREE.ConeGeometry(2.0, 1.5, 8);
      var mouthMat = new THREE.MeshBasicMaterial({ color: 0xff3300 });
      var mouthMesh = new THREE.Mesh(mouthGeo, mouthMat);
      mouthMesh.position.y = -14.0;
      mouthMesh.rotation.x = Math.PI;
      ventGroup.add(mouthMesh);

      // Heat Glow Light
      var ventLight = new THREE.PointLight(0xff5500, 2.5, 25);
      ventLight.position.y = -13.0;
      ventGroup.add(ventLight);

      ventGroup.position.set(pos.x, 0, pos.z);
      _scene.add(ventGroup);
    });
  }

  function _buildCoralReefs() {
    var reefCenters = [
      { x: 80, z: -90, radius: 25 },
      { x: -110, z: 80, radius: 30 }
    ];

    reefCenters.forEach(function (reef) {
      var count = 35;
      for (var i = 0; i < count; i++) {
        var angle = Math.random() * Math.PI * 2;
        var dist = Math.random() * reef.radius;
        var x = reef.x + Math.cos(angle) * dist;
        var z = reef.z + Math.sin(angle) * dist;

        var coralType = Math.floor(Math.random() * 3);
        var coralMesh;

        if (coralType === 0) {
          // Brain Coral
          var geo = new THREE.DodecahedronGeometry(1.8 + Math.random() * 1.5, 2);
          var mat = new THREE.MeshStandardMaterial({ color: 0x00ffcc, roughness: 0.7, flatShading: true });
          coralMesh = new THREE.Mesh(geo, mat);
          coralMesh.position.set(x, -24.5, z);

        } else if (coralType === 1) {
          // Branching Staghorn Coral
          var group = new THREE.Group();
          var matBranch = new THREE.MeshStandardMaterial({ color: 0xff0077, roughness: 0.6 });
          for (var b = 0; b < 5; b++) {
            var branchGeo = new THREE.CylinderGeometry(0.15, 0.35, 3.5, 6);
            var branch = new THREE.Mesh(branchGeo, matBranch);
            branch.position.set((Math.random() - 0.5) * 0.8, 1.5, (Math.random() - 0.5) * 0.8);
            branch.rotation.z = (Math.random() - 0.5) * 0.6;
            branch.rotation.x = (Math.random() - 0.5) * 0.6;
            group.add(branch);
          }
          group.position.set(x, -25.5, z);
          coralMesh = group;

        } else {
          // Plate Coral
          var geoP = new THREE.CylinderGeometry(2.5 + Math.random() * 2.0, 0.4, 0.3, 8);
          var matP = new THREE.MeshStandardMaterial({ color: 0xaaff00, roughness: 0.8 });
          coralMesh = new THREE.Mesh(geoP, matP);
          coralMesh.position.set(x, -24.8 + Math.random() * 1.2, z);
        }

        _scene.add(coralMesh);
      }
    });
  }

  function _buildSunkenDebris() {
    // Toxic Waste Barrels / Debris targets for Submersible Cleaning Missions
    var debrisLocations = [
      { x: -140, y: -23.5, z: 100, name: 'Toxic Chemical Barrel Alpha' },
      { x: -155, y: -23.8, z: 120, name: 'Hazardous Waste Container Beta' },
      { x: -130, y: -24.0, z: 135, name: 'Radioactive Waste Barrel Gamma' },
      { x: 100, y: -23.2, z: 110, name: 'Sunken Ship Cargo Pod' },
      { x: -60, y: -24.2, z: -130, name: 'Sunken Industrial Barrel Delta' }
    ];

    var barrelMat = new THREE.MeshPhongMaterial({
      color: 0xcc3300,
      emissive: 0x441100,
      shininess: 30
    });

    var stripeMat = new THREE.MeshBasicMaterial({ color: 0xffcc00 });

    debrisLocations.forEach(function (loc, index) {
      var debrisGroup = new THREE.Group();

      // Barrel Body
      var barrelGeo = new THREE.CylinderGeometry(1.2, 1.2, 2.8, 12);
      var barrelMesh = new THREE.Mesh(barrelGeo, barrelMat);
      debrisGroup.add(barrelMesh);

      // Biohazard Caution Band
      var bandGeo = new THREE.CylinderGeometry(1.22, 1.22, 0.5, 12);
      var bandMesh = new THREE.Mesh(bandGeo, stripeMat);
      bandMesh.position.y = 0.2;
      debrisGroup.add(bandMesh);

      // Position & Orientation
      debrisGroup.position.set(loc.x, loc.y, loc.z);
      debrisGroup.rotation.z = Math.random() * 0.6 - 0.3;
      debrisGroup.rotation.x = Math.PI / 2 + (Math.random() - 0.5) * 0.2;

      debrisGroup.userData = {
        type: 'debris',
        id: 'debris_' + index,
        name: loc.name,
        scanned: false,
        cleaned: false
      };

      _scene.add(debrisGroup);
      _interactables.push(debrisGroup);
    });
  }

  function _buildParticleSystems() {
    // 1. Marine Snow (Subtle floating particulate matter)
    var countSnow = 1200;
    _marineSnowGeo = new THREE.BufferGeometry();
    var snowPositions = new Float32Array(countSnow * 3);

    for (var i = 0; i < countSnow * 3; i += 3) {
      snowPositions[i] = (Math.random() - 0.5) * 350;
      snowPositions[i + 1] = (Math.random() - 0.5) * 60;
      snowPositions[i + 2] = (Math.random() - 0.5) * 350;
    }

    _marineSnowGeo.setAttribute('position', new THREE.BufferAttribute(snowPositions, 3));

    _marineSnowMat = new THREE.PointsMaterial({
      color: 0x88e5ff,
      size: 0.4,
      transparent: true,
      opacity: 0.55
    });

    _marineSnowParticles = new THREE.Points(_marineSnowGeo, _marineSnowMat);
    _scene.add(_marineSnowParticles);

    // 2. Rising Bubbles System
    var countBubbles = 150;
    _bubblesGeo = new THREE.BufferGeometry();
    var bubblePositions = new Float32Array(countBubbles * 3);
    _bubbleVelocities = [];

    for (var b = 0; b < countBubbles * 3; b += 3) {
      bubblePositions[b] = (Math.random() - 0.5) * 200;
      bubblePositions[b + 1] = -25 + Math.random() * 45;
      bubblePositions[b + 2] = (Math.random() - 0.5) * 200;

      _bubbleVelocities.push({
        speed: 1.5 + Math.random() * 3.0,
        wobble: Math.random() * Math.PI * 2
      });
    }

    _bubblesGeo.setAttribute('position', new THREE.BufferAttribute(bubblePositions, 3));

    _bubblesMat = new THREE.PointsMaterial({
      color: 0xaaffff,
      size: 0.6,
      transparent: true,
      opacity: 0.75
    });

    _bubblesParticles = new THREE.Points(_bubblesGeo, _bubblesMat);
    _scene.add(_bubblesParticles);
  }

  function update(delta, time) {
    // Animate Marine Snow Drifting Downward
    if (_marineSnowGeo) {
      var positions = _marineSnowGeo.attributes.position.array;
      for (var i = 1; i < positions.length; i += 3) {
        positions[i] -= delta * 0.8;
        if (positions[i] < -26.0) {
          positions[i] = 30.0;
        }
      }
      _marineSnowGeo.attributes.position.needsUpdate = true;
    }

    // Animate Rising Ocean Bubbles
    if (_bubblesGeo) {
      var bPos = _bubblesGeo.attributes.position.array;
      var vIndex = 0;
      for (var b = 0; b < bPos.length; b += 3) {
        var vel = _bubbleVelocities[vIndex];
        bPos[b + 1] += vel.speed * delta;
        bPos[b] += Math.sin(time * 2.0 + vel.wobble) * 0.03;

        if (bPos[b + 1] > 28.0) {
          bPos[b + 1] = -25.0;
          bPos[b] = (Math.random() - 0.5) * 200;
          bPos[b + 2] = (Math.random() - 0.5) * 200;
        }
        vIndex++;
      }
      _bubblesGeo.attributes.position.needsUpdate = true;
    }
  }

// At the bottom of js/environment.js:

  return {
    init: init,
    build: init, // <--- ADD THIS LINE
    update: update
  };
})();