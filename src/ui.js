import { CONFIG } from './config.js';

export class UIManager {
  constructor() {
    this.canvas = document.getElementById('hudCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.resize();

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  drawHUD(gameState, mode) {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (gameState.status !== 'PLAYING') return;

    const W = this.canvas.width;
    const H = this.canvas.height;

    if (mode === 'sbs') {
      this.renderSingleEyeHUD(0, 0, W / 2, H, gameState);
      this.renderSingleEyeHUD(W / 2, 0, W / 2, H, gameState);
    } else {
      this.renderSingleEyeHUD(0, 0, W, H, gameState);
    }
  }

  renderSingleEyeHUD(x, y, w, h, state) {
    const ctx = this.ctx;
    const cx = x + w / 2;
    const cy = y + h / 2;

    // Reticle
    ctx.strokeStyle = state.gazeProgress > 0 ? '#00ffcc' : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.stroke();

    // Gaze progress fill arc
    if (state.gazeProgress > 0) {
      ctx.strokeStyle = '#00ffcc';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * state.gazeProgress);
      ctx.stroke();
    }

    // Oxygen Bar (Top Left)
    const barW = w * 0.25;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x + 20, 20, barW, 12);
    ctx.fillStyle = state.oxygen < 25 ? '#ff4444' : '#00ffcc';
    ctx.fillRect(x + 20, 20, barW * (state.oxygen / CONFIG.OXYGEN_MAX), 12);

    ctx.font = '12px Courier New';
    ctx.fillStyle = '#00ffcc';
    ctx.fillText(`OXYGEN: ${Math.ceil(state.oxygen)}%`, x + 20, 48);

    // Objective text (Bottom Center)
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffee00';
    ctx.fillText(`SPECIES: ${state.speciesDiscovered}/${CONFIG.TARGET_SPECIES_COUNT} | CLEANUP: ${state.pollutionCollected}/${CONFIG.TARGET_POLLUTION_COUNT}`, cx, y + h - 25);
  }

  updateMarineLog(discoveredSet) {
    const list = document.getElementById('logList');
    list.innerHTML = '';
    CONFIG.SPECIES.forEach((s) => {
      const isUnlocked = discoveredSet.has(s.id);
      const item = document.createElement('div');
      item.className = `log-item ${isUnlocked ? 'unlocked' : ''}`;
      item.innerHTML = `
        <h4>${isUnlocked ? s.name : '??? [LOCKED]'}</h4>
        <p>${isUnlocked ? s.desc : 'Explore and scan this creature underwater.'}</p>
      `;
      list.appendChild(item);
    });
  }
}