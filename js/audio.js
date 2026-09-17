/* =============================================================================
   ABYSS: Marine Explorer — js/audio.js
   Web Audio API synthesizer. Exposes window.SoundSystem.
   All AudioContext creation is deferred to first user gesture.
   ============================================================================= */

(function () {
  'use strict';

  var ctx = null;
  var _humSource = null;
  var _bubbleTimer = null;
  var _isDiving = false;

  /* ─────────────────────────────────────────────────────────────────────────
     INIT — call inside a user-gesture handler (click / touch)
     ───────────────────────────────────────────────────────────────────────── */
  function init() {
    if (ctx) return; // already initialised
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('[SoundSystem] AudioContext unavailable:', e);
    }
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(function () {});
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     OCEAN HUM — looped white-noise through 180 Hz lowpass
     ───────────────────────────────────────────────────────────────────────── */
  function startOceanHum() {
    if (!ctx || _humSource) return;
    try {
      var bufLen = ctx.sampleRate * 2;
      var buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      var data   = buf.getChannelData(0);
      for (var i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

      var src  = ctx.createBufferSource();
      src.buffer = buf;
      src.loop   = true;

      var lp = ctx.createBiquadFilter();
      lp.type            = 'lowpass';
      lp.frequency.value = 180;
      lp.Q.value         = 0.7;

      var gain = ctx.createGain();
      gain.gain.value = 0.11;

      src.connect(lp);
      lp.connect(gain);
      gain.connect(ctx.destination);
      src.start();
      _humSource = src;
    } catch (e) {
      console.warn('[SoundSystem] startOceanHum failed:', e);
    }
  }

  function stopOceanHum() {
    if (_humSource) {
      try { _humSource.stop(); } catch (e) {}
      _humSource = null;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BUBBLE CHIRP — bandpass noise burst
     ───────────────────────────────────────────────────────────────────────── */
  function _playBubbleChirp() {
    if (!ctx) return;
    try {
      var bufLen = Math.floor(ctx.sampleRate * 0.085);
      var buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      var data   = buf.getChannelData(0);
      for (var i = 0; i < bufLen; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / bufLen);
      }
      var src = ctx.createBufferSource();
      src.buffer = buf;

      var bp = ctx.createBiquadFilter();
      bp.type            = 'bandpass';
      bp.frequency.value = 750 + Math.random() * 200;
      bp.Q.value         = 2.5;

      var gain = ctx.createGain();
      gain.gain.value = 0.22;

      src.connect(bp);
      bp.connect(gain);
      gain.connect(ctx.destination);
      src.start();
    } catch (e) {}
  }

  function _scheduleBubble() {
    var delay = 3000 + Math.random() * 4000; // 3–7 s
    _bubbleTimer = setTimeout(function () {
      if (_isDiving) _playBubbleChirp();
      _scheduleBubble();
    }, delay);
  }

  function startBubbleLoop() {
    _isDiving = true;
    if (_bubbleTimer) clearTimeout(_bubbleTimer);
    _scheduleBubble();
  }

  function stopBubbleLoop() {
    _isDiving = false;
    if (_bubbleTimer) {
      clearTimeout(_bubbleTimer);
      _bubbleTimer = null;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SONAR PING — 840 Hz → 320 Hz exponential sweep
     ───────────────────────────────────────────────────────────────────────── */
  function playSonarPing() {
    if (!ctx) return;
    try {
      var osc  = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(840, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(320, ctx.currentTime + 0.75);

      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.28, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.75);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.75);
    } catch (e) {
      console.warn('[SoundSystem] playSonarPing:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SCAN CHIME — 880 Hz + 1108 Hz two-tone confirmation
     ───────────────────────────────────────────────────────────────────────── */
  function playScanChime() {
    if (!ctx) return;
    try {
      [880, 1108].forEach(function (freq, i) {
        var osc  = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        var gain = ctx.createGain();
        var t    = ctx.currentTime + i * 0.28;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.28, t + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.26);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.28);
      });
    } catch (e) {
      console.warn('[SoundSystem] playScanChime:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     VICTORY CHORD — ascending arpeggio
     ───────────────────────────────────────────────────────────────────────── */
  function playVictory() {
    if (!ctx) return;
    try {
      [523, 659, 784, 1047, 1318].forEach(function (freq, i) {
        var osc  = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        var gain = ctx.createGain();
        var t    = ctx.currentTime + i * 0.22;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.32, t + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.20);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.22);
      });
    } catch (e) {
      console.warn('[SoundSystem] playVictory:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
     ───────────────────────────────────────────────────────────────────────── */
  window.SoundSystem = {
    init:             init,
    resume:           resume,
    startOceanHum:    startOceanHum,
    stopOceanHum:     stopOceanHum,
    startBubbleLoop:  startBubbleLoop,
    stopBubbleLoop:   stopBubbleLoop,
    playSonarPing:    playSonarPing,
    playScanChime:    playScanChime,
    playVictory:      playVictory
  };

}());
