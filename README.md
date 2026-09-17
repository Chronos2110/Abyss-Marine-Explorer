### Key Visual Systems:
1. **Stereoscopic Split-Screen**: Synchronized dual-camera rig with realistic Interpupillary Distance (IPD ~64mm) providing natural depth perception in Google Cardboard / VR headsets.
2. **Dynamic Gaze Reticle**: A hands-free targeting crosshair that expands into a 360° circular progress ring when locking onto marine entities or hazardous objects.
3. **Underwater Atmosphere**: Exponential depth fog (`#02162e`), volumetric point-lights, black-smoker vent chimney glow, and dual particle systems simulating marine snow and rising buoyant bubble columns.
4. **Active Sonar Radar**: Dual-eye 360° scanning sweep radar displaying green blips for fauna and red blips for hazardous debris.

## ⚙️ Architecture & How It Works

The project is architected into modular vanilla JavaScript namespaces under `window.ABYSS`:

FOLDER STRUCTURE:
abyss-marine-explorer/
├── index.html                 # Dual canvas layout (#vrCanvas & #hudCanvas) & overlay modals
├── style.css                  # Cyberpunk / sci-fi HUD styling & Orbitron typography
├── research_station.glb       # External 3D asset (Submersible research facility)
├── trash_item.glb             # External 3D asset (Sunken environmental debris)
└── js/
├── controls.js            # Gyroscope DeviceOrientation + Desktop WASD/Mouse input
├── environment.js         # Procedural sea floor, vents, coral reefs & particle systems
├── entities.js            # Procedural fauna generator, kinematics & GLTF pipeline
├── audio.js               # Zero-dependency Web Audio API procedural sound synthesizer
└── main.js                # Core render loop, dual-pass stereoscopic pipeline & HUD

### 1. Stereoscopic Dual-Camera Pipeline (`main.js`)
* Employs a root `_cameraRig` `THREE.Group` that holds two perspective cameras (`_cameraL` and `_cameraR`) offset by `±0.032m` on the X-axis (64mm IPD).
* In each animation frame, the renderer activates scissor testing (`renderer.setScissorTest(true)`), rendering the scene from the left camera onto the left half of the canvas (`[0, 0, w/2, h]`), and the right camera onto the right half (`[w/2, 0, w/2, h]`).

### 2. Gaze-Based Dwell Interaction (`main.js`)
* Operates 100% hands-free for mobile VR: a central raycast vector `(0, 0, -1)` projects from the camera rig orientation.
* When the crosshair intersects an interactable mesh (`type: 'fauna'` or `'debris'`), a dwell timer accumulates up to `GAZE_DURATION = 1.5s`.
* Audio pitch climbs dynamically with scan progress. Once the dwell duration is met, the target is registered as scanned or cleansed.

### 3. Procedural Marine Fauna & Kinematic Engine (`entities.js`)
* Generates 8 distinct anatomical species distributed across 8 world coordinates without requiring external model downloads:
  * **Hawksbill Sea Turtle**: Articulated flippers undergoing harmonic wing oscillations.
  * **Bioluminescent Jellyfish**: Periodic vertical buoyant drift with dome pulsing scale.
  * **Anemone Clownfish Schools**: Cohesive group schooling with high-frequency tail wagging.
  * **Giant Oceanic Manta Ray**: Wide wingspan pectoral flap kinematics.
  * **Abyssal Bioluminescent Eel**: Segmented sinusoidal undulation with wireframe luminescence.
  * **Apex Deep-Sea Shark**: Multi-fin predatory cruise mechanics.
  * **Deep-Trench Anglerfish**: Dodecahedron body with real-time dynamic point-light bioluminescent esca.
  * **Benthic Giant Isopod**: Multi-segmented carapace bottom-scavenging crawls.
* Also includes an asynchronous **GLTF / GLB loader pipeline** (`loadGLBModel`) to ingest external assets (`research_station.glb`, `trash_item.glb`).

### 4. Ocean Trench Environment (`environment.js`)
* **Terrain Generation**: 600×600 procedural plane geometry with 14,400 vertices deformed via multi-octave sinusoidal algorithms and an abyssal diagonal trench trough.
* **Hydrothermal Vents**: Volcanic chimneys with black-smoker heat vents and point-light thermal sources.
* **Coral Biomes**: Procedural brain, branching staghorn, and shelf plate corals.
* **Particulate Simulators**: Marine snow buffer geometry with continuous downward drift and rising, wobbling bubble columns.

### 5. Web Audio API Procedural Synthesizer (`audio.js`)
No external `.mp3` or `.wav` files are required:
* **Deep Sub Drone**: 42 Hz sawtooth oscillator filtered through a 110 Hz low-pass biquad filter.
* **Sonar Ping**: Sine oscillator exponential frequency sweep from 1250 Hz down to 380 Hz.
* **Telemetry Scan Beep**: Real-time ascending tone scaling from 550 Hz to 1400 Hz mapped to scan completion ratio.
* **Target Lock Chime**: Arpeggiated four-note chord sequence ($C_5 \rightarrow E_5 \rightarrow G_5 \rightarrow C_6$).
* **Debris Cleanse SFX**: Ascending frequency sweep from 280 Hz to 880 Hz with gain decay.

## 🎮 Controls & Interaction
| Mode | Control | Action |
| :--- | :--- | :--- |
| **Mobile VR** | Head Movement (Gyroscope) | 360° Pitch, Roll, and Yaw camera control |
| **Mobile VR** | Center Crosshair Dwell | Gaze at fauna/debris for 1.5s to scan/cleanse |
| **Desktop** | Mouse Click & Drag | Look around (Pitch & Yaw) |
| **Desktop** | `W` / `A` / `S` / `D` | Thrust Forward / Strafe Left / Reverse / Strafe Right |
| **Desktop** | `Q` / `E` | Descend / Ascend vertically |

---

## 🚀 Getting Started

COMMANDS:
### Local Development
Because the project uses standard ES modules and WebGL, run it through a local HTTP server:

# Clone the repository
git clone [https://github.com/your-username/abyss-marine-explorer.git](https://github.com/your-username/abyss-marine-explorer.git)
cd abyss-marine-explorer
# Option 1: Using Python 3
python3 -m http.server 5500
# Option 2: Using Node.js (npx http-server)
npx http-server -p 5500
# Option 3: VS Code Live Server
# Right click index.html -> 'Open with Live Server'

📋 Objectives & Rules
Scan Fauna: Catalog species distributed across all ocean quadrants.
Cleanse Debris: Gaze-target toxic chemical barrels and cargo pods to extract them.
Monitor Oxygen: Submersible life-support depletes over time—complete the mission before reserves hit 0%!

🛠️ Tech Stack & Dependencies
Core 3D Engine: Three.js (r128)
Asset Pipeline: THREE.GLTFLoader
Audio Synthesis: Native HTML5 Web Audio API
Sensors: DeviceOrientation & DeviceMotion Web APIs
Typography: Orbitron via Google Fonts
