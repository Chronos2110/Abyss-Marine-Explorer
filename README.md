FOLDER STRUCTURE:
abyss-marine-explorer/
├── src/
│   ├── audio.js         # Web Audio API synthetic soundscape (no mp3s needed)
│   ├── config.js        # Mission targets, speeds, IPD, species log meta
│   ├── controls.js      # Hybrid WASD + drag-look + mobile device orientation
│   ├── entities.js      # Procedural fauna rigs & cinematic shark sequence
│   ├── environment.js   # Seabed terrain mesh, lighting, pollution & snow
│   ├── gameplay.js      # Raycasting, gaze state machine, mission win/loss logic
│   ├── main.js          # Core loop & SBS stereoscopic scissor-viewport pipeline
│   ├── style.css        # Sci-fi terminal HUD & glowing neon UI cards
│   └── ui.js            # Dual-canvas 2D HUD renderer for stereoscopic reticle
├── index.html           # Canvas mounting & modal overlays
├── vite.config.js       # Local host server & bundling configs
└── package.json


## 🚀 Quickstart & Local Setup

### 1. Prerequisites
- **Node.js** (v18 or higher recommended)
- **npm** or **pnpm** / **yarn**

### 2. Clone & Install
git clone [https://github.com/your-username/abyss-marine-explorer.git](https://github.com/your-username/abyss-marine-explorer.git)
cd abyss-marine-explorer
npm install
(if npm install doesnt run, do npm audit fix--force OR npm install --force)

RUN DEV SERVER
npm run dev
Then open on localhost
