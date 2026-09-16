// =============================================================================
// ABYSS: Marine Explorer — audio.js
// All synthesized sounds. Exposed on window.ABYSS.Audio.
// AudioContext must be created (or resumed) inside a user-gesture handler.
// =============================================================================

window.ABYSS = window.ABYSS || {};

window.ABYSS.Audio = (function () {
  'use strict';

  var _ctx = null;
  var _bubbleTimeout = null;
  var _humNode = null;

  // ---------------------------------------------------------------------------
  // init — store AudioContext reference
  // ---------------------------------------------------------------------------
  function init(audioContext) {
    _ctx = audioContext;
  }

  // ---------------------------------------------------------------------------
  // playOceanHum — filtered white-noise loop, call once on dive start
  // ---------------------------------------------------------------------------
  function playOceanHum() {
    if (!_ctx) return;
    if (_humNode) return; // already playing
    try {
      var bufSize = _ctx.sampleRate * 2;
      var buf = _ctx.createBuffer(1, bufSize, _ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

      var src = _ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;

      var filt = _ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 200;

      var gain = _ctx.createGain();
      gain.gain.value = 0.12;

      src.connect(filt);
      filt.connect(gain);
      gain.connect(_ctx.destination);
      src.start();
      _humNode = src;
    } catch (e) {
      console.warn('[ABYSS.Audio] playOceanHum failed:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // playBubbleChirp — single burst bandpass noise
  // ---------------------------------------------------------------------------
  function playBubbleChirp() {
    if (!_ctx) return;
    try {
      var bufSize = Math.floor(_ctx.sampleRate * 0.1);
      var buf = _ctx.createBuffer(1, bufSize, _ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < bufSize; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
      }

      var src = _ctx.createBufferSource();
      src.buffer = buf;

      var filt = _ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = 800;
      filt.Q.value = 2;

      var gain = _ctx.createGain();
      gain.gain.value = 0.25;

      src.connect(filt);
      filt.connect(gain);
      gain.connect(_ctx.destination);
      src.start();
    } catch (e) {
      console.warn('[ABYSS.Audio] playBubbleChirp failed:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // _scheduleBubble — internal recurring bubble scheduler
  // ---------------------------------------------------------------------------
  function _scheduleBubble(getGameStateFn) {
    var delay = 4000 + Math.random() * 5000;
    _bubbleTimeout = setTimeout(function () {
      if (typeof getGameStateFn === 'function' && getGameStateFn()) {
        playBubbleChirp();
      }
      _scheduleBubble(getGameStateFn);
    }, delay);
  }

  function startBubbleLoop(getGameStateFn) {
    if (_bubbleTimeout) clearTimeout(_bubbleTimeout);
    _scheduleBubble(getGameStateFn);
  }

  function stopBubbleLoop() {
    if (_bubbleTimeout) {
      clearTimeout(_bubbleTimeout);
      _bubbleTimeout = null;
    }
  }

  // ---------------------------------------------------------------------------
  // playSonarPing — freq ramp 800 → 300 Hz
  // ---------------------------------------------------------------------------
  function playSonarPing() {
    if (!_ctx) return;
    try {
      var osc = _ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, _ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, _ctx.currentTime + 0.8);

      var gain = _ctx.createGain();
      gain.gain.setValueAtTime(0.3, _ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, _ctx.currentTime + 0.8);

      osc.connect(gain);
      gain.connect(_ctx.destination);
      osc.start();
      osc.stop(_ctx.currentTime + 0.8);
    } catch (e) {
      console.warn('[ABYSS.Audio] playSonarPing failed:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // playScanChime — two-tone confirmation (880 Hz, 1108 Hz)
  // ---------------------------------------------------------------------------
  function playScanChime() {
    if (!_ctx) return;
    try {
      [880, 1108].forEach(function (freq, i) {
        var osc = _ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        var gain = _ctx.createGain();
        var t = _ctx.currentTime + i * 0.3;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.3, t + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);

        osc.connect(gain);
        gain.connect(_ctx.destination);
        osc.start(t);
        osc.stop(t + 0.3);
      });
    } catch (e) {
      console.warn('[ABYSS.Audio] playScanChime failed:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // playMissionSuccess — ascending arpeggio (523, 659, 784, 1047 Hz)
  // ---------------------------------------------------------------------------
  function playMissionSuccess() {
    if (!_ctx) return;
    try {
      [523, 659, 784, 1047].forEach(function (freq, i) {
        var osc = _ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        var gain = _ctx.createGain();
        var t = _ctx.currentTime + i * 0.25;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.35, t + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.23);

        osc.connect(gain);
        gain.connect(_ctx.destination);
        osc.start(t);
        osc.stop(t + 0.25);
      });
    } catch (e) {
      console.warn('[ABYSS.Audio] playMissionSuccess failed:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  return {
    init: init,
    playOceanHum: playOceanHum,
    playBubbleChirp: playBubbleChirp,
    startBubbleLoop: startBubbleLoop,
    stopBubbleLoop: stopBubbleLoop,
    playSonarPing: playSonarPing,
    playScanChime: playScanChime,
    playMissionSuccess: playMissionSuccess
  };

}());
