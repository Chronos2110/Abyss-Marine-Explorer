/* =============================================================================
   ABYSS: Marine Explorer — js/audio.js  v4
   Web Audio API synthesis engine.
   Exposes window.SoundSystem (legacy) AND window.ABYSS.Audio (namespace contract).
   All AudioContext creation is deferred to first user gesture.

   NAMESPACE HYGIENE:
   - This file is the SOLE OWNER of the synthesis engine.
   - window.ABYSS.Audio is defined HERE and consumed by main.js.
   - main.js never redefines window.ABYSS.Audio.

   MODULE 4 — Four required hooks:
     playPneumaticHiss()    — O2 refill terminal dwell completion
     playChime()            — specimen deposit + fauna scan alias
     playMechanicalRumble() — waste disposal hatch open/close
     playProximityAlert()   — shark within 12 units (4s throttle)
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

(function () {
  'use strict';

  var ctx          = null;
  var _humSource   = null;
  var _bubbleTimer = null;
  var _isDiving    = false;

  /* ─────────────────────────────────────────────────────────────────────────
     INIT — call inside a user-gesture handler (click / touch)
     iOS AudioContext policy: context must be created inside a gesture.
  ───────────────────────────────────────────────────────────────────────── */
  function init() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('[ABYSS Audio] AudioContext unavailable:', e);
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

      var src    = ctx.createBufferSource();
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
      console.warn('[ABYSS Audio] startOceanHum failed:', e);
    }
  }

  function stopOceanHum() {
    if (_humSource) {
      try { _humSource.stop(); } catch (e) {}
      _humSource = null;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BUBBLE CHIRP — bandpass noise burst on randomised interval
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
      var src    = ctx.createBufferSource();
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
    var delay = 3000 + Math.random() * 4000;
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
     Used: fauna scan initiation
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
      console.warn('[ABYSS Audio] playSonarPing:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SCAN CHIME — 880 Hz + 1108 Hz two-tone confirmation
     Used: fauna scan complete, pollution collection, conduit activation
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
      console.warn('[ABYSS Audio] playScanChime:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     HOOK 1: playPneumaticHiss()
     O2_REFILL terminal dwell completion — pressurised gas release sound.
     White-noise burst through 600–1200 Hz bandpass, 0.8 s envelope.
     Fast attack, gradual hiss tail → convincingly pneumatic.
  ───────────────────────────────────────────────────────────────────────── */
  function playPneumaticHiss() {
    if (!ctx) return;
    try {
      // White-noise buffer — 1 second
      var bufLen = ctx.sampleRate;
      var buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      var data   = buf.getChannelData(0);
      for (var i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

      var src    = ctx.createBufferSource();
      src.buffer = buf;
      src.loop   = false;

      // Bandpass around 900 Hz — hiss register
      var bp = ctx.createBiquadFilter();
      bp.type            = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value         = 1.4;

      // High-shelf boost adds air
      var hs = ctx.createBiquadFilter();
      hs.type            = 'highshelf';
      hs.frequency.value = 4000;
      hs.gain.value      = 8;

      // Amplitude envelope: rapid attack → sustained hiss → fade out
      var gain = ctx.createGain();
      var t0   = ctx.currentTime;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.55, t0 + 0.06);   // 60 ms attack
      gain.gain.setValueAtTime(0.55, t0 + 0.35);            // sustain
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.85); // hiss tail

      src.connect(bp);
      bp.connect(hs);
      hs.connect(gain);
      gain.connect(ctx.destination);
      src.start(t0);
      src.stop(t0 + 0.9);
    } catch (e) {
      console.warn('[ABYSS Audio] playPneumaticHiss:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     HOOK 2: playChime()
     SPECIMEN_DEPOSIT dwell completion — soft crystalline chime cluster.
     Three detuned sine tones (C5/E5/G5: 523/659/784 Hz) with short decay.
     Gentler and higher in register than playScanChime for clear differentiation.
  ───────────────────────────────────────────────────────────────────────── */
  function playChime() {
    if (!ctx) return;
    try {
      var freqs  = [523.25, 659.25, 783.99];  // C5, E5, G5 — major triad
      var master = ctx.createGain();
      master.gain.value = 0.28;
      master.connect(ctx.destination);

      freqs.forEach(function (freq, i) {
        var osc  = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        // Light triangle wave overtone for crystalline timbre
        var osc2  = ctx.createOscillator();
        osc2.type = 'triangle';
        osc2.frequency.value = freq * 2.002;   // slightly detuned upper harmonic

        var envGain = ctx.createGain();
        var t       = ctx.currentTime + i * 0.085;   // slight stagger per note
        envGain.gain.setValueAtTime(0, t);
        envGain.gain.linearRampToValueAtTime(0.55, t + 0.012);
        envGain.gain.exponentialRampToValueAtTime(0.001, t + 0.65);

        var env2Gain = ctx.createGain();
        env2Gain.gain.setValueAtTime(0, t);
        env2Gain.gain.linearRampToValueAtTime(0.18, t + 0.012);
        env2Gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);

        osc.connect(envGain);
        osc2.connect(env2Gain);
        envGain.connect(master);
        env2Gain.connect(master);

        osc.start(t);   osc.stop(t + 0.7);
        osc2.start(t);  osc2.stop(t + 0.5);
      });
    } catch (e) {
      console.warn('[ABYSS Audio] playChime:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     HOOK 3: playMechanicalRumble()
     WASTE_DISPOSAL hatch open/close — heavy industrial rumble.
     Low-frequency noise through 80 Hz lowpass + sawtooth 55 Hz fundamental.
     Two-layer: sub-bass texture + mid rattling grain. Duration ~0.9s.
  ───────────────────────────────────────────────────────────────────────── */
  function playMechanicalRumble() {
    if (!ctx) return;
    try {
      var t0 = ctx.currentTime;

      // Layer 1 — sub-bass noise (industrial machinery feel)
      var bufLen = Math.floor(ctx.sampleRate * 0.9);
      var buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      var data   = buf.getChannelData(0);
      for (var i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

      var noiseSrc    = ctx.createBufferSource();
      noiseSrc.buffer = buf;

      var lp1 = ctx.createBiquadFilter();
      lp1.type            = 'lowpass';
      lp1.frequency.value = 90;
      lp1.Q.value         = 1.2;

      var noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0,    t0);
      noiseGain.gain.linearRampToValueAtTime(0.65, t0 + 0.08);
      noiseGain.gain.setValueAtTime(0.65, t0 + 0.55);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.88);

      noiseSrc.connect(lp1);
      lp1.connect(noiseGain);
      noiseGain.connect(ctx.destination);
      noiseSrc.start(t0);
      noiseSrc.stop(t0 + 0.9);

      // Layer 2 — sawtooth 55 Hz fundamental (machinery hum)
      var osc  = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(55, t0);
      osc.frequency.exponentialRampToValueAtTime(42, t0 + 0.7);  // pitch sag on hatch

      var lp2 = ctx.createBiquadFilter();
      lp2.type            = 'lowpass';
      lp2.frequency.value = 200;

      var oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(0,    t0);
      oscGain.gain.linearRampToValueAtTime(0.38, t0 + 0.06);
      oscGain.gain.setValueAtTime(0.38, t0 + 0.50);
      oscGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.80);

      // Mid rattle — short burst noise around 300 Hz for metallic click
      var rattleBufLen = Math.floor(ctx.sampleRate * 0.045);
      var rattleBuf    = ctx.createBuffer(1, rattleBufLen, ctx.sampleRate);
      var rattleData   = rattleBuf.getChannelData(0);
      for (var ri = 0; ri < rattleBufLen; ri++) rattleData[ri] = Math.random() * 2 - 1;

      [0.0, 0.12, 0.28, 0.44].forEach(function (offset) {
        var rSrc    = ctx.createBufferSource();
        rSrc.buffer = rattleBuf;

        var rbp = ctx.createBiquadFilter();
        rbp.type            = 'bandpass';
        rbp.frequency.value = 280 + Math.random() * 120;
        rbp.Q.value         = 3.5;

        var rGain = ctx.createGain();
        rGain.gain.value = 0.22;

        rSrc.connect(rbp);
        rbp.connect(rGain);
        rGain.connect(ctx.destination);
        rSrc.start(t0 + offset);
        rSrc.stop(t0 + offset + 0.05);
      });

      osc.connect(lp2);
      lp2.connect(oscGain);
      oscGain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.82);
    } catch (e) {
      console.warn('[ABYSS Audio] playMechanicalRumble:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     HOOK 4: playProximityAlert()
     Shark within 12 units — throttled 4s in main.js.
     Two descending sawtooth pulses (120→80 Hz) with bandpass underwater shaping.
  ───────────────────────────────────────────────────────────────────────── */
  function playProximityAlert() {
    if (!ctx) return;
    try {
      [0.0, 0.28].forEach(function (offset) {
        var osc  = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(120, ctx.currentTime + offset);
        osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + offset + 0.22);

        var gain = ctx.createGain();
        gain.gain.setValueAtTime(0,    ctx.currentTime + offset);
        gain.gain.linearRampToValueAtTime(0.38, ctx.currentTime + offset + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.22);

        var bp = ctx.createBiquadFilter();
        bp.type            = 'bandpass';
        bp.frequency.value = 200;
        bp.Q.value         = 1.8;

        osc.connect(bp);
        bp.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.25);
      });
    } catch (e) {
      console.warn('[ABYSS Audio] playProximityAlert:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     AMBIENT WRAPPER — convenience for main.js startGame path
  ───────────────────────────────────────────────────────────────────────── */
  function playAmbient() {
    startOceanHum();
    startBubbleLoop();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     VICTORY CHORD — ascending arpeggio (C5 → C6)
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
      console.warn('[ABYSS Audio] playVictory:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
     Both window.SoundSystem (legacy backward compat) and
     window.ABYSS.Audio (namespace contract) point to the same object.
     main.js consumes ABYSS.Audio; it does NOT redefine it.
  ───────────────────────────────────────────────────────────────────────── */
  var publicAPI = {
    init:                 init,
    resume:               resume,
    startOceanHum:        startOceanHum,
    stopOceanHum:         stopOceanHum,
    startBubbleLoop:      startBubbleLoop,
    stopBubbleLoop:       stopBubbleLoop,
    playAmbient:          playAmbient,
    playSonarPing:        playSonarPing,
    playScanChime:        playScanChime,
    playVictory:          playVictory,
    // MODULE 4 — four required hooks
    playPneumaticHiss:    playPneumaticHiss,
    playChime:            playChime,
    playMechanicalRumble: playMechanicalRumble,
    playProximityAlert:   playProximityAlert,
    // Legacy aliases consumed by old call sites
    playSharkAlert:       playProximityAlert,
    playSpecimenChime:    playChime
  };

  window.SoundSystem = publicAPI;
  window.ABYSS.Audio = publicAPI;

}());
