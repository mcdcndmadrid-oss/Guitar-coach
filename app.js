'use strict';

const NOTE_NAMES = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
const BUILT_IN_PIECES = {
  'una-cuerda': './pieces/una-cuerda.json',
  estrellita: './pieces/estrellita.json',
  'oda-a-la-alegria-guitarra': './pieces/oda-a-la-alegria-guitarra.json'
};

const AUDIO_CONFIG = { FFT_SIZE: 4096, SMOOTHING_TIME_CONSTANT: 0, ANALYSIS_INTERVAL_MS: 70, DRAW_INTERVAL_MS: 16 };

const PITCH_CONFIG = {
  MIN_FREQUENCY_HZ: 27,
  MAX_FREQUENCY_HZ: 4300,
  YIN_THRESHOLD: 0.13,
  YIN_WINDOW_CAP: 2048,
  YIN_MIN_COMPARISON_LENGTH: 256,
  MIDI_MIN: 21,
  MIDI_MAX: 108
};

// Calibración de octava: tres cuerdas al aire (sin ambigüedad de traste), que
// abarcan un registro similar a Do4/Mi4/Sol4 en Piano Coach.
const CALIBRATION_STEPS = [
  { midi: 40, string: 6, fret: 0, label: 'Mi grave (6ª al aire)', instruction: 'Toca la 6ª cuerda (la más gruesa) al aire y mantenla sonando.' },
  { midi: 55, string: 3, fret: 0, label: 'Sol (3ª al aire)', instruction: 'Toca la 3ª cuerda al aire y mantenla sonando.' },
  { midi: 64, string: 1, fret: 0, label: 'Mi agudo (1ª al aire)', instruction: 'Toca la 1ª cuerda (la más fina) al aire y mantenla sonando.' }
];

const ONSET_CONFIG = {
  RMS_SILENCE_ENTER: 0.009,
  RMS_SILENCE_HOLD_MS: 130,
  RMS_SUSTAIN_GATE: 0.012,
  RMS_ONSET_DELTA: 0.02,
  RMS_SMOOTHING_ALPHA: 0.35,
  ONSET_ACTIVE_WINDOW_MS: 150,
  STABLE_FRAMES_REQUIRED: 3,
  STABLE_FRAMES_REQUIRED_ON_ONSET: 1,
  CONFIDENCE_ACCEPT_THRESHOLD: 0.72,
  ACCEPT_DEBOUNCE_MS: 180
};

const state = {
  piece: null,
  selectedPieceId: 'una-cuerda',
  showNoteNames: true,
  scoreCanvasScale: window.devicePixelRatio || 1,
  lastPixelsPerBeat: 60,

  // Transporte / sesión. sessionKind: null | 'preview' | 'practice'.
  sessionKind: null,
  mode: 'continuous',
  playing: false,
  continuousStarted: false,
  currentSeconds: 0,
  currentIndex: 0,
  lastFrameAt: 0,
  lastDrawAt: 0,
  lastAnalysisAt: 0,
  animationFrame: null,
  previewPlayedIndexes: new Set(),
  noteResults: [],
  wrongAttempts: 0,

  // Arrastre de la partitura.
  isDraggingScore: false,
  dragStartClientX: 0,
  dragStartBeat: 0,

  // Micrófono / detección de tono.
  micReady: false,
  stream: null,
  analyser: null,
  source: null,
  audioBuffer: null,
  audioContext: null,
  activeSynthNodes: new Set(),
  pitchOffset: 0,
  rawDetectedMidi: null,
  detectedMidi: null,
  detectedFrequency: null,
  detectedConfidence: 0,
  stableMidi: null,
  stableCount: 0,
  smoothedRms: 0,
  previousSmoothedRms: 0,
  onsetActive: false,
  onsetDetectedAt: 0,
  belowSilenceEnterSince: null,
  lastAcceptedAt: 0,
  calibration: { active: false, step: 0, readings: [], awaitingRelease: false, completed: false }
};

const els = {};

window.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheElements();
  bindEvents();
  await loadBuiltInPiece(state.selectedPieceId);
  renderFretboard();
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }
}

function cacheElements() {
  [
    'pieceTitle', 'pieceMeta', 'pieceSelect', 'modeSelect', 'playButton', 'previewButton',
    'transportStatus', 'micButton', 'micHelp', 'micHelpTitle', 'micHelpText', 'retryMicButton',
    'scoreCanvas', 'fretboard', 'microphoneHint',
    'expectedNote', 'detectedNote', 'frequencyValue', 'confidenceValue', 'correctValue', 'errorValue',
    'calibrateButton', 'calibrationPanel', 'calibrationTitle', 'calibrationText',
    'calibrationStatus', 'calibrationProgressBar', 'cancelCalibrationButton', 'resetCalibrationButton',
    'pieceFileInput'
  ].forEach((id) => { els[id] = document.getElementById(id); });
}

function bindEvents() {
  els.pieceSelect.addEventListener('change', async () => {
    stopSession();
    await loadBuiltInPiece(els.pieceSelect.value);
  });
  els.modeSelect.addEventListener('change', () => {
    state.mode = els.modeSelect.value;
    resetSession();
  });
  els.previewButton.addEventListener('click', () => {
    if (state.sessionKind === 'preview') stopSession();
    else startPreview();
  });
  els.playButton.addEventListener('click', () => {
    if (state.sessionKind === 'practice') stopSession();
    else startPractice();
  });
  els.micButton.addEventListener('click', toggleMicrophone);
  els.retryMicButton.addEventListener('click', enableMicrophone);
  els.calibrateButton.addEventListener('click', startCalibration);
  els.cancelCalibrationButton.addEventListener('click', cancelCalibration);
  els.resetCalibrationButton.addEventListener('click', resetCalibration);
  els.pieceFileInput.addEventListener('change', importPieceFile);
  bindScoreDragEvents();
}

async function loadBuiltInPiece(id) {
  const path = BUILT_IN_PIECES[id] || BUILT_IN_PIECES['una-cuerda'];
  state.selectedPieceId = BUILT_IN_PIECES[id] ? id : 'una-cuerda';
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error('No se pudo cargar la pieza');
  const data = await response.json();
  els.pieceSelect.value = state.selectedPieceId;
  setPiece(validatePiece(data));
}

function setPiece(piece) {
  state.piece = piece;
  els.pieceTitle.textContent = piece.title;
  els.pieceMeta.textContent = `${piece.composer} · ${piece.description}`;
  resetSession();
}

// Registra una pieza importada (MIDI o JSON) como opción "custom" del selector,
// igual que hace Piano Coach.
function setCustomPiece(piece) {
  state.selectedPieceId = 'custom';
  const customOption = Array.from(els.pieceSelect.options).find((option) => option.value === 'custom') || document.createElement('option');
  customOption.value = 'custom';
  customOption.textContent = piece.title;
  if (!customOption.parentElement) els.pieceSelect.appendChild(customOption);
  els.pieceSelect.value = 'custom';
  setPiece(piece);
}

async function importPieceFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const extension = file.name.split('.').pop()?.toLowerCase();
    let piece;
    let statusMessage;

    if (extension === 'mid' || extension === 'midi') {
      if (!window.MidiImporter?.convert) throw new Error('El conversor MIDI no está disponible. Recarga la aplicación.');
      const result = window.MidiImporter.convert(await file.arrayBuffer(), file.name);
      piece = validatePiece(result.piece);
      statusMessage = `MIDI convertido: ${piece.title} · ${piece.allNotes.length} notas · ${result.details.selectedTrack}`;
    } else if (extension === 'musicxml' || extension === 'xml' || extension === 'mxl') {
      if (!window.MusicXmlImporter?.convert) throw new Error('El conversor MusicXML no está disponible. Recarga la aplicación.');
      const result = await window.MusicXmlImporter.convert(await file.arrayBuffer(), file.name);
      piece = validatePiece(result.piece);
      statusMessage = `MusicXML importado: ${piece.title} · ${piece.allNotes.length} notas · ${result.details.staffCount} pentagrama(s)`;
    } else {
      piece = validatePiece(JSON.parse(await file.text()));
      statusMessage = `Pieza cargada: ${piece.title}`;
    }

    setCustomPiece(piece);
    updateStatus(statusMessage);
  } catch (error) {
    updateStatus(error instanceof Error ? error.message : 'No se pudo leer la pieza.');
  } finally {
    event.target.value = '';
  }
}

// --- Modelo de pieza -------------------------------------------------------
// Misma estructura staves[].voices[].notes[] que Piano Coach (permite reutilizar
// finalizePiece/practiceNotes/allNotes sin cambios), pero cada nota lleva además
// string (1-6) y fret (0-24). La comparación de acierto sigue siendo por midi,
// igual que en el piano — string/fret son solo para dibujar.

function validatePiece(input) {
  if (!input || typeof input !== 'object') throw new Error('El archivo no contiene un objeto JSON válido.');
  return Array.isArray(input.staves) ? validateStructuredPiece(input) : validateFlatPiece(input);
}

function validateFlatPiece(input) {
  if (!Array.isArray(input.notes) || input.notes.length === 0) throw new Error('La pieza debe contener al menos una nota.');

  const notes = [];
  let previousFingering = null;
  input.notes.forEach((note, index) => {
    const midi = Number(note.midi);
    const startBeat = Number(note.startBeat);
    const durationBeats = Number(note.durationBeats ?? 1);
    const label = `Nota ${index + 1}`;
    if (!Number.isFinite(midi) || midi < 21 || midi > 108) throw new Error(`${label}: midi debe estar entre 21 y 108.`);
    if (!Number.isFinite(startBeat) || startBeat < 0) throw new Error(`${label}: startBeat no es válido.`);
    if (!Number.isFinite(durationBeats) || durationBeats <= 0) throw new Error(`${label}: durationBeats no es válido.`);
    const fallback = durationToNoteType(durationBeats);
    const fingering = resolveFingering(note, Math.round(midi), previousFingering, label);
    previousFingering = fingering;
    notes.push({
      midi: Math.round(midi),
      startBeat,
      durationBeats,
      noteType: fallback.noteType,
      dots: fallback.dots,
      tied: null,
      articulations: [],
      chordWith: null,
      staff: 0,
      voice: 0,
      string: fingering.string,
      fret: fingering.fret
    });
  });
  notes.sort((a, b) => a.startBeat - b.startBeat);

  return finalizePiece({
    title: String(input.title || 'Pieza sin título'),
    composer: String(input.composer || 'Autor desconocido'),
    tempo: clamp(Number(input.tempo) || 80, 40, 180),
    timeSignature: String(input.timeSignature || '4/4'),
    description: String(input.description || 'Pieza importada'),
    keySignature: { fifths: 0, mode: 'major' },
    staves: [{ clef: 'treble', voices: [{ id: 0, notes }] }],
    dynamics: []
  });
}

function validateStructuredPiece(input) {
  if (!Array.isArray(input.staves) || input.staves.length === 0) throw new Error('La pieza debe contener al menos un pentagrama.');

  const staves = input.staves.map((staffInput, staffIndex) => {
    const voicesInput = Array.isArray(staffInput.voices) ? staffInput.voices : [];
    const voices = voicesInput.map((voiceInput, voiceIndex) => {
      const notesInput = Array.isArray(voiceInput.notes) ? voiceInput.notes : [];
      const notes = [];
      let previousFingering = null;
      notesInput.forEach((note, index) => {
        const midi = Number(note.midi);
        const startBeat = Number(note.startBeat);
        const durationBeats = Number(note.durationBeats ?? 1);
        const label = `Pentagrama ${staffIndex + 1}, voz ${voiceIndex + 1}, nota ${index + 1}`;
        if (!Number.isFinite(midi) || midi < 21 || midi > 108) throw new Error(`${label}: midi debe estar entre 21 y 108.`);
        if (!Number.isFinite(startBeat) || startBeat < 0) throw new Error(`${label}: startBeat no es válido.`);
        if (!Number.isFinite(durationBeats) || durationBeats <= 0) throw new Error(`${label}: durationBeats no es válido.`);
        const fallback = durationToNoteType(durationBeats);
        const fingering = resolveFingering(note, Math.round(midi), previousFingering, label);
        previousFingering = fingering;
        notes.push({
          midi: Math.round(midi),
          startBeat,
          durationBeats,
          noteType: note.noteType || fallback.noteType,
          dots: Number.isInteger(note.dots) ? note.dots : fallback.dots,
          tied: note.tied || null,
          articulations: Array.isArray(note.articulations) ? note.articulations : [],
          chordWith: Number.isInteger(note.chordWith) ? note.chordWith : null,
          staff: staffIndex,
          voice: voiceIndex,
          string: fingering.string,
          fret: fingering.fret
        });
      });
      notes.sort((a, b) => a.startBeat - b.startBeat);
      return { id: Number.isInteger(voiceInput.id) ? voiceInput.id : voiceIndex, notes };
    });
    return { clef: 'treble', voices };
  });

  return finalizePiece({
    title: String(input.title || 'Pieza sin título'),
    composer: String(input.composer || 'Autor desconocido'),
    tempo: clamp(Number(input.tempo) || 80, 40, 180),
    timeSignature: String(input.timeSignature || '4/4'),
    description: String(input.description || 'Pieza importada'),
    keySignature: { fifths: 0, mode: 'major' },
    staves,
    dynamics: []
  });
}

// Si la nota trae string/fret explícitos, valida que coincidan con el midi dado
// (error claro si no, probablemente una errata de autoría). Si no vienen,
// asigna una digitación automática con la heurística de fretboard-tuning.js.
function resolveFingering(note, midi, previousFingering, label) {
  const hasString = Number.isInteger(note.string);
  const hasFret = Number.isInteger(note.fret);

  if (hasString && hasFret) {
    if (note.string < 1 || note.string > 6) throw new Error(`${label}: string debe estar entre 1 y 6.`);
    if (note.fret < 0 || note.fret > window.FretboardTuning.MAX_FRET) throw new Error(`${label}: fret debe estar entre 0 y ${window.FretboardTuning.MAX_FRET}.`);
    const expectedMidi = window.FretboardTuning.midiForStringFret(note.string, note.fret);
    if (expectedMidi !== midi) {
      throw new Error(`${label}: cuerda ${note.string} traste ${note.fret} suena a midi ${expectedMidi}, no ${midi}.`);
    }
    return { string: note.string, fret: note.fret };
  }

  return window.FretboardTuning.assignFingering(midi, previousFingering);
}

function finalizePiece(piece) {
  const allNotes = [];
  piece.staves.forEach((staff) => {
    staff.voices.forEach((voice) => {
      voice.notes.forEach((note) => allNotes.push(note));
    });
  });
  if (allNotes.length === 0) throw new Error('La pieza debe contener al menos una nota.');
  allNotes.sort((a, b) => a.startBeat - b.startBeat);

  const practiceVoice = piece.staves[0]?.voices[0];
  const practiceNotes = practiceVoice ? practiceVoice.notes.slice().sort((a, b) => a.startBeat - b.startBeat) : [];
  practiceNotes.forEach((note, index) => { note.practiceIndex = index; });

  return { ...piece, allNotes, practiceNotes };
}

function durationToNoteType(durationBeats) {
  const d = Number(durationBeats) || 1;
  const close = (a, b) => Math.abs(a - b) < 0.01;
  if (d >= 4 || close(d, 4)) return { noteType: 'whole', dots: 0 };
  if (close(d, 3)) return { noteType: 'half', dots: 1 };
  if (close(d, 2)) return { noteType: 'half', dots: 0 };
  if (close(d, 1.5)) return { noteType: 'quarter', dots: 1 };
  if (close(d, 1)) return { noteType: 'quarter', dots: 0 };
  if (close(d, 0.75)) return { noteType: 'eighth', dots: 1 };
  if (close(d, 0.5)) return { noteType: 'eighth', dots: 0 };
  if (close(d, 0.375)) return { noteType: '16th', dots: 1 };
  if (close(d, 0.25)) return { noteType: '16th', dots: 0 };
  if (d > 2) return { noteType: 'half', dots: 0 };
  return { noteType: d < 0.5 ? 'eighth' : 'quarter', dots: 0 };
}

// --- Micrófono ---------------------------------------------------------------

async function toggleMicrophone() {
  if (state.micReady) {
    disableMicrophone();
    return;
  }
  await enableMicrophone();
}

async function enableMicrophone() {
  hideMicHelp();

  if (!window.isSecureContext) {
    showMicHelp(
      'Chrome exige una conexión segura',
      'Abre la app desde una dirección HTTPS. En un ordenador también funciona en http://localhost.'
    );
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showMicHelp('El navegador no ofrece acceso al micrófono', 'Actualiza Chrome o prueba la app instalada como PWA desde una dirección HTTPS.');
    return;
  }

  try {
    if (navigator.permissions?.query) {
      try {
        const permission = await navigator.permissions.query({ name: 'microphone' });
        if (permission.state === 'denied') {
          showMicHelp('El permiso del micrófono está bloqueado', 'Toca el icono de ajustes junto a la dirección → Permisos → Micrófono → Permitir.');
          return;
        }
      } catch (_) {
        // Algunos navegadores no admiten consultar este permiso; getUserMedia mostrará el diálogo.
      }
    }

    const preferredConstraints = {
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 }, sampleRate: { ideal: 44100 } }
    };
    try {
      state.stream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
    } catch (firstError) {
      if (firstError?.name === 'OverconstrainedError' || firstError?.name === 'ConstraintNotSatisfiedError') {
        state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        throw firstError;
      }
    }

    const audioContext = await getAudioContext();
    state.analyser = audioContext.createAnalyser();
    state.analyser.fftSize = AUDIO_CONFIG.FFT_SIZE;
    state.analyser.smoothingTimeConstant = AUDIO_CONFIG.SMOOTHING_TIME_CONSTANT;
    state.audioBuffer = new Float32Array(state.analyser.fftSize);
    state.source = audioContext.createMediaStreamSource(state.stream);
    state.source.connect(state.analyser);
    state.micReady = true;
    els.micButton.textContent = 'Desactivar micrófono';
    els.micButton.classList.add('is-active');
    els.microphoneHint.textContent = 'Micrófono activo. Toca una nota clara y sostenida.';
    hideMicHelp();
    startLoop();
  } catch (error) {
    handleMicrophoneError(error);
  }
}

function handleMicrophoneError(error) {
  const name = error?.name || 'Error';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    showMicHelp('Chrome no tiene permiso para usar el micrófono', 'Toca el icono de ajustes junto a la dirección → Permisos → Micrófono → Permitir y recarga la app.');
  } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    showMicHelp('No se encontró ningún micrófono', 'Comprueba que el dispositivo dispone de micrófono y que no está deshabilitado por el sistema.');
  } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    showMicHelp('El micrófono está ocupado o bloqueado', 'Cierra llamadas, grabadoras y otras aplicaciones que puedan estar usando el micrófono.');
  } else {
    showMicHelp('No se pudo activar el micrófono', `Chrome devolvió ${name}. Comprueba HTTPS y los permisos, y pulsa Reintentar.`);
  }
}

function disableMicrophone() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.source?.disconnect();
  state.stream = null;
  state.source = null;
  state.analyser = null;
  state.audioBuffer = null;
  state.micReady = false;
  state.detectedMidi = null;
  state.rawDetectedMidi = null;
  state.detectedFrequency = null;
  state.detectedConfidence = 0;
  if (state.calibration.active) cancelCalibration();
  els.micButton.textContent = 'Activar micrófono';
  els.micButton.classList.remove('is-active');
  els.microphoneHint.textContent = 'Activa el micrófono para validar notas.';
  updateDynamicUI();
}

function showMicHelp(title, text) {
  els.micHelpTitle.textContent = title;
  els.micHelpText.textContent = text;
  els.micHelp.hidden = false;
}

function hideMicHelp() {
  els.micHelp.hidden = true;
}

// --- Calibración de octava ----------------------------------------------------
// Tres cuerdas al aire (sin ambigüedad de traste). Mismo algoritmo que Piano
// Coach: mediana de los 3 desfases + comprobación de consistencia.

async function startCalibration() {
  if (state.sessionKind) stopSession();
  if (!state.micReady) {
    await enableMicrophone();
    if (!state.micReady) return;
  }

  state.calibration.active = true;
  state.calibration.step = 0;
  state.calibration.readings = [];
  state.calibration.awaitingRelease = false;
  state.calibration.completed = false;
  state.rawDetectedMidi = null;
  state.detectedMidi = null;
  state.stableMidi = null;
  state.stableCount = 0;
  state.onsetActive = false;
  state.belowSilenceEnterSince = null;
  state.lastAcceptedAt = 0;
  els.calibrationPanel.hidden = false;
  els.calibrateButton.disabled = true;
  updateCalibrationUI();
  updateFretboardHighlights();
  updateStatus('Calibración iniciada. Toca las cuerdas marcadas en orden.');
  startLoop();
}

function cancelCalibration() {
  const wasActive = state.calibration.active;
  state.calibration.active = false;
  state.calibration.awaitingRelease = false;
  state.calibration.step = 0;
  state.calibration.readings = [];
  state.stableMidi = null;
  state.stableCount = 0;
  state.onsetActive = false;
  state.belowSilenceEnterSince = null;
  els.calibrationPanel.hidden = true;
  els.calibrateButton.disabled = false;
  updateCalibrationButton();
  updateFretboardHighlights();
  if (wasActive) updateStatus('Calibración cancelada.');
}

function resetCalibration() {
  state.pitchOffset = 0;
  state.calibration.active = false;
  state.calibration.awaitingRelease = false;
  state.calibration.completed = false;
  state.calibration.step = 0;
  state.calibration.readings = [];
  els.calibrationPanel.hidden = true;
  els.calibrateButton.disabled = false;
  updateCalibrationButton();
  updateFretboardHighlights();
  updateDynamicUI();
  updateStatus('Calibración restablecida. Se usa la afinación detectada sin desplazamiento.');
}

function captureCalibrationNote(rawMidi, timestamp) {
  if (!state.calibration.active || state.calibration.awaitingRelease) return;
  const target = CALIBRATION_STEPS[state.calibration.step];
  if (!target) return;

  state.calibration.readings.push({ targetMidi: target.midi, detectedMidi: rawMidi });
  state.calibration.step += 1;
  state.calibration.awaitingRelease = true;
  state.lastAcceptedAt = timestamp;
  state.stableMidi = null;
  state.stableCount = 0;
  flashFret(target.string, target.fret, 'detected');

  if (state.calibration.step >= CALIBRATION_STEPS.length) finishCalibration();
  else updateCalibrationUI();
}

function finishCalibration() {
  const deltas = state.calibration.readings
    .map((reading) => reading.targetMidi - reading.detectedMidi)
    .sort((a, b) => a - b);
  const middle = Math.floor(deltas.length / 2);
  const medianDelta = deltas.length % 2 ? deltas[middle] : (deltas[middle - 1] + deltas[middle]) / 2;
  const proposedOffset = clamp(Math.round(medianDelta), -24, 24);
  const largestResidual = Math.max(...deltas.map((delta) => Math.abs(delta - proposedOffset)));

  if (largestResidual > 1) {
    state.calibration.step = 0;
    state.calibration.readings = [];
    state.calibration.awaitingRelease = true;
    state.calibration.completed = false;
    updateCalibrationUI();
    updateFretboardHighlights();
    updateStatus('Las lecturas no fueron consistentes. Suelta la cuerda y repite las tres notas.');
    return;
  }

  state.pitchOffset = proposedOffset;
  state.calibration.active = false;
  state.calibration.awaitingRelease = false;
  state.calibration.completed = true;
  els.calibrateButton.disabled = false;
  updateCalibrationButton();
  updateCalibrationUI();
  updateFretboardHighlights();
  updateDynamicUI();
  updateStatus(`Calibración guardada: ${formatPitchOffset(state.pitchOffset)}.`);
}

function updateCalibrationUI() {
  if (!els.calibrationPanel) return;

  if (state.calibration.completed && !state.calibration.active) {
    els.calibrationTitle.textContent = 'Calibración completada';
    els.calibrationText.textContent = `La app aplicará ${formatPitchOffset(state.pitchOffset)} a las notas detectadas.`;
    els.calibrationStatus.textContent = `Ajuste actual: ${formatPitchOffset(state.pitchOffset)}`;
    els.calibrationProgressBar.style.width = '100%';
    els.cancelCalibrationButton.textContent = 'Cerrar';
    els.resetCalibrationButton.disabled = false;
    return;
  }

  const step = CALIBRATION_STEPS[state.calibration.step] || CALIBRATION_STEPS[0];
  const completedSteps = state.calibration.readings.length;
  els.calibrationTitle.textContent = `Paso ${Math.min(state.calibration.step + 1, CALIBRATION_STEPS.length)} de ${CALIBRATION_STEPS.length} · ${step.label}`;
  els.calibrationText.textContent = state.calibration.awaitingRelease
    ? `Suelta la cuerda. Después: ${step.instruction}`
    : step.instruction;
  els.calibrationStatus.textContent = state.rawDetectedMidi === null
    ? 'Esperando una nota estable…'
    : `Lectura del micrófono: ${midiToNoteName(state.rawDetectedMidi)}`;
  els.calibrationProgressBar.style.width = `${completedSteps / CALIBRATION_STEPS.length * 100}%`;
  els.cancelCalibrationButton.textContent = 'Cancelar';
  els.resetCalibrationButton.disabled = true;
}

function updateCalibrationButton() {
  if (!els.calibrateButton) return;
  els.calibrateButton.textContent = state.pitchOffset === 0
    ? '🎸 Calibrar'
    : `🎸 Calibrar (${formatPitchOffsetShort(state.pitchOffset)})`;
}

function formatPitchOffset(offset) {
  if (offset === 0) return '0 semitonos';
  const sign = offset > 0 ? '+' : '−';
  const absolute = Math.abs(offset);
  if (absolute % 12 === 0) {
    const octaves = absolute / 12;
    return `${sign}${absolute} semitonos (${sign}${octaves} ${octaves === 1 ? 'octava' : 'octavas'})`;
  }
  return `${sign}${absolute} ${absolute === 1 ? 'semitono' : 'semitonos'}`;
}

function formatPitchOffsetShort(offset) {
  if (offset === 0) return 'sin ajuste';
  const sign = offset > 0 ? '+' : '−';
  const absolute = Math.abs(offset);
  if (absolute % 12 === 0) return `${sign}${absolute / 12} oct.`;
  return `${sign}${absolute} st`;
}

// --- Transporte / previsualización / práctica --------------------------------

async function startPreview() {
  if (!state.piece) return;
  if (state.calibration.active) cancelCalibration();
  try {
    await getAudioContext();
  } catch (_) {
    updateStatus('Este navegador no permite reproducir con Web Audio.');
    return;
  }
  prepareSession('preview');
  state.playing = true;
  triggerPreviewNotes(-0.01, 0.01);
  els.previewButton.textContent = '■ Detener';
  els.previewButton.classList.add('is-playing');
  startLoop();
  updateStatus('Previsualizando…');
}

async function startPractice() {
  if (!state.piece) return;
  if (state.calibration.active) cancelCalibration();
  if (state.mode === 'continuous' && !state.micReady) {
    updateStatus('Activa el micrófono antes de iniciar: el modo continuo espera a que toques la primera nota.');
    return;
  }
  prepareSession('practice');
  state.playing = true;
  els.playButton.textContent = '■ Detener';
  els.playButton.classList.add('is-playing');
  if (!state.micReady) updateStatus('Activa el micrófono para validar las notas.');
  else updateStatus(state.mode === 'continuous' ? 'Esperando primera nota' : 'Esperando nota');
  startLoop();
  updateDynamicUI();
}

function prepareSession(kind) {
  stopSynthVoices();
  state.sessionKind = kind;
  state.playing = false;
  state.continuousStarted = kind !== 'practice' || state.mode !== 'continuous';
  state.currentSeconds = 0;
  state.currentIndex = 0;
  state.lastFrameAt = performance.now();
  state.lastAcceptedAt = 0;
  state.previewPlayedIndexes = new Set();
  state.noteResults = state.piece.practiceNotes.map(() => 'pending');
  state.wrongAttempts = 0;
  state.stableMidi = null;
  state.stableCount = 0;
}

function resetSession() {
  state.sessionKind = null;
  state.playing = false;
  state.continuousStarted = false;
  state.currentSeconds = 0;
  state.currentIndex = 0;
  state.previewPlayedIndexes = new Set();
  state.noteResults = state.piece ? state.piece.practiceNotes.map(() => 'pending') : [];
  state.wrongAttempts = 0;
  stopSynthVoices();
  els.previewButton.textContent = '♪ Escuchar';
  els.previewButton.classList.remove('is-playing');
  els.playButton.textContent = '▶ Practicar';
  els.playButton.classList.remove('is-playing');
  updateStatus('Preparado');
  updateDynamicUI();
  drawScore();
}

function stopSession() {
  if (!state.sessionKind) return;
  const wasPractice = state.sessionKind === 'practice';
  state.playing = false;
  state.continuousStarted = false;
  stopSynthVoices();
  if (wasPractice && state.mode === 'continuous') evaluateMissedNotes();
  state.sessionKind = null;
  els.previewButton.textContent = '♪ Escuchar';
  els.previewButton.classList.remove('is-playing');
  els.playButton.textContent = '▶ Practicar';
  els.playButton.classList.remove('is-playing');
  updateStatus('Preparado');
  updateDynamicUI();
  drawScore();
}

function finishSession() {
  const completedKind = state.sessionKind;
  state.playing = false;
  state.continuousStarted = false;
  stopSynthVoices();
  if (completedKind === 'practice' && state.mode === 'continuous') evaluateMissedNotes();
  state.sessionKind = null;
  els.previewButton.textContent = '♪ Escuchar';
  els.previewButton.classList.remove('is-playing');
  els.playButton.textContent = '▶ Practicar';
  els.playButton.classList.remove('is-playing');
  updateDynamicUI();
  drawScore();
  updateStatus(completedKind === 'preview' ? 'Previsualización terminada.' : 'Sesión terminada.');
}

function startLoop() {
  if (state.animationFrame) return;
  const loop = (timestamp) => {
    state.animationFrame = requestAnimationFrame(loop);
    const delta = Math.min((timestamp - (state.lastFrameAt || timestamp)) / 1000, 0.08);
    state.lastFrameAt = timestamp;

    if (state.playing) advanceTransport(delta);
    if (state.micReady && state.sessionKind !== 'preview' && timestamp - state.lastAnalysisAt > AUDIO_CONFIG.ANALYSIS_INTERVAL_MS) {
      state.lastAnalysisAt = timestamp;
      analyzeMicrophone(timestamp);
    }
    if (timestamp - state.lastDrawAt > AUDIO_CONFIG.DRAW_INTERVAL_MS) {
      state.lastDrawAt = timestamp;
      drawScore();
    }
  };
  state.animationFrame = requestAnimationFrame(loop);
}

function advanceTransport(delta) {
  if (!state.piece || !state.sessionKind) return;

  if (state.sessionKind === 'preview') {
    const previousSeconds = state.currentSeconds;
    state.currentSeconds += delta;
    triggerPreviewNotes(previousSeconds, state.currentSeconds);
    if (state.currentSeconds >= getPieceDurationSeconds()) finishSession();
  } else if (state.mode === 'continuous') {
    if (!state.continuousStarted) {
      updateDynamicUI();
      return;
    }
    state.currentSeconds += delta;
    evaluateMissedNotes();
    state.currentIndex = getExpectedIndex();
    if (state.currentSeconds >= getPieceDurationSeconds()) finishSession();
  } else {
    const note = state.piece.practiceNotes[state.currentIndex];
    if (!note) finishSession();
    else state.currentSeconds = beatToSeconds(note.startBeat);
  }
  updateDynamicUI();
}

function triggerPreviewNotes(previousSeconds, currentSeconds) {
  if (!state.piece || state.sessionKind !== 'preview') return;
  state.piece.allNotes.forEach((note, index) => {
    if (state.previewPlayedIndexes.has(index)) return;
    const noteStart = beatToSeconds(note.startBeat);
    if (noteStart >= previousSeconds - 0.015 && noteStart <= currentSeconds + 0.025) {
      state.previewPlayedIndexes.add(index);
      playSynthNote(note.midi, beatToSeconds(note.durationBeats));
      flashFret(note.string, note.fret, 'preview-flash');
    }
  });
}

async function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio API no disponible');
  if (!state.audioContext || state.audioContext.state === 'closed') state.audioContext = new AudioContextClass();
  if (state.audioContext.state === 'suspended') await state.audioContext.resume();
  return state.audioContext;
}

function playSynthNote(midi, durationSeconds) {
  const context = state.audioContext;
  if (!context || context.state !== 'running') return;
  const now = context.currentTime;
  const duration = clamp(durationSeconds, 0.12, 3.2);
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  const master = context.createGain();
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(2600, frequency * 4), now);
  filter.Q.value = 0.2;
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
  master.gain.exponentialRampToValueAtTime(0.09, now + 0.14);
  master.gain.exponentialRampToValueAtTime(0.0001, now + duration + 0.32);
  filter.connect(master);
  master.connect(context.destination);

  const harmonics = [
    { ratio: 1, type: 'sine', detune: 0, gain: 0.75 },
    { ratio: 1, type: 'triangle', detune: 4, gain: 0.28 },
    { ratio: 2, type: 'sine', detune: -3, gain: 0.09 }
  ];

  harmonics.forEach((harmonic) => {
    const oscillator = context.createOscillator();
    const harmonicGain = context.createGain();
    oscillator.type = harmonic.type;
    oscillator.frequency.setValueAtTime(frequency * harmonic.ratio, now);
    oscillator.detune.setValueAtTime(harmonic.detune, now);
    harmonicGain.gain.value = harmonic.gain;
    oscillator.connect(harmonicGain);
    harmonicGain.connect(filter);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.35);
    state.activeSynthNodes.add(oscillator);
    oscillator.addEventListener('ended', () => state.activeSynthNodes.delete(oscillator), { once: true });
  });
}

function stopSynthVoices() {
  state.activeSynthNodes.forEach((node) => {
    try { node.stop(); } catch (_) { /* ya detenido */ }
  });
  state.activeSynthNodes.clear();
}

function updateStatus(text) {
  els.transportStatus.textContent = text;
}

// --- Detección de tono (micrófono) -------------------------------------------
// Copiado de Piano Coach sin cambios de fondo: la comparación de acierto sigue
// siendo por midi (frecuencia detectada), string/fret son solo para el dibujo.

function analyzeMicrophone(timestamp) {
  if (!state.analyser || !state.audioBuffer || !state.audioContext) return;
  state.analyser.getFloatTimeDomainData(state.audioBuffer);
  const rms = calculateRms(state.audioBuffer);

  state.previousSmoothedRms = state.smoothedRms;
  state.smoothedRms += ONSET_CONFIG.RMS_SMOOTHING_ALPHA * (rms - state.smoothedRms);
  const rmsDelta = state.smoothedRms - state.previousSmoothedRms;
  const isOnsetEdge = rmsDelta > ONSET_CONFIG.RMS_ONSET_DELTA && state.smoothedRms > ONSET_CONFIG.RMS_SUSTAIN_GATE;

  if (isOnsetEdge) {
    state.onsetActive = true;
    state.onsetDetectedAt = timestamp;
    state.stableMidi = null;
    state.stableCount = 0;
  }

  if (state.smoothedRms < ONSET_CONFIG.RMS_SILENCE_ENTER) {
    if (state.belowSilenceEnterSince === null) state.belowSilenceEnterSince = timestamp;
    if (timestamp - state.belowSilenceEnterSince >= ONSET_CONFIG.RMS_SILENCE_HOLD_MS) {
      state.detectedMidi = null;
      state.rawDetectedMidi = null;
      state.detectedFrequency = null;
      state.detectedConfidence = 0;
      state.stableMidi = null;
      state.stableCount = 0;
      state.onsetActive = false;
      if (state.calibration.active && state.calibration.awaitingRelease) {
        state.calibration.awaitingRelease = false;
        updateCalibrationUI();
        updateFretboardHighlights();
      }
      updateDynamicUI();
      return;
    }
  } else {
    state.belowSilenceEnterSince = null;
  }

  if (state.smoothedRms < ONSET_CONFIG.RMS_SUSTAIN_GATE && !isOnsetEdge) {
    updateDynamicUI();
    return;
  }

  const result = yinPitch(state.audioBuffer, state.audioContext.sampleRate, PITCH_CONFIG.YIN_THRESHOLD);
  if (!result || result.frequency < PITCH_CONFIG.MIN_FREQUENCY_HZ || result.frequency > PITCH_CONFIG.MAX_FREQUENCY_HZ) return;

  const rawMidi = Math.round(frequencyToMidi(result.frequency));
  if (rawMidi < PITCH_CONFIG.MIDI_MIN || rawMidi > PITCH_CONFIG.MIDI_MAX) return;
  const adjustedMidi = rawMidi + state.pitchOffset;

  state.rawDetectedMidi = rawMidi;
  state.detectedMidi = adjustedMidi >= PITCH_CONFIG.MIDI_MIN && adjustedMidi <= PITCH_CONFIG.MIDI_MAX ? adjustedMidi : null;
  state.detectedFrequency = result.frequency;
  state.detectedConfidence = result.confidence;

  if (state.stableMidi === rawMidi) state.stableCount += 1;
  else {
    state.stableMidi = rawMidi;
    state.stableCount = 1;
  }

  if (state.calibration.active) updateCalibrationUI();

  const onsetWindowOpen = state.onsetActive && (timestamp - state.onsetDetectedAt < ONSET_CONFIG.ONSET_ACTIVE_WINDOW_MS);
  const requiredStableFrames = onsetWindowOpen ? ONSET_CONFIG.STABLE_FRAMES_REQUIRED_ON_ONSET : ONSET_CONFIG.STABLE_FRAMES_REQUIRED;

  if (state.stableCount >= requiredStableFrames
      && result.confidence >= ONSET_CONFIG.CONFIDENCE_ACCEPT_THRESHOLD
      && timestamp - state.lastAcceptedAt > ONSET_CONFIG.ACCEPT_DEBOUNCE_MS) {
    if (state.calibration.active) captureCalibrationNote(rawMidi, timestamp);
    else if (state.detectedMidi !== null) acceptDetectedNote(state.detectedMidi, timestamp);
    state.onsetActive = false;
  }
  updateDynamicUI();
}

function acceptDetectedNote(midi, timestamp) {
  if (!state.playing || state.sessionKind !== 'practice' || !state.piece) return;
  const expectedIndex = state.mode === 'wait' ? state.currentIndex : getExpectedIndex();
  const expected = state.piece.practiceNotes[expectedIndex];
  if (!expected) return;

  if (midi === expected.midi) {
    if (state.noteResults[expectedIndex] !== 'correct') state.noteResults[expectedIndex] = 'correct';
    state.lastAcceptedAt = timestamp;
    flashFret(expected.string, expected.fret, 'detected');

    if (state.mode === 'continuous' && !state.continuousStarted && expectedIndex === 0) {
      state.continuousStarted = true;
      state.currentSeconds = beatToSeconds(expected.startBeat);
      state.lastFrameAt = performance.now();
      updateStatus('Primera nota detectada. Comienza la práctica.');
    }

    if (state.mode === 'wait') {
      state.currentIndex += 1;
      const next = state.piece.practiceNotes[state.currentIndex];
      if (next) state.currentSeconds = beatToSeconds(next.startBeat);
      else finishSession();
    }
  } else {
    state.wrongAttempts += 1;
    // El micrófono no puede saber qué cuerda se tocó, así que un fallo no puede
    // señalar una celda concreta del diapasón: se marca con un pulso genérico.
    flashFretboardWrong();
    if (state.mode === 'continuous' && state.noteResults[expectedIndex] === 'pending') {
      state.noteResults[expectedIndex] = 'wrong';
    }
  }
  updateDynamicUI();
}

function evaluateMissedNotes() {
  const graceSeconds = 0.45;
  state.piece.practiceNotes.forEach((note, index) => {
    const noteEnd = beatToSeconds(note.startBeat + note.durationBeats);
    if (state.currentSeconds > noteEnd + graceSeconds && state.noteResults[index] === 'pending') {
      state.noteResults[index] = 'missed';
    }
  });
}

function getExpectedIndex() {
  if (!state.piece) return 0;
  let lastActive = 0;
  for (let index = 0; index < state.piece.practiceNotes.length; index += 1) {
    const result = state.noteResults[index];
    lastActive = index;
    if (result === 'correct' || result === 'missed') continue;
    const note = state.piece.practiceNotes[index];
    const noteEnd = beatToSeconds(note.startBeat + note.durationBeats) + 0.45;
    if (state.currentSeconds <= noteEnd) return index;
  }
  return lastActive;
}

function yinPitch(buffer, sampleRate, threshold) {
  const minTau = Math.max(2, Math.floor(sampleRate / PITCH_CONFIG.MAX_FREQUENCY_HZ));
  const maxTau = Math.min(Math.floor(sampleRate / PITCH_CONFIG.MIN_FREQUENCY_HZ), buffer.length - 2);
  const comparisonLength = Math.min(PITCH_CONFIG.YIN_WINDOW_CAP, buffer.length - maxTau);
  if (comparisonLength < PITCH_CONFIG.YIN_MIN_COMPARISON_LENGTH) return null;

  const difference = new Float32Array(maxTau + 1);
  const cumulative = new Float32Array(maxTau + 1);

  for (let tau = 1; tau <= maxTau; tau += 1) {
    let sum = 0;
    for (let index = 0; index < comparisonLength; index += 1) {
      const delta = buffer[index] - buffer[index + tau];
      sum += delta * delta;
    }
    difference[tau] = sum;
  }

  cumulative[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxTau; tau += 1) {
    runningSum += difference[tau];
    cumulative[tau] = runningSum === 0 ? 1 : difference[tau] * tau / runningSum;
  }

  let tauEstimate = -1;
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    if (cumulative[tau] < threshold) {
      while (tau + 1 <= maxTau && cumulative[tau + 1] < cumulative[tau]) tau += 1;
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate === -1) return null;
  const betterTau = parabolicInterpolation(cumulative, tauEstimate);
  const frequency = sampleRate / betterTau;
  const confidence = clamp(1 - cumulative[tauEstimate], 0, 1);
  return { frequency, confidence };
}

function parabolicInterpolation(values, index) {
  const left = values[index - 1] ?? values[index];
  const center = values[index];
  const right = values[index + 1] ?? values[index];
  const denominator = 2 * (2 * center - right - left);
  if (denominator === 0) return index;
  return index + (right - left) / denominator;
}

function calculateRms(buffer) {
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 1) sum += buffer[index] * buffer[index];
  return Math.sqrt(sum / buffer.length);
}

function frequencyToMidi(frequency) {
  return 69 + 12 * Math.log2(frequency / 440);
}

function midiToNoteName(midi) {
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[pitchClass]}${octave}`;
}

// --- Arrastrar la partitura --------------------------------------------------

function bindScoreDragEvents() {
  const canvas = els.scoreCanvas;
  canvas.addEventListener('pointerdown', onScorePointerDown);
  canvas.addEventListener('pointermove', onScorePointerMove);
  canvas.addEventListener('pointerup', onScorePointerEnd);
  canvas.addEventListener('pointercancel', onScorePointerEnd);
}

function onScorePointerDown(event) {
  if (!state.piece) return;
  state.isDraggingScore = true;
  state.dragStartClientX = event.clientX;
  state.dragStartBeat = secondsToBeat(state.currentSeconds);
  if (state.playing) {
    state.playing = false;
    stopSynthVoices();
    updateStatus('Pausado (arrastrando)');
  }
  try { els.scoreCanvas.setPointerCapture(event.pointerId); } catch (_) { /* no soportado en todos los navegadores */ }
}

function onScorePointerMove(event) {
  if (!state.isDraggingScore) return;
  const deltaX = event.clientX - state.dragStartClientX;
  const pixelsPerBeat = state.lastPixelsPerBeat || 60;
  seekToBeat(state.dragStartBeat - deltaX / pixelsPerBeat);
  drawScore();
  updateDynamicUI();
}

function onScorePointerEnd(event) {
  if (!state.isDraggingScore) return;
  state.isDraggingScore = false;
  try { els.scoreCanvas.releasePointerCapture(event.pointerId); } catch (_) { /* no soportado en todos los navegadores */ }
  state.lastFrameAt = performance.now();
}

function seekToBeat(beat) {
  if (!state.piece) return;
  const maxBeat = secondsToBeat(getPieceDurationSeconds());
  const clampedBeat = clamp(beat, 0, maxBeat);
  state.currentSeconds = beatToSeconds(clampedBeat);

  if (state.sessionKind === 'practice') {
    state.piece.practiceNotes.forEach((note, index) => {
      if (note.startBeat >= clampedBeat - 0.001) state.noteResults[index] = 'pending';
    });
    if (state.mode === 'wait') {
      const notes = state.piece.practiceNotes;
      let nextIndex = notes.length - 1;
      for (let index = 0; index < notes.length; index += 1) {
        if (notes[index].startBeat >= clampedBeat - 0.001) { nextIndex = index; break; }
      }
      state.currentIndex = nextIndex;
    }
  } else if (state.sessionKind === 'preview') {
    Array.from(state.previewPlayedIndexes).forEach((index) => {
      const note = state.piece.allNotes[index];
      if (note && note.startBeat >= clampedBeat - 0.001) state.previewPlayedIndexes.delete(index);
    });
  }
}

// --- Diapasón de referencia -------------------------------------------------

function renderFretboard() {
  els.fretboard.innerHTML = '';
  for (let string = 1; string <= 6; string += 1) {
    const row = document.createElement('div');
    row.className = 'fretboard-row';
    for (let fret = 0; fret <= window.FretboardTuning.FRET_COUNT; fret += 1) {
      const cell = document.createElement('div');
      cell.className = `fret-cell ${fret === 0 ? 'open' : ''}`;
      cell.dataset.string = String(string);
      cell.dataset.fret = String(fret);
      cell.style.setProperty('--string-color', window.FretboardTuning.STRING_COLORS[string].css);
      cell.title = `${window.FretboardTuning.STRING_COLORS[string].name} · traste ${fret}`;
      row.appendChild(cell);
    }
    els.fretboard.appendChild(row);
  }
}

function getTemporalNoteIndex() {
  if (!state.piece) return -1;
  const beat = secondsToBeat(state.currentSeconds);
  let current = -1;
  for (let index = 0; index < state.piece.practiceNotes.length; index += 1) {
    if (state.piece.practiceNotes[index].startBeat <= beat + 0.02) current = index;
    else break;
  }
  return current;
}

function updateFretboardHighlights() {
  els.fretboard.querySelectorAll('.fret-cell.expected, .fret-cell.preview-current, .fret-cell.calibration-target')
    .forEach((cell) => cell.classList.remove('expected', 'preview-current', 'calibration-target'));
  if (!state.piece) return;

  if (state.calibration.active) {
    const target = CALIBRATION_STEPS[state.calibration.step];
    highlightFretCell(target, 'calibration-target');
    return;
  }

  if (state.sessionKind === 'preview') {
    highlightFretCell(state.piece.practiceNotes[getTemporalNoteIndex()], 'preview-current');
    return;
  }
  if (state.sessionKind === 'practice') {
    const index = state.mode === 'wait' ? state.currentIndex : getExpectedIndex();
    highlightFretCell(state.piece.practiceNotes[index], 'expected');
  }
}

function highlightFretCell(note, className) {
  if (!note) return;
  const cell = els.fretboard.querySelector(`[data-string="${note.string}"][data-fret="${note.fret}"]`);
  if (cell) cell.classList.add(className);
}

function flashFret(string, fret, className) {
  const cell = els.fretboard.querySelector(`[data-string="${string}"][data-fret="${fret}"]`);
  if (!cell) return;
  cell.classList.add(className);
  window.setTimeout(() => cell.classList.remove(className), 260);
}

function flashFretboardWrong() {
  els.fretboard.classList.add('fretboard-panel-flash');
  window.setTimeout(() => els.fretboard.classList.remove('fretboard-panel-flash'), 260);
}

// --- Panel de información ------------------------------------------------

function updateDynamicUI() {
  if (!state.piece) return;
  const expectedIndex = state.sessionKind === 'preview'
    ? getTemporalNoteIndex()
    : (state.mode === 'wait' ? state.currentIndex : getExpectedIndex());
  const expected = state.piece.practiceNotes[expectedIndex];
  const expectedText = expected ? midiToNoteName(expected.midi) : '—';
  const detectedText = state.detectedMidi === null ? '—' : midiToNoteName(state.detectedMidi);

  els.expectedNote.textContent = expectedText;
  els.detectedNote.textContent = detectedText;
  els.frequencyValue.textContent = state.detectedFrequency ? `${state.detectedFrequency.toFixed(1)} Hz` : '—';
  els.confidenceValue.textContent = state.detectedConfidence ? `${Math.round(state.detectedConfidence * 100)} %` : '—';

  const correct = state.noteResults.filter((value) => value === 'correct').length;
  const errors = state.noteResults.filter((value) => value === 'wrong' || value === 'missed').length + state.wrongAttempts;
  els.correctValue.textContent = String(correct);
  els.errorValue.textContent = String(errors);

  updateFretboardHighlights();
}

// --- Partitura + tablatura ---------------------------------------------------

function resizeCanvas() {
  const rect = els.scoreCanvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  state.scoreCanvasScale = scale;
  els.scoreCanvas.width = Math.max(1, Math.floor(rect.width * scale));
  els.scoreCanvas.height = Math.max(1, Math.floor(rect.height * scale));
  drawScore();
}

function drawScore() {
  if (!state.piece) return;
  const canvas = els.scoreCanvas;
  const context = canvas.getContext('2d');
  const scale = state.scoreCanvasScale;
  const width = canvas.width / scale;
  const height = canvas.height / scale;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#f7f4ec';
  context.fillRect(0, 0, width, height);

  const lineGap = Math.min(18, height * 0.075);
  const staffTop = height * 0.2;
  const staffBottomY = staffTop + lineGap * 4;
  const tabTop = staffBottomY + lineGap * 2.1;
  const tabLineGap = lineGap * 0.85;
  const tabBottomY = tabTop + tabLineGap * 5;
  const playheadX = Math.min(width * 0.23, 210);
  const pixelsPerBeat = Math.max(36, width / 15.5);
  state.lastPixelsPerBeat = pixelsPerBeat;
  const currentBeat = secondsToBeat(state.currentSeconds);

  // Pentagrama.
  context.strokeStyle = '#3d4651';
  context.lineWidth = 1;
  for (let line = 0; line < 5; line += 1) {
    const y = staffTop + line * lineGap;
    context.beginPath();
    context.moveTo(18, y);
    context.lineTo(width - 18, y);
    context.stroke();
  }

  // Tablatura: una línea por cuerda, coloreada igual que el diapasón (cuerda 1
  // arriba/aguda, cuerda 6 abajo/grave — convención estándar de tablatura).
  context.lineWidth = 1.4;
  for (let string = 1; string <= 6; string += 1) {
    const y = tabTop + (string - 1) * tabLineGap;
    context.strokeStyle = window.FretboardTuning.STRING_COLORS[string].css;
    context.globalAlpha = 0.55;
    context.beginPath();
    context.moveTo(18, y);
    context.lineTo(width - 18, y);
    context.stroke();
  }
  context.globalAlpha = 1;

  // Línea de reproducción, atraviesa pentagrama y tablatura.
  context.strokeStyle = '#6685ff';
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(playheadX, staffTop - 30);
  context.lineTo(playheadX, tabBottomY + 14);
  context.stroke();

  const beatsPerMeasure = Number(state.piece.timeSignature.split('/')[0]) || 4;
  const firstBeat = Math.floor(currentBeat - playheadX / pixelsPerBeat) - 1;
  const lastBeat = Math.ceil(currentBeat + (width - playheadX) / pixelsPerBeat) + 1;
  context.font = '12px system-ui';
  context.fillStyle = '#68727e';
  context.textAlign = 'center';
  for (let beat = firstBeat; beat <= lastBeat; beat += 1) {
    if (beat < 0 || beat % beatsPerMeasure !== 0) continue;
    const x = playheadX + (beat - currentBeat) * pixelsPerBeat;
    context.strokeStyle = 'rgba(61, 70, 81, 0.22)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, staffTop - 8);
    context.lineTo(x, tabBottomY + 8);
    context.stroke();
    context.fillText(String(beat / beatsPerMeasure + 1), x, staffTop - 14);
  }

  const activeIndex = state.sessionKind === 'preview'
    ? getTemporalNoteIndex()
    : (state.sessionKind === 'practice' ? (state.mode === 'wait' ? state.currentIndex : getExpectedIndex()) : -1);

  const staff = state.piece.staves[0];
  staff.voices.forEach((voice) => {
    voice.notes.forEach((note) => {
      const x = playheadX + (note.startBeat - currentBeat) * pixelsPerBeat;
      if (x < -35 || x > width + 35) return;

      const status = note.practiceIndex !== undefined ? state.noteResults[note.practiceIndex] : undefined;
      const isCurrent = activeIndex >= 0 && note.practiceIndex === activeIndex;
      let noteColor = '#232a33';
      if (state.sessionKind !== 'preview' && status === 'correct') noteColor = '#20a877';
      else if (state.sessionKind !== 'preview' && (status === 'wrong' || status === 'missed')) noteColor = '#e7485b';
      else if (isCurrent) noteColor = '#526ff3';

      drawStaffNote(context, note, x, staffTop, staffBottomY, lineGap, noteColor);
      drawTabNote(context, note, x, tabTop, tabLineGap, noteColor, isCurrent);
    });
  });

  context.fillStyle = '#27303a';
  context.font = '700 14px system-ui';
  context.textAlign = 'left';
  context.fillText('Partitura + tablatura · representación simplificada', 18, 16);
}

// La notación de guitarra se escribe una octava por encima de como suena (convención
// estándar): el midi real (el que compara la detección del micrófono) es note.midi,
// pero en el pentagrama se dibuja note.midi + 12 para que quepa cómodamente en clave
// de sol sin una decena de líneas adicionales.
const STAFF_DISPLAY_OCTAVE_OFFSET = 12;

function drawStaffNote(context, note, x, staffTop, staffBottomY, lineGap, noteColor) {
  const y = midiToStaffY(note.midi + STAFF_DISPLAY_OCTAVE_OFFSET, staffTop, lineGap);

  context.strokeStyle = noteColor;
  context.lineWidth = 1;
  if (y < staffTop - lineGap / 2) {
    for (let ly = staffTop - lineGap; ly >= y - lineGap / 2; ly -= lineGap) {
      context.beginPath();
      context.moveTo(x - 12, ly);
      context.lineTo(x + 12, ly);
      context.stroke();
    }
  } else if (y > staffBottomY + lineGap / 2) {
    for (let ly = staffBottomY + lineGap; ly <= y + lineGap / 2; ly += lineGap) {
      context.beginPath();
      context.moveTo(x - 12, ly);
      context.lineTo(x + 12, ly);
      context.stroke();
    }
  }

  const glyph = getDurationGlyphFromType(note.noteType, note.dots);
  const stemUp = note.midi + STAFF_DISPLAY_OCTAVE_OFFSET < 71;

  context.save();
  context.translate(x, y);
  context.rotate(glyph.wide ? -0.08 : -0.22);
  context.beginPath();
  context.ellipse(0, 0, glyph.wide ? 10 : 7, 5, 0, 0, Math.PI * 2);
  if (glyph.hollow) {
    context.fillStyle = '#f7f4ec';
    context.fill();
    context.lineWidth = 1.6;
    context.strokeStyle = noteColor;
    context.stroke();
  } else {
    context.fillStyle = noteColor;
    context.fill();
  }
  context.restore();

  if (glyph.dot) {
    context.beginPath();
    context.fillStyle = noteColor;
    context.arc(x + 14, y - 2, 1.8, 0, Math.PI * 2);
    context.fill();
  }

  if (glyph.stem) {
    const stemLength = 30;
    const stemX = stemUp ? x + 7 : x - 7;
    const stemDir = stemUp ? -1 : 1;
    const stemEndY = y + stemDir * stemLength;
    context.strokeStyle = noteColor;
    context.lineWidth = 1.6;
    context.beginPath();
    context.moveTo(stemX, y);
    context.lineTo(stemX, stemEndY);
    context.stroke();
    for (let f = 0; f < glyph.flags; f += 1) {
      const flagStartY = stemEndY + stemDir * (f * 8);
      context.beginPath();
      context.moveTo(stemX, flagStartY);
      context.quadraticCurveTo(stemX + (stemUp ? 9 : -9), flagStartY + stemDir * 6, stemX, flagStartY + stemDir * 14);
      context.stroke();
    }
  }

  if (state.showNoteNames) {
    context.fillStyle = noteColor;
    context.font = '600 9px system-ui';
    context.textAlign = 'center';
    context.fillText(NOTE_NAMES[((note.midi % 12) + 12) % 12], x, y + 20);
  }
}

function drawTabNote(context, note, x, tabTop, tabLineGap, noteColor, isCurrent) {
  const y = tabTop + (note.string - 1) * tabLineGap;
  const color = window.FretboardTuning.STRING_COLORS[note.string].css;

  if (isCurrent) {
    context.beginPath();
    context.arc(x, y, 9, 0, Math.PI * 2);
    context.strokeStyle = noteColor;
    context.lineWidth = 1.6;
    context.stroke();
  }

  context.fillStyle = '#f7f4ec';
  context.fillRect(x - 8, y - 7, 16, 14);
  context.fillStyle = color;
  context.font = '700 12px system-ui';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(note.fret), x, y);
  context.textBaseline = 'alphabetic';
}

function getDurationGlyphFromType(noteType, dots) {
  const table = {
    whole: { wide: true, hollow: true, stem: false, flags: 0 },
    half: { wide: false, hollow: true, stem: true, flags: 0 },
    quarter: { wide: false, hollow: false, stem: true, flags: 0 },
    eighth: { wide: false, hollow: false, stem: true, flags: 1 },
    '16th': { wide: false, hollow: false, stem: true, flags: 2 },
    '32nd': { wide: false, hollow: false, stem: true, flags: 3 }
  };
  const base = table[noteType] || table.quarter;
  return { ...base, dot: Number(dots) > 0 };
}

function midiToStaffY(displayMidi, staffTop, lineGap) {
  const referenceMidi = 71; // Si4, línea central en clave de sol
  const semitoneOffset = displayMidi - referenceMidi;
  return staffTop + lineGap * 2 - semitoneOffset * (lineGap / 4);
}

function beatToSeconds(beat) {
  return beat * 60 / (state.piece ? state.piece.tempo : 80);
}

function secondsToBeat(seconds) {
  return seconds * (state.piece ? state.piece.tempo : 80) / 60;
}

function getPieceDurationSeconds() {
  const lastEndBeat = state.piece.allNotes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0);
  return beatToSeconds(lastEndBeat);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
