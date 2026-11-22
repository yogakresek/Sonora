namespace Sonora.Audio;

/// <summary>
/// Layout of one analysed audio frame, shared byte-for-byte with the web side (web/src/audio.ts).
///
/// Shared memory: a 16-byte header of int32 [seq, layoutVersion, bandCount, waveLength],
/// then <see cref="FloatCount"/> float32 values. The writer bumps seq to odd before writing
/// and to even after (a seqlock), so a reader that sees the same even seq before and after
/// copying has a consistent frame.
/// </summary>
public static class FrameLayout
{
    public const int Version = 1;
    public const int HeaderBytes = 16;

    public const int Bands = 128;
    public const int WaveLength = 1024;

    // Scalar slots.
    public const int Time = 0;          // seconds since the engine started
    public const int Rms = 1;           // linear, 0..1
    public const int Peak = 2;          // linear, 0..1
    public const int LoudnessDb = 3;    // dBFS of Rms
    public const int Kick = 4;          // envelope: 1 on a kick, decays to 0
    public const int KickCount = 5;     // increments once per detected kick
    public const int Bpm = 6;           // 0 when unknown
    public const int BpmConfidence = 7; // 0..1
    public const int BeatPhase = 8;     // 0..1, 0 = on the beat
    public const int Silent = 9;        // 1 when nothing is playing
    public const int Centroid = 10;     // spectral brightness, 0..1 (log 100 Hz..8 kHz)
    public const int Flatness = 11;     // 0 tonal .. 1 noisy
    public const int Low = 12;          // mean band level < 250 Hz, 0..1
    public const int Mid = 13;          // 250 Hz..2 kHz
    public const int High = 14;         // > 2 kHz
    public const int SampleRate = 15;
    public const int ScalarCount = 16;

    public const int BandsOffset = ScalarCount;
    public const int WaveOffset = BandsOffset + Bands;      // mono
    public const int WaveLOffset = WaveOffset + WaveLength;
    public const int WaveROffset = WaveLOffset + WaveLength;
    public const int FloatCount = WaveROffset + WaveLength;

    public const int TotalBytes = HeaderBytes + FloatCount * sizeof(float);
}
