'use strict';

// Afinación estándar y colores de cuerda, compartidos por el validador de piezas,
// el diapasón de referencia, la tablatura y los importadores. Los colores
// reproducen el esquema real de trastes pintados de la guitarra del usuario
// (cuerda 6 naranja ... cuerda 1 rosa), el mismo lenguaje visual que los
// marcadores de solfeo del teclado en Piano Coach.

const FRET_COUNT = 12;
const MAX_FRET = 24;

// MIDI de cada cuerda al aire (afinación estándar Mi La Re Sol Si Mi).
const STANDARD_TUNING = { 6: 40, 5: 45, 4: 50, 3: 55, 2: 59, 1: 64 };

const STRING_COLORS = {
  6: { name: 'Mi grave (6ª)', css: '#f5943a' },
  5: { name: 'La (5ª)', css: '#4fd0e5' },
  4: { name: 'Re (4ª)', css: '#e0453f' },
  3: { name: 'Sol (3ª)', css: '#f2d43a' },
  2: { name: 'Si (2ª)', css: '#5fca6b' },
  1: { name: 'Mi agudo (1ª)', css: '#f16fb0' }
};

function midiForStringFret(string, fret) {
  return STANDARD_TUNING[string] + fret;
}

// Todas las combinaciones {string, fret} válidas (traste 0-MAX_FRET) para un MIDI dado.
function fingeringCandidates(midi) {
  const candidates = [];
  for (let string = 1; string <= 6; string += 1) {
    const fret = midi - STANDARD_TUNING[string];
    if (fret >= 0 && fret <= MAX_FRET) candidates.push({ string, fret });
  }
  return candidates;
}

// Asigna cuerda/traste a una nota sin digitación explícita, priorizando cuerdas al
// aire y minimizando el desplazamiento de mano respecto a la nota anterior.
function assignFingering(midi, previous) {
  const candidates = fingeringCandidates(midi);
  if (candidates.length === 0) {
    throw new Error(`No existe una digitación válida para midi ${midi} en afinación estándar (traste máximo ${MAX_FRET}).`);
  }

  if (!previous) {
    candidates.sort((a, b) => (a.fret !== 0) - (b.fret !== 0) || a.fret - b.fret || a.string - b.string);
    return candidates[0];
  }

  candidates.forEach((candidate) => {
    candidate.score = Math.abs(candidate.fret - previous.fret)
      + (candidate.fret === 0 ? -0.5 : 0)
      + candidate.fret * 0.01
      + candidate.string * 0.001;
  });
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}

const api = { FRET_COUNT, MAX_FRET, STANDARD_TUNING, STRING_COLORS, midiForStringFret, fingeringCandidates, assignFingering };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.FretboardTuning = api;
