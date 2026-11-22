using Sonora.Audio;

namespace Sonora.Tests;

public class AudioAnalyzerTests
{
    private const int Rate = 48000;
    private const int PerFrame = Rate / 60;

    /// <summary>Feeds a mono signal in 60 Hz chunks, analysing after each, and returns the last frame.</summary>
    private static float[] Run(AudioAnalyzer analyzer, Func<int, float> signal, double seconds, Action<float[]>? eachFrame = null)
    {
        var frame = new float[FrameLayout.FloatCount];
        var chunk = new float[PerFrame];
        int total = (int)(seconds * Rate);
        for (int start = 0; start < total; start += PerFrame)
        {
            for (int i = 0; i < PerFrame; i++) chunk[i] = signal(start + i);
            analyzer.Feed(chunk, channels: 1);
            analyzer.Analyze(frame);
            eachFrame?.Invoke(frame);
        }
        return frame;
    }

    /// <summary>A kick drum: a 55 Hz thump with a fast decay, every 60/bpm seconds, over quiet noise.</summary>
    private static Func<int, float> Kicks(double bpm)
    {
        var rng = new Random(1);
        double period = 60.0 / bpm;
        return n =>
        {
            double t = (double)n / Rate;
            double since = t % period;
            double kick = Math.Sin(2 * Math.PI * 55 * since) * Math.Exp(-since * 18);
            double noise = (rng.NextDouble() * 2 - 1) * 0.02;
            return (float)(kick * 0.8 + noise);
        };
    }

    [Theory]
    [InlineData(100)]
    [InlineData(120)]
    [InlineData(128)]
    [InlineData(140)]
    public void Finds_the_tempo_of_a_steady_kick(double bpm)
    {
        var frame = Run(new AudioAnalyzer(Rate), Kicks(bpm), seconds: 12);

        Assert.InRange(frame[FrameLayout.Bpm], bpm * 0.97, bpm * 1.03);
        Assert.True(frame[FrameLayout.BpmConfidence] > 0.2, $"confidence {frame[FrameLayout.BpmConfidence]}");
    }

    [Fact]
    public void Counts_one_kick_per_beat()
    {
        var frame = Run(new AudioAnalyzer(Rate), Kicks(120), seconds: 10);

        // 20 beats in 10 s; allow one either side for the edges.
        Assert.InRange(frame[FrameLayout.KickCount], 19, 21);
    }

    [Fact]
    public void A_pure_tone_peaks_in_the_right_band()
    {
        var frame = Run(new AudioAnalyzer(Rate), n => (float)(0.5 * Math.Sin(2 * Math.PI * 1000 * n / Rate)), seconds: 1);

        int best = 0;
        for (int b = 1; b < FrameLayout.Bands; b++)
            if (frame[FrameLayout.BandsOffset + b] > frame[FrameLayout.BandsOffset + best]) best = b;

        // Band centres are log-spaced 30 Hz..16 kHz.
        double lo = 30 * Math.Pow(16000.0 / 30, (double)best / FrameLayout.Bands);
        double hi = 30 * Math.Pow(16000.0 / 30, (double)(best + 1) / FrameLayout.Bands);
        Assert.InRange(1000, lo * 0.9, hi * 1.1);
        Assert.True(frame[FrameLayout.BandsOffset + best] > 0.8);
        Assert.Equal(0f, frame[FrameLayout.Silent]);
    }

    [Fact]
    public void Silence_is_dark_and_flagged()
    {
        var analyzer = new AudioAnalyzer(Rate);
        Run(analyzer, Kicks(120), seconds: 3);
        var frame = Run(analyzer, _ => 0f, seconds: 2);

        Assert.Equal(1f, frame[FrameLayout.Silent]);
        for (int b = 0; b < FrameLayout.Bands; b++)
            Assert.True(frame[FrameLayout.BandsOffset + b] < 0.02, $"band {b} = {frame[FrameLayout.BandsOffset + b]}");
    }

    [Fact]
    public void Beat_phase_wraps_once_per_beat()
    {
        int wraps = 0;
        float previous = 0;
        var analyzer = new AudioAnalyzer(Rate);
        Run(analyzer, Kicks(120), seconds: 8); // settle
        Run(analyzer, Kicks(120), seconds: 5, f =>
        {
            float phase = f[FrameLayout.BeatPhase];
            if (phase < previous - 0.5f) wraps++;
            previous = phase;
        });

        Assert.InRange(wraps, 9, 11); // 10 beats in 5 s
    }

    [Fact]
    public void Fft_matches_a_known_bin()
    {
        var fft = new Fft(64);
        var re = new float[64];
        var im = new float[64];
        for (int i = 0; i < 64; i++) re[i] = (float)Math.Cos(2 * Math.PI * 5 * i / 64);
        fft.Forward(re, im);

        Assert.Equal(32, Math.Sqrt(re[5] * re[5] + im[5] * im[5]), 3);
        Assert.Equal(0, Math.Sqrt(re[6] * re[6] + im[6] * im[6]), 3);
    }
}
