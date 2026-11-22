// Reads analysed audio frames from the host's shared buffer.
// Layout mirrors host/Sonora.Host/Audio/FrameLayout.cs — keep the two in step.

import { onSharedBuffer, releaseBuffer, type SharedBufferMeta } from './bridge';

const LAYOUT_VERSION = 1;

const S = {
  time: 0, rms: 1, peak: 2, loudnessDb: 3, kick: 4, kickCount: 5, bpm: 6, bpmConfidence: 7,
  beatPhase: 8, silent: 9, centroid: 10, flatness: 11, low: 12, mid: 13, high: 14, sampleRate: 15,
} as const;
const SCALARS = 16;

export interface AudioFrame {
  time: number;
  rms: number;
  peak: number;
  loudnessDb: number;
  /** 1 on a kick, decays to 0. */
  kick: number;
  /** Increments once per kick; compare with the previous frame to catch every one. */
  kickCount: number;
  /** 0 when unknown. */
  bpm: number;
  bpmConfidence: number;
  /** 0..1, 0 = on the beat. */
  beatPhase: number;
  silent: boolean;
  centroid: number;
  flatness: number;
  low: number;
  mid: number;
  high: number;
  sampleRate: number;
  /** 0..1 per band, log-spaced 30 Hz..16 kHz. */
  bands: Float32Array;
  /** Latest samples, -1..1. */
  wave: Float32Array;
  waveL: Float32Array;
  waveR: Float32Array;
}

export class AudioReader {
  private buffer: ArrayBuffer | null = null;
  private seq: Int32Array | null = null;
  private data: Float32Array | null = null;
  private copy = new Float32Array(0);
  private meta: SharedBufferMeta | null = null;
  readonly frame: AudioFrame;
  connected = false;

  constructor() {
    this.frame = emptyFrame(128, 1024);
    onSharedBuffer((buffer, meta) => this.attach(buffer, meta));
  }

  private attach(buffer: ArrayBuffer, meta: SharedBufferMeta): void {
    if (meta.layout !== LAYOUT_VERSION) {
      console.warn(`Audio layout ${meta.layout} not supported (expected ${LAYOUT_VERSION})`);
      releaseBuffer(buffer);
      return;
    }
    if (this.buffer && this.buffer !== buffer) releaseBuffer(this.buffer);
    this.buffer = buffer;
    this.meta = meta;
    this.seq = new Int32Array(buffer, 0, 4);
    this.data = new Float32Array(buffer, meta.headerBytes, meta.floatCount);
    this.copy = new Float32Array(meta.floatCount);
    Object.assign(this.frame, emptyFrame(meta.bands, meta.waveLength));
    this.connected = true;
  }

  /** Copies the latest complete frame into `this.frame`. Returns false if none was available. */
  read(): boolean {
    const { seq, data, meta } = this;
    if (!seq || !data || !meta) return false;

    // Seqlock: retry if the host was mid-write.
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = seq[0];
      if (before & 1) continue;
      this.copy.set(data);
      if (seq[0] === before) {
        this.unpack(meta);
        return true;
      }
    }
    return false;
  }

  private unpack(meta: SharedBufferMeta): void {
    const c = this.copy;
    const f = this.frame;
    f.time = c[S.time];
    f.rms = c[S.rms];
    f.peak = c[S.peak];
    f.loudnessDb = c[S.loudnessDb];
    f.kick = c[S.kick];
    f.kickCount = c[S.kickCount];
    f.bpm = c[S.bpm];
    f.bpmConfidence = c[S.bpmConfidence];
    f.beatPhase = c[S.beatPhase];
    f.silent = c[S.silent] > 0.5;
    f.centroid = c[S.centroid];
    f.flatness = c[S.flatness];
    f.low = c[S.low];
    f.mid = c[S.mid];
    f.high = c[S.high];
    f.sampleRate = c[S.sampleRate];

    const bands = SCALARS;
    const wave = bands + meta.bands;
    const waveL = wave + meta.waveLength;
    const waveR = waveL + meta.waveLength;
    f.bands.set(c.subarray(bands, wave));
    f.wave.set(c.subarray(wave, waveL));
    f.waveL.set(c.subarray(waveL, waveR));
    f.waveR.set(c.subarray(waveR, waveR + meta.waveLength));
  }
}

function emptyFrame(bands: number, waveLength: number): AudioFrame {
  return {
    time: 0, rms: 0, peak: 0, loudnessDb: -120, kick: 0, kickCount: 0, bpm: 0, bpmConfidence: 0,
    beatPhase: 0, silent: true, centroid: 0, flatness: 0, low: 0, mid: 0, high: 0, sampleRate: 0,
    bands: new Float32Array(bands),
    wave: new Float32Array(waveLength),
    waveL: new Float32Array(waveLength),
    waveR: new Float32Array(waveLength),
  };
}
