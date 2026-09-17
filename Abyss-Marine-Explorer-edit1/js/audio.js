/* =============================================================================
   ABYSS: Marine Explorer — Audio Engine Module (Web Audio API Synthesizer)
   =============================================================================
   * Procedural Sub-surface Oceanic Ambient Hum & Hydrophone Atmosphere
   * Tactical Sonar Pulse Ping Generator
   * Dynamic High-Frequency Scanning Telemetry Audio Feedback
   * Target Resolution & Debris Clean Chimes
   ============================================================================= */

window.ABYSS = window.ABYSS || {};

ABYSS.Audio = (function () {
  'use strict';

  var _audioCtx = null;
  var _isInitialized = false;

  var _ambientOsc = null;
  var _ambientGain = null;
  var _filterNode = null;

  function init() {
    if (_isInitialized) return;

    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      console.warn('ABYSS.Audio: Web Audio API is not supported in this browser environment.');
      return;
    }

    _audioCtx = new AudioContextClass();
    _isInitialized = true;
  }

  function startAmbient() {
    if (!_audioCtx) init();
    if (!_audioCtx) return;

    if (_audioCtx.state === 'suspended') {
      _audioCtx.resume();
    }

    if (_ambientOsc) return; // Ambient generator already running

    // Deep Submarine Drone Generator
    _ambientOsc = _audioCtx.createOscillator();
    _filterNode = _audioCtx.createBiquadFilter();
    _ambientGain = _audioCtx.createGain();

    _ambientOsc.type = 'sawtooth';
    _ambientOsc.frequency.setValueAtTime(42.0, _audioCtx.currentTime); // Low rumble (42 Hz)

    _filterNode.type = 'lowpass';
    _filterNode.frequency.setValueAtTime(110.0, _audioCtx.currentTime);

    _ambientGain.gain.setValueAtTime(0.18, _audioCtx.currentTime);

    _ambientOsc.connect(_filterNode);
    _filterNode.connect(_ambientGain);
    _ambientGain.connect(_audioCtx.destination);

    _ambientOsc.start();
  }

  function playSonarPing() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume();

    var now = _audioCtx.currentTime;
    var osc = _audioCtx.createOscillator();
    var gain = _audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1250.0, now);
    osc.frequency.exponentialRampToValueAtTime(380.0, now + 0.65);

    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

    osc.connect(gain);
    gain.connect(_audioCtx.destination);

    osc.start(now);
    osc.stop(now + 0.65);
  }

  function playScanBeep(progressRatio) {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume();

    var now = _audioCtx.currentTime;
    var osc = _audioCtx.createOscillator();
    var gain = _audioCtx.createGain();

    var pitch = 550.0 + (progressRatio || 0.0) * 850.0;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitch, now);

    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc.connect(gain);
    gain.connect(_audioCtx.destination);

    osc.start(now);
    osc.stop(now + 0.09);
  }

  function playSuccess() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume();

    var now = _audioCtx.currentTime;
    var osc = _audioCtx.createOscillator();
    var gain = _audioCtx.createGain();

    osc.type = 'triangle';

    // Arpeggiated target lock chime
    osc.frequency.setValueAtTime(523.25, now);        // C5
    osc.frequency.setValueAtTime(659.25, now + 0.08);  // E5
    osc.frequency.setValueAtTime(783.99, now + 0.16);  // G5
    osc.frequency.setValueAtTime(1046.50, now + 0.24); // C6

    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

    osc.connect(gain);
    gain.connect(_audioCtx.destination);

    osc.start(now);
    osc.stop(now + 0.6);
  }

  function playCleanEffect() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume();

    var now = _audioCtx.currentTime;
    var osc = _audioCtx.createOscillator();
    var gain = _audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(280.0, now);
    osc.frequency.linearRampToValueAtTime(880.0, now + 0.35);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc.connect(gain);
    gain.connect(_audioCtx.destination);

    osc.start(now);
    osc.stop(now + 0.35);
  }

  return {
    init: init,
    startAmbient: startAmbient,
    playSonarPing: playSonarPing,
    playScanBeep: playScanBeep,
    playSuccess: playSuccess,
    playCleanEffect: playCleanEffect
  };
})();