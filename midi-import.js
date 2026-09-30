'use strict';

(function exposeMidiImporter(globalScope) {
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_IMPORTED_NOTES = 5000;
  const PREFERRED_TRACK_WORDS = /melod|lead|right|mano derecha|vocal|voice|soprano|solo|theme|main/i;
  const AVOID_TRACK_WORDS = /bass|left|mano izquierda|accomp|chord|drum|perc|rhythm|bater|bajo/i;

  function convert(arrayBuffer, filename = 'pieza.mid') {
    if (!(arrayBuffer instanceof ArrayBuffer)) throw new Error('El archivo MIDI no se pudo leer.');
    if (arrayBuffer.byteLength > MAX_FILE_BYTES) throw new Error('El MIDI es demasiado grande. El límite es 20 MB.');

    const midi = parseStandardMidi(arrayBuffer);
    const candidates = buildCandidates(midi.tracks, midi.ticksPerBeat);
    if (candidates.length === 0) {
      throw new Error('El MIDI no contiene notas utilizables. Se ignora el canal de percusión.');
    }

    const selected = candidates.sort((a, b) => b.score - a.score)[0];
    const melody = makeMonophonic(selected.notes, midi.ticksPerBeat);
    if (melody.length === 0) throw new Error('No se pudo extraer una melodía del MIDI.');
    if (melody.length > MAX_IMPORTED_NOTES) {
      throw new Error(`La melodía extraída tiene ${melody.length} notas. El máximo admitido es ${MAX_IMPORTED_NOTES}.`);
    }

    const firstTick = melody[0].startTick;
    const tempo = getInitialTempo(midi.tempoEvents, firstTick);
    const timeSignature = getInitialTimeSignature(midi.timeSignatureEvents, firstTick);
    const title = cleanTitle(filename, selected.trackName);
    const trackLabel = selected.trackName || selected.instrumentName || `pista ${selected.trackIndex + 1}`;

    const notes = melody.map((note) => ({
      midi: note.midi,
      startBeat: roundBeat((note.startTick - firstTick) / midi.ticksPerBeat),
      durationBeats: Math.max(1 / 64, roundBeat((note.endTick - note.startTick) / midi.ticksPerBeat))
    }));

    return {
      piece: {
        title,
        composer: 'Importado desde MIDI',
        tempo,
        timeSignature,
        description: `Melodía monofónica extraída automáticamente de ${trackLabel}`,
        notes
      },
      details: {
        sourceTracks: midi.tracks.length,
        candidateTracks: candidates.length,
        selectedTrack: trackLabel,
        selectedChannel: selected.channel + 1,
        originalNotes: selected.notes.length,
        importedNotes: notes.length,
        tempo,
        timeSignature
      }
    };
  }

  function parseStandardMidi(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const cursor = { offset: 0 };

    if (readAscii(view, cursor, 4) !== 'MThd') throw new Error('El archivo no tiene una cabecera MIDI válida.');
    const headerLength = readUint32(view, cursor);
    if (headerLength < 6 || cursor.offset + headerLength > view.byteLength) throw new Error('La cabecera MIDI está dañada.');

    const format = readUint16(view, cursor);
    const trackCount = readUint16(view, cursor);
    const division = readUint16(view, cursor);
    cursor.offset += headerLength - 6;

    if (format > 2) throw new Error(`Formato MIDI ${format} no compatible.`);
    if (trackCount < 1) throw new Error('El MIDI no contiene pistas.');
    if (division & 0x8000) throw new Error('Los MIDI con división SMPTE todavía no son compatibles.');
    if (division === 0) throw new Error('La resolución temporal del MIDI no es válida.');

    const tempoEvents = [];
    const timeSignatureEvents = [];
    const tracks = [];

    for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
      if (cursor.offset + 8 > view.byteLength) throw new Error('El MIDI termina antes de completar todas sus pistas.');
      const chunkId = readAscii(view, cursor, 4);
      const chunkLength = readUint32(view, cursor);
      const chunkEnd = cursor.offset + chunkLength;
      if (chunkEnd > view.byteLength) throw new Error('Una pista MIDI tiene una longitud incorrecta.');

      if (chunkId !== 'MTrk') {
        cursor.offset = chunkEnd;
        trackIndex -= 1;
        continue;
      }

      tracks.push(parseTrack(view, cursor, chunkEnd, tracks.length, tempoEvents, timeSignatureEvents));
      cursor.offset = chunkEnd;
    }

    return { format, ticksPerBeat: division, tracks, tempoEvents, timeSignatureEvents };
  }

  function parseTrack(view, cursor, endOffset, trackIndex, tempoEvents, timeSignatureEvents) {
    let tick = 0;
    let runningStatus = null;
    let trackName = '';
    let instrumentName = '';
    const notes = [];
    const activeNotes = new Map();

    while (cursor.offset < endOffset) {
      tick += readVariableLength(view, cursor, endOffset);
      if (cursor.offset >= endOffset) break;

      let status = readUint8(view, cursor);
      let firstData = null;
      if (status < 0x80) {
        if (runningStatus === null) throw new Error('La pista MIDI contiene un estado de ejecución inválido.');
        firstData = status;
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      }

      if (status === 0xff) {
        runningStatus = null;
        const metaType = readUint8(view, cursor);
        const length = readVariableLength(view, cursor, endOffset);
        ensureAvailable(cursor, length, endOffset);
        const dataStart = cursor.offset;

        if (metaType === 0x03) trackName = decodeText(view, dataStart, length) || trackName;
        else if (metaType === 0x04) instrumentName = decodeText(view, dataStart, length) || instrumentName;
        else if (metaType === 0x51 && length === 3) {
          const microseconds = (view.getUint8(dataStart) << 16) | (view.getUint8(dataStart + 1) << 8) | view.getUint8(dataStart + 2);
          if (microseconds > 0) tempoEvents.push({ tick, microseconds });
        } else if (metaType === 0x58 && length >= 2) {
          const numerator = view.getUint8(dataStart);
          const denominator = 2 ** view.getUint8(dataStart + 1);
          if (numerator > 0 && denominator > 0) timeSignatureEvents.push({ tick, numerator, denominator });
        }

        cursor.offset += length;
        if (metaType === 0x2f) break;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        runningStatus = null;
        const length = readVariableLength(view, cursor, endOffset);
        ensureAvailable(cursor, length, endOffset);
        cursor.offset += length;
        continue;
      }

      if (status >= 0xf0) {
        runningStatus = null;
        const dataLength = systemMessageLength(status);
        ensureAvailable(cursor, dataLength, endOffset);
        cursor.offset += dataLength;
        continue;
      }

      const command = status >> 4;
      const channel = status & 0x0f;
      const dataLength = command === 0x0c || command === 0x0d ? 1 : 2;
      const data1 = firstData === null ? readUint8Within(view, cursor, endOffset) : firstData;
      const data2 = dataLength === 2 ? readUint8Within(view, cursor, endOffset) : 0;

      if (command === 0x09 && data2 > 0) {
        const key = `${channel}:${data1}`;
        const starts = activeNotes.get(key) || [];
        starts.push({ startTick: tick, velocity: data2 });
        activeNotes.set(key, starts);
      } else if (command === 0x08 || (command === 0x09 && data2 === 0)) {
        const key = `${channel}:${data1}`;
        const starts = activeNotes.get(key);
        if (starts?.length) {
          const started = starts.shift();
          if (starts.length === 0) activeNotes.delete(key);
          notes.push({
            midi: data1,
            channel,
            velocity: started.velocity,
            startTick: started.startTick,
            endTick: Math.max(started.startTick + 1, tick)
          });
        }
      }
    }

    activeNotes.forEach((starts, key) => {
      const [channelText, midiText] = key.split(':');
      starts.forEach((started) => {
        notes.push({
          midi: Number(midiText),
          channel: Number(channelText),
          velocity: started.velocity,
          startTick: started.startTick,
          endTick: Math.max(started.startTick + 1, tick)
        });
      });
    });

    return { trackIndex, trackName: trackName.trim(), instrumentName: instrumentName.trim(), notes };
  }

  function buildCandidates(tracks, ticksPerBeat) {
    const candidates = [];

    tracks.forEach((track) => {
      const byChannel = new Map();
      track.notes.forEach((note) => {
        if (note.channel === 9 || note.midi < 21 || note.midi > 108) return;
        const list = byChannel.get(note.channel) || [];
        list.push(note);
        byChannel.set(note.channel, list);
      });

      byChannel.forEach((notes, channel) => {
        if (notes.length < 2) return;
        notes.sort((a, b) => a.startTick - b.startTick || b.midi - a.midi || a.endTick - b.endTick);
        const stats = calculateCandidateStats(notes, ticksPerBeat);
        const label = `${track.trackName} ${track.instrumentName}`.trim();
        let score = Math.min(notes.length, 500) * 1.5;
        score += (1 - stats.polyphonyRatio) * 450;
        score += stats.averagePitch * 2;
        score += Math.min(stats.pitchRange, 36) * 2;
        score -= Math.max(0, stats.density - 3) * 90;
        if (stats.averagePitch < 48) score -= (48 - stats.averagePitch) * 18;
        if (PREFERRED_TRACK_WORDS.test(label)) score += 1000;
        if (AVOID_TRACK_WORDS.test(label)) score -= 1000;

        candidates.push({
          trackIndex: track.trackIndex,
          trackName: track.trackName,
          instrumentName: track.instrumentName,
          channel,
          notes,
          score,
          stats
        });
      });
    });

    return candidates;
  }

  function calculateCandidateStats(notes, ticksPerBeat) {
    let pitchTotal = 0;
    let minPitch = 127;
    let maxPitch = 0;
    let overlaps = 0;
    let furthestEnd = 0;

    notes.forEach((note) => {
      pitchTotal += note.midi;
      minPitch = Math.min(minPitch, note.midi);
      maxPitch = Math.max(maxPitch, note.midi);
      if (note.startTick < furthestEnd) overlaps += 1;
      furthestEnd = Math.max(furthestEnd, note.endTick);
    });

    const durationBeats = Math.max(1, furthestEnd / ticksPerBeat);
    return {
      averagePitch: pitchTotal / notes.length,
      pitchRange: maxPitch - minPitch,
      polyphonyRatio: overlaps / notes.length,
      density: notes.length / durationBeats
    };
  }

  function makeMonophonic(notes, ticksPerBeat) {
    const onsetGroups = [];
    let currentGroup = null;

    notes.forEach((note) => {
      if (!currentGroup || currentGroup.tick !== note.startTick) {
        currentGroup = { tick: note.startTick, notes: [] };
        onsetGroups.push(currentGroup);
      }
      currentGroup.notes.push(note);
    });

    const selected = onsetGroups.map((group) => group.notes.sort((a, b) => b.midi - a.midi || b.velocity - a.velocity)[0]);
    const monophonic = [];
    const mergeTolerance = ticksPerBeat * 0.04;

    selected.forEach((note) => {
      const copy = { ...note };
      const previous = monophonic[monophonic.length - 1];

      if (previous && previous.midi === copy.midi && copy.startTick - previous.endTick <= mergeTolerance) {
        previous.endTick = Math.max(previous.endTick, copy.endTick);
        return;
      }

      if (previous && previous.endTick > copy.startTick) {
        previous.endTick = Math.max(previous.startTick + 1, copy.startTick);
      }
      monophonic.push(copy);
    });

    return monophonic.filter((note) => note.endTick > note.startTick);
  }

  function getInitialTempo(events, firstTick) {
    const sorted = [...events].sort((a, b) => a.tick - b.tick);
    const applicable = sorted.filter((event) => event.tick <= firstTick).pop() || sorted[0];
    const bpm = applicable ? Math.round(60000000 / applicable.microseconds) : 120;
    return Math.min(180, Math.max(40, bpm));
  }

  function getInitialTimeSignature(events, firstTick) {
    const sorted = [...events].sort((a, b) => a.tick - b.tick);
    const applicable = sorted.filter((event) => event.tick <= firstTick).pop() || sorted[0];
    return applicable ? `${applicable.numerator}/${applicable.denominator}` : '4/4';
  }

  function cleanTitle(filename, trackName) {
    const fileTitle = String(filename || 'Pieza MIDI').replace(/\.(mid|midi)$/i, '').replace(/[_-]+/g, ' ').trim();
    const genericTrack = /^(track|pista|midi|untitled|instrument)\s*\d*$/i;
    const usefulTrackName = trackName && !genericTrack.test(trackName.trim()) ? trackName.trim() : '';
    return fileTitle || usefulTrackName || 'Pieza MIDI';
  }

  function roundBeat(value) {
    return Math.round(value * 10000) / 10000;
  }

  function readAscii(view, cursor, length) {
    ensureAvailable(cursor, length, view.byteLength);
    let result = '';
    for (let index = 0; index < length; index += 1) result += String.fromCharCode(view.getUint8(cursor.offset++));
    return result;
  }

  function decodeText(view, offset, length) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\0/g, '').trim();
    } catch (_) {
      return Array.from(bytes, (value) => String.fromCharCode(value)).join('').replace(/\0/g, '').trim();
    }
  }

  function readUint8(view, cursor) {
    ensureAvailable(cursor, 1, view.byteLength);
    return view.getUint8(cursor.offset++);
  }

  function readUint8Within(view, cursor, endOffset) {
    ensureAvailable(cursor, 1, endOffset);
    return view.getUint8(cursor.offset++);
  }

  function readUint16(view, cursor) {
    ensureAvailable(cursor, 2, view.byteLength);
    const value = view.getUint16(cursor.offset, false);
    cursor.offset += 2;
    return value;
  }

  function readUint32(view, cursor) {
    ensureAvailable(cursor, 4, view.byteLength);
    const value = view.getUint32(cursor.offset, false);
    cursor.offset += 4;
    return value;
  }

  function readVariableLength(view, cursor, endOffset) {
    let value = 0;
    for (let count = 0; count < 4; count += 1) {
      const byte = readUint8Within(view, cursor, endOffset);
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('El MIDI contiene un valor de longitud variable inválido.');
  }

  function systemMessageLength(status) {
    if (status === 0xf1 || status === 0xf3) return 1;
    if (status === 0xf2) return 2;
    return 0;
  }

  function ensureAvailable(cursor, length, endOffset) {
    if (length < 0 || cursor.offset + length > endOffset) throw new Error('El archivo MIDI está truncado o dañado.');
  }

  const api = { convert, parseStandardMidi, makeMonophonic };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.MidiImporter = api;
})(typeof window !== 'undefined' ? window : globalThis);
