'use strict';

(function exposeMusicXmlImporter(globalScope) {
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_IMPORTED_NOTES = 8000;
  const MAX_STAVES = 2;
  const MAX_VOICES_PER_STAFF = 2;
  const STEP_TO_PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  async function convert(source, filename = 'pieza.musicxml') {
    const xmlText = await resolveXmlText(source, filename);
    return convertXmlText(xmlText, filename);
  }

  async function resolveXmlText(source, filename) {
    if (typeof source === 'string') return source;
    if (!(source instanceof ArrayBuffer)) throw new Error('El archivo MusicXML no se pudo leer.');
    if (source.byteLength > MAX_FILE_BYTES) throw new Error('El archivo es demasiado grande. El límite es 20 MB.');

    const bytes = new Uint8Array(source);
    const looksLikeZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    const isMxl = looksLikeZip || /\.mxl$/i.test(String(filename || ''));
    return isMxl ? extractMusicXmlFromMxl(bytes) : decodeUtf8(bytes);
  }

  function convertXmlText(xmlText, filename) {
    if (typeof xmlText !== 'string') throw new Error('El archivo MusicXML no se pudo leer.');
    if (xmlText.length > MAX_FILE_BYTES) throw new Error('El MusicXML es demasiado grande. El límite es 20 MB.');

    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('El archivo MusicXML no se pudo interpretar. Comprueba que no esté dañado.');
    }

    const root = doc.documentElement;
    if (!root) throw new Error('El archivo MusicXML no contiene una partitura válida.');
    if (root.tagName === 'score-timewise') {
      throw new Error('Las partituras MusicXML "timewise" todavía no son compatibles. Exporta en formato "partwise".');
    }
    if (root.tagName !== 'score-partwise') {
      throw new Error('El archivo no es una partitura MusicXML reconocida.');
    }

    const parts = Array.from(root.getElementsByTagName('part'));
    if (parts.length === 0) throw new Error('El archivo MusicXML no contiene partes musicales.');

    const partId = parts[0].getAttribute('id');
    const partList = root.getElementsByTagName('part-list')[0];
    const partName = partId && partList ? findPartName(partList, partId) : '';

    const result = parsePart(parts[0]);
    if (result.noteCount === 0) throw new Error('El archivo MusicXML no contiene notas utilizables.');
    if (result.noteCount > MAX_IMPORTED_NOTES) {
      throw new Error(`La pieza tiene ${result.noteCount} notas. El máximo admitido es ${MAX_IMPORTED_NOTES}.`);
    }

    const staves = Array.from(result.staves.values())
      .sort((a, b) => a.number - b.number)
      .slice(0, MAX_STAVES)
      .map((staffEntry, staffIndex) => {
        const voices = Array.from(staffEntry.voices.values())
          .slice(0, MAX_VOICES_PER_STAFF)
          .map((voiceEntry, voiceIndex) => {
            voiceEntry.notes.forEach((note) => {
              note.staff = staffIndex;
              note.voice = voiceIndex;
            });
            return { id: voiceIndex, notes: voiceEntry.notes };
          });
        return { clef: staffEntry.clef, voices };
      });

    const title = cleanTitle(filename, partName);

    return {
      piece: {
        title,
        composer: 'Importado desde MusicXML',
        tempo: clamp(Math.round(result.tempo), 40, 180),
        timeSignature: result.timeSignature,
        description: `Partitura importada automáticamente${partName ? ` de ${partName}` : ''}`,
        keySignature: result.keySignature,
        staves,
        dynamics: result.dynamics
      },
      details: {
        sourceParts: parts.length,
        staffCount: staves.length,
        importedNotes: result.noteCount
      }
    };
  }

  function findPartName(partList, partId) {
    const scoreParts = Array.from(partList.getElementsByTagName('score-part'));
    const match = scoreParts.find((el) => el.getAttribute('id') === partId);
    const nameEl = match ? firstChild(match, 'part-name') : null;
    return nameEl ? text(nameEl) : '';
  }

  function parsePart(partEl) {
    const state = {
      divisions: 1,
      tick: 0,
      lastNoteStartTick: 0,
      staves: new Map(), // staffNumber -> { number, clef, voices: Map(voiceId -> {notes, lastNonChordIndex}) }
      keyCaptured: false,
      keySignature: { fifths: 0, mode: 'major' },
      timeCaptured: false,
      timeSignature: '4/4',
      tempoCaptured: false,
      tempo: 80,
      dynamics: [],
      noteCount: 0
    };

    Array.from(partEl.getElementsByTagName('measure')).forEach((measureEl) => processMeasure(measureEl, state));
    return state;
  }

  function processMeasure(measureEl, state) {
    Array.from(measureEl.children).forEach((el) => {
      if (el.tagName === 'attributes') processAttributes(el, state);
      else if (el.tagName === 'note') processNote(el, state);
      else if (el.tagName === 'backup') state.tick -= numberOfChild(el, 'duration', 0);
      else if (el.tagName === 'forward') state.tick += numberOfChild(el, 'duration', 0);
      else if (el.tagName === 'direction') processDirection(el, state);
    });
  }

  function processAttributes(el, state) {
    const divisionsEl = firstChild(el, 'divisions');
    if (divisionsEl) {
      const value = Number(text(divisionsEl));
      if (Number.isFinite(value) && value > 0) state.divisions = value;
    }

    if (!state.keyCaptured) {
      const keyEl = firstChild(el, 'key');
      if (keyEl) {
        const fifthsEl = firstChild(keyEl, 'fifths');
        const modeEl = firstChild(keyEl, 'mode');
        state.keySignature = {
          fifths: fifthsEl ? Math.round(Number(text(fifthsEl)) || 0) : 0,
          mode: modeEl && text(modeEl).toLowerCase() === 'minor' ? 'minor' : 'major'
        };
        state.keyCaptured = true;
      }
    }

    if (!state.timeCaptured) {
      const timeEl = firstChild(el, 'time');
      if (timeEl) {
        const beatsEl = firstChild(timeEl, 'beats');
        const beatTypeEl = firstChild(timeEl, 'beat-type');
        if (beatsEl && beatTypeEl) {
          state.timeSignature = `${text(beatsEl)}/${text(beatTypeEl)}`;
          state.timeCaptured = true;
        }
      }
    }

    Array.from(el.getElementsByTagName('clef')).forEach((clefEl) => {
      const number = Number(clefEl.getAttribute('number') || '1') || 1;
      const signEl = firstChild(clefEl, 'sign');
      const clef = signEl && text(signEl).toUpperCase() === 'F' ? 'bass' : 'treble';
      getOrCreateStaff(state, number).clef = clef;
    });
  }

  function processDirection(el, state) {
    if (!state.tempoCaptured) {
      const soundEl = firstChild(el, 'sound');
      const tempoAttr = soundEl?.getAttribute('tempo');
      if (tempoAttr) {
        const value = Number(tempoAttr);
        if (Number.isFinite(value) && value > 0) {
          state.tempo = value;
          state.tempoCaptured = true;
        }
      }
    }

    const dynamicsEl = el.getElementsByTagName('dynamics')[0];
    if (dynamicsEl && dynamicsEl.firstElementChild) {
      state.dynamics.push({ beat: roundBeat(state.tick / state.divisions), text: dynamicsEl.firstElementChild.tagName });
    }
  }

  function processNote(el, state) {
    const isChord = firstChild(el, 'chord') !== null;
    const isRest = firstChild(el, 'rest') !== null;
    const isGrace = firstChild(el, 'grace') !== null;
    if (isGrace) return; // v1 punt: grace notes have no reliable duration, not modeled.

    const duration = numberOfChild(el, 'duration', 0);
    const voiceId = textOfChild(el, 'voice', '1');
    const staffNumber = Number(textOfChild(el, 'staff', '1')) || 1;

    const startTick = isChord ? state.lastNoteStartTick : state.tick;
    if (!isChord) {
      state.lastNoteStartTick = state.tick;
      state.tick += duration;
    }

    if (isRest) return;

    const pitchEl = firstChild(el, 'pitch');
    if (!pitchEl) return;
    const stepEl = firstChild(pitchEl, 'step');
    const octaveEl = firstChild(pitchEl, 'octave');
    const alterEl = firstChild(pitchEl, 'alter');
    if (!stepEl || !octaveEl) return;

    const pitchClass = STEP_TO_PITCH_CLASS[text(stepEl).toUpperCase()];
    if (pitchClass === undefined) return;
    const octave = Number(text(octaveEl));
    const alter = alterEl ? Number(text(alterEl)) || 0 : 0;
    const midi = (octave + 1) * 12 + pitchClass + alter;
    if (!Number.isFinite(midi)) return;

    const typeEl = firstChild(el, 'type');
    const noteType = typeEl ? text(typeEl) : null;
    const dots = Array.from(el.children).filter((child) => child.tagName === 'dot').length;

    const tieEls = Array.from(el.getElementsByTagName('tie'));
    const hasStart = tieEls.some((t) => t.getAttribute('type') === 'start');
    const hasStop = tieEls.some((t) => t.getAttribute('type') === 'stop');
    const tied = hasStart && hasStop ? 'start-stop' : hasStart ? 'start' : hasStop ? 'stop' : null;

    const articulations = [];
    Array.from(el.getElementsByTagName('articulations')).forEach((articulationsEl) => {
      Array.from(articulationsEl.children).forEach((mark) => {
        if (mark.tagName === 'staccato') articulations.push('staccato');
        else if (mark.tagName === 'accent') articulations.push('accent');
      });
    });

    // Las tablaturas de guitarra a menudo incluyen la digitación explícita en
    // <notations><technical><string>/<fret>. Si no está, se deja en null y el
    // validador de la app asigna una digitación automática (ver fretboard-tuning.js).
    let string = null;
    let fret = null;
    const technicalEl = el.getElementsByTagName('technical')[0];
    if (technicalEl) {
      const stringTechEl = firstChild(technicalEl, 'string');
      const fretTechEl = firstChild(technicalEl, 'fret');
      if (stringTechEl) string = Number(text(stringTechEl));
      if (fretTechEl) fret = Number(text(fretTechEl));
      if (!Number.isInteger(string) || !Number.isInteger(fret)) { string = null; fret = null; }
    }

    const durationBeats = Math.max(1 / 64, duration / state.divisions);
    const staff = getOrCreateStaff(state, staffNumber);
    const voice = getOrCreateVoice(staff, voiceId);

    const note = {
      midi: Math.round(clamp(midi, 21, 108)),
      startBeat: roundBeat(startTick / state.divisions),
      durationBeats: roundBeat(durationBeats),
      noteType,
      dots,
      tied,
      articulations,
      chordWith: isChord && voice.lastNonChordIndex >= 0 ? voice.lastNonChordIndex : null,
      staff: 0,
      voice: 0,
      string,
      fret
    };

    voice.notes.push(note);
    if (!isChord) voice.lastNonChordIndex = voice.notes.length - 1;
    state.noteCount += 1;
  }

  function getOrCreateStaff(state, number) {
    if (!state.staves.has(number)) state.staves.set(number, { number, clef: 'treble', voices: new Map() });
    return state.staves.get(number);
  }

  function getOrCreateVoice(staff, voiceId) {
    if (!staff.voices.has(voiceId)) staff.voices.set(voiceId, { notes: [], lastNonChordIndex: -1 });
    return staff.voices.get(voiceId);
  }

  function firstChild(el, tag) {
    return Array.from(el.children).find((child) => child.tagName === tag) || null;
  }

  function textOfChild(el, tag, fallback) {
    const child = firstChild(el, tag);
    return child ? text(child) : fallback;
  }

  function numberOfChild(el, tag, fallback) {
    const child = firstChild(el, tag);
    const value = child ? Number(text(child)) : NaN;
    return Number.isFinite(value) ? value : fallback;
  }

  function text(el) {
    return (el.textContent || '').trim();
  }

  function cleanTitle(filename, partName) {
    const fileTitle = String(filename || 'Pieza MusicXML').replace(/\.(musicxml|xml|mxl)$/i, '').replace(/[_-]+/g, ' ').trim();
    return fileTitle || partName || 'Pieza MusicXML';
  }

  function roundBeat(value) {
    return Math.round(value * 10000) / 10000;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // --- Soporte para .mxl (MusicXML comprimido en un ZIP) ---
  // Se implementa un lector ZIP mínimo en vez de depender de una librería externa
  // (el proyecto no usa bundler ni CDN). La descompresión "deflate" se delega en la
  // DecompressionStream nativa del navegador.

  async function extractMusicXmlFromMxl(bytes) {
    const entries = parseZipEntries(bytes);

    const containerEntry = entries.find((entry) => entry.name === 'META-INF/container.xml');
    let targetName = null;
    if (containerEntry) {
      const containerBytes = await extractZipEntry(bytes, containerEntry);
      const containerDoc = new DOMParser().parseFromString(decodeUtf8(containerBytes), 'application/xml');
      const rootfile = containerDoc.getElementsByTagName('rootfile')[0];
      targetName = rootfile ? rootfile.getAttribute('full-path') : null;
    }

    let targetEntry = targetName ? entries.find((entry) => entry.name === targetName) : null;
    if (!targetEntry) {
      // Sin container.xml legible: usa el primer .xml/.musicxml que no sea metadato.
      targetEntry = entries.find((entry) => /\.(musicxml|xml)$/i.test(entry.name) && !entry.name.startsWith('META-INF/'));
    }
    if (!targetEntry) throw new Error('El archivo .mxl no contiene una partitura MusicXML reconocible.');

    const scoreBytes = await extractZipEntry(bytes, targetEntry);
    return decodeUtf8(scoreBytes);
  }

  function findEndOfCentralDirectory(bytes) {
    const EOCD_SIGNATURE = 0x06054b50;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const maxCommentLength = 65535;
    const start = Math.max(0, bytes.length - 22 - maxCommentLength);
    for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
      if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
        const commentLength = view.getUint16(offset + 20, true);
        if (offset + 22 + commentLength === bytes.length) return offset;
      }
    }
    throw new Error('El archivo .mxl no tiene un formato ZIP válido.');
  }

  function parseZipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocdOffset = findEndOfCentralDirectory(bytes);
    const entryCount = view.getUint16(eocdOffset + 10, true);
    let cursor = view.getUint32(eocdOffset + 16, true);
    const CENTRAL_SIGNATURE = 0x02014b50;
    const entries = [];

    for (let index = 0; index < entryCount; index += 1) {
      if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
        throw new Error('El archivo .mxl está dañado (directorio central inválido).');
      }
      const method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localHeaderOffset = view.getUint32(cursor + 42, true);
      const name = decodeUtf8(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async function extractZipEntry(bytes, entry) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const LOCAL_SIGNATURE = 0x04034b50;
    const offset = entry.localHeaderOffset;
    if (view.getUint32(offset, true) !== LOCAL_SIGNATURE) {
      throw new Error('El archivo .mxl está dañado (cabecera local inválida).');
    }
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + nameLength + extraLength;
    const compressedBytes = bytes.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.method === 0) return compressedBytes; // almacenado sin comprimir
    if (entry.method !== 8) throw new Error('El archivo .mxl usa un método de compresión no compatible.');
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Este navegador no puede descomprimir archivos .mxl. Prueba con una versión reciente de Chrome/Edge, o exporta como MusicXML sin comprimir (.musicxml).');
    }
    const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const decompressed = await new Response(stream).arrayBuffer();
    return new Uint8Array(decompressed);
  }

  function decodeUtf8(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (_) {
      return Array.from(bytes, (value) => String.fromCharCode(value)).join('');
    }
  }

  const api = { convert };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.MusicXmlImporter = api;
})(typeof window !== 'undefined' ? window : globalThis);
