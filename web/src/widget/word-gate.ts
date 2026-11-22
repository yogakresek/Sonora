// Lets words appear when the singer actually sings them.
//
// LRCLIB gives a time per line, so word times inside a line are only estimates. In the kinetic
// style a word that shows up early is obvious, so each word waits for the audio to show a new
// syllable starting (a jump of energy in the voice range) near its estimate. The gate also learns
// the singer's pace within the line: when a word turns out to be sung later (or earlier) than
// estimated, the rest of the line shifts by the same amount.
//   - A word may appear on a syllable from `lead` before its (shifted) estimate,
//   - and appears by `grace` after it at the latest, so soft vocals never stall the line.
//   - The first word comes on the line's own, exact time.

/** 128 log bands from 30 Hz to 16 kHz: bands 43–97 cover roughly 250 Hz – 3.5 kHz, where voices live. */
const VOICE_FIRST = 43;
const VOICE_LAST = 97;

/** Above this many onsets per second the music is "busy": onsets are mostly drums, not syllables. */
export const BUSY_RATE = 1.8;

export class VocalOnsets {
  private prev = new Float32Array(128);
  private mean = 0;
  private variance = 0.0004;
  private lastOnset = -1e9;
  private recent: number[] = [];
  /** Detected onsets per second over the last 4 s. Busy (drum-heavy) music runs ~3/s, ballads ~1/s. */
  rate = 0;

  /** Feeds one frame of bands; returns true if a syllable seems to start now. */
  update(bands: Float32Array, now: number): boolean {
    let flux = 0;
    for (let b = VOICE_FIRST; b <= VOICE_LAST && b < bands.length; b++) {
      const d = bands[b] - this.prev[b];
      if (d > 0) flux += d;
    }
    this.prev.set(bands);
    flux /= VOICE_LAST - VOICE_FIRST + 1;

    const threshold = this.mean + 1.4 * Math.sqrt(this.variance) + 0.004;
    const onset = flux > threshold && now - this.lastOnset > 110;
    if (onset) { this.lastOnset = now; this.recent.push(now); }
    while (this.recent.length && this.recent[0] < now - 4000) this.recent.shift();
    this.rate = this.recent.length / 4;

    // Adapt slowly to the song's loudness and texture.
    const a = 0.04;
    const d = flux - this.mean;
    this.mean += a * d;
    this.variance = (1 - a) * (this.variance + a * d * d);
    return onset;
  }
}

export interface GatedWord { at: number; sung: boolean }

/**
 * Estimated start time of each word in a line. LRCLIB times lines, not words, so the line's time
 * is spread over its words by length: across most of the line's real duration, at a plausible
 * singing pace of 60–170 ms per letter. (A fixed fast pace ran ahead of the singer on slow songs;
 * the cap keeps a long instrumental gap after a line from making the words late.)
 */
export function estimateWords(cur: { t: number; text: string }, next: { t: number } | undefined): { text: string; at: number }[] {
  const words = cur.text.split(/\s+/).filter(Boolean);
  const chars = words.reduce((n, w) => n + w.length + 1, 0) || 1;
  const lineMs = (next ? next.t : cur.t + 6000) - cur.t;
  const span = Math.min(lineMs * 0.95, Math.max(chars * 60, Math.min(lineMs * 0.88, chars * 170)));
  let acc = 0;
  return words.map((text) => {
    const at = cur.t + (acc / chars) * span;
    acc += text.length + 1;
    return { text, at };
  });
}

/** One line's worth of gating; make a new one for each line. */
export class WordGate {
  /** How far behind (+) or ahead (−) of the estimates the singer is in this line, in ms. */
  private lag = 0;
  private forcedAt = -1e9;

  private readonly lead: number;
  private readonly grace: number;

  constructor(lead = 250, grace = 650) {
    this.lead = lead;
    this.grace = grace;
  }

  /**
   * Reveals words strictly in order, at most one per detected syllable. Returns the indexes revealed now.
   * `busy`: the music is dense with onsets (VocalOnsets.rate high), so a missing syllable says
   * nothing about the singer's pace.
   */
  update(words: GatedWord[], pos: number, onset: boolean, busy = false): number[] {
    const revealed: number[] = [];
    let usedOnset = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.sung) continue;
      const first = i === 0;
      const at = first ? w.at : w.at + this.lag;
      const due = first ? pos >= at : pos >= at + this.grace;
      // A syllable just after a word was forced out belongs to that word, not the next one.
      const heard = !first && onset && !usedOnset && pos >= at - this.lead && pos - this.forcedAt > 250;
      if (!due && !heard) break; // later words wait for this one
      w.sung = true;
      revealed.push(i);
      if (heard) usedOnset = true;
      else if (!first) this.forcedAt = pos;
      if (!first) {
        // Learn the singer's pace: always from a syllable actually heard; from a word let through
        // by the time limit only in sparse music (a slow singer holding notes). In busy music a
        // timeout says nothing about the singer, and learning from it pushed the rest of the
        // line ~0.27 s later per word, up to 0.6 s+ late (measured on a recorded song).
        if (heard || !busy) {
          const observed = Math.max(-400, Math.min(2000, pos - w.at));
          this.lag = this.lag * 0.3 + observed * 0.7;
        } else {
          this.lag *= 0.5; // unsure: drift back towards the plain estimate
        }
      }
    }
    return revealed;
  }
}
