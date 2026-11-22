namespace Sonora.Audio;

/// <summary>
/// Turns a stream of samples into <see cref="FrameLayout"/> frames.
///
/// Two clocks run here:
/// - <see cref="Feed"/> (capture thread) stores samples in a ring and runs the kick detector
///   on every ~10 ms hop, so onsets are judged on the audio's own timeline.
/// - <see cref="Analyze"/> (frame thread, ~60 Hz) takes the latest window for the spectrum,
///   levels, tempo and the other per-frame values.
/// Everything shares one lock; both sides hold it only briefly.
/// </summary>
public sealed class AudioAnalyzer
{
    private const int RingSize = 8192;          // power of two
    private const int RingMask = RingSize - 1;
    private const int FftSize = 4096;           // ~85 ms at 48 kHz, ~11.7 Hz per bin
    private const int OnsetLength = 1024;       // ~11 s of onset history at ~94 hops/s
    private const double MinFreq = 30, MaxFreq = 16000;
    private const double RangeDb = 45;          // dynamic range shown, below the adaptive ceiling
    private const double CeilFloorDb = -42;     // the ceiling never drops below this, so hiss stays dark

    private readonly object _gate = new();
    private readonly int _sampleRate;

    // Sample rings (mono, left, right).
    private readonly float[] _ringM = new float[RingSize];
    private readonly float[] _ringL = new float[RingSize];
    private readonly float[] _ringR = new float[RingSize];
    private int _pos;
    private long _totalSamples;

    // Kick detection, per hop.
    private readonly int _hop;
    private readonly double _hopRate;
    private Biquad _kickFilter;
    private double _hopEnergy;
    private int _hopFill;
    private long _hopIndex;
    private double _fastLogE = -120;
    private double _fluxMean, _fluxVar = 1;
    private long _lastKickHop = -100_000;
    private int _kickCount;
    private readonly float[] _onset = new float[OnsetLength];
    private int _onsetPos, _onsetFilled;

    // Tempo.
    private double _bpm, _bpmConfidence, _bpmCandidate;
    private int _bpmCandidateHits;
    private double _lastTempoAt = -10, _lowConfidenceFor;
    private double _beatAnchor, _lastAlignedKick;

    // Spectrum.
    private readonly Fft _fft = new(FftSize);
    private readonly float[] _re = new float[FftSize], _im = new float[FftSize];
    private readonly float[] _window = new float[FftSize];
    private readonly float _windowSum;
    private readonly float[] _mag = new float[FftSize / 2];
    private readonly float[] _bandLo = new float[FrameLayout.Bands];
    private readonly float[] _bandHi = new float[FrameLayout.Bands];
    private readonly float[] _bandFreq = new float[FrameLayout.Bands];
    private readonly float[] _bandTilt = new float[FrameLayout.Bands];
    private readonly float[] _bandDb = new float[FrameLayout.Bands];
    private readonly float[] _bands = new float[FrameLayout.Bands];
    private double _ceilDb = -30;

    // Per-frame state.
    private double _lastAnalyzeTime = -1;
    private int _seenKicks;
    private float _kickEnv;
    private double _silentFor;

    /// <summary>0 = twitchy, 0.95 = very calm. How slowly bars fall.</summary>
    public float Smoothing { get; set; } = 0.72f;

    /// <summary>Raises (or lowers) every level; 1 = neutral.</summary>
    public float Sensitivity { get; set; } = 1f;

    public int SampleRate => _sampleRate;

    public AudioAnalyzer(int sampleRate)
    {
        _sampleRate = sampleRate;
        _hop = Math.Max(128, (int)Math.Round(512.0 * sampleRate / 48000));
        _hopRate = (double)sampleRate / _hop;
        _kickFilter = Biquad.LowPass(sampleRate, 150, 0.707);

        float sum = 0;
        for (int i = 0; i < FftSize; i++)
        {
            _window[i] = (float)(0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (FftSize - 1)));
            sum += _window[i];
        }
        _windowSum = sum;

        double maxF = Math.Min(MaxFreq, sampleRate * 0.47);
        double binHz = (double)sampleRate / FftSize;
        for (int b = 0; b < FrameLayout.Bands; b++)
        {
            double lo = MinFreq * Math.Pow(maxF / MinFreq, (double)b / FrameLayout.Bands);
            double hi = MinFreq * Math.Pow(maxF / MinFreq, (double)(b + 1) / FrameLayout.Bands);
            double fc = Math.Sqrt(lo * hi);
            _bandLo[b] = (float)(lo / binHz);
            _bandHi[b] = (float)(hi / binHz);
            _bandFreq[b] = (float)fc;
            _bandTilt[b] = (float)(3.0 * Math.Log2(fc / 1000.0)); // +3 dB/octave so highs read like lows
        }
    }

    // ---------------------------------------------------------------- capture side

    /// <summary>Adds interleaved float samples (any channel count).</summary>
    public void Feed(ReadOnlySpan<float> interleaved, int channels)
    {
        if (channels < 1) return;
        int frames = interleaved.Length / channels;
        float inv = 1f / channels;
        lock (_gate)
        {
            for (int f = 0; f < frames; f++)
            {
                int o = f * channels;
                float l = interleaved[o];
                float r = channels > 1 ? interleaved[o + 1] : l;
                float m = 0;
                for (int c = 0; c < channels; c++) m += interleaved[o + c];
                Push(m * inv, l, r);
            }
        }
    }

    /// <summary>Advances the clock with silence (loopback sends nothing while nothing plays).</summary>
    public void FeedSilence(int frames)
    {
        lock (_gate)
        {
            for (int i = 0; i < frames; i++) Push(0, 0, 0);
        }
    }

    private void Push(float m, float l, float r)
    {
        _ringM[_pos] = m;
        _ringL[_pos] = l;
        _ringR[_pos] = r;
        _pos = (_pos + 1) & RingMask;
        _totalSamples++;

        double y = _kickFilter.Process(m);
        _hopEnergy += y * y;
        if (++_hopFill == _hop) ProcessHop();
    }

    private void ProcessHop()
    {
        double e = _hopEnergy / _hop;
        _hopEnergy = 0;
        _hopFill = 0;

        double logE = 10 * Math.Log10(e + 1e-12);
        double flux = Math.Max(0, logE - _fastLogE);
        _fastLogE = _fastLogE * 0.7 + logE * 0.3;

        _onset[_onsetPos] = (float)flux;
        _onsetPos = (_onsetPos + 1) % OnsetLength;
        if (_onsetFilled < OnsetLength) _onsetFilled++;

        double threshold = _fluxMean + 1.8 * Math.Sqrt(_fluxVar) + 0.5;
        long minGap = (long)(0.2 * _hopRate);
        if (flux > threshold && logE > -55 && _hopIndex - _lastKickHop >= minGap)
        {
            _lastKickHop = _hopIndex;
            _kickCount++;
            OnKick((double)(_hopIndex + 1) * _hop / _sampleRate);
        }

        double a = 1.0 / (_hopRate * 1.5);
        double d = flux - _fluxMean;
        _fluxMean += a * d;
        _fluxVar = (1 - a) * (_fluxVar + a * d * d);

        _hopIndex++;
    }

    private void OnKick(double t)
    {
        if (_bpm <= 0)
        {
            _beatAnchor = t;
            _lastAlignedKick = t;
            return;
        }

        // Pull the beat grid towards kicks that land near it; ignore off-beat ones.
        double period = 60.0 / _bpm;
        double err = (t - _beatAnchor) / period;
        err -= Math.Round(err);
        if (Math.Abs(err) < 0.2)
        {
            _beatAnchor += err * period * 0.5;
            _lastAlignedKick = t;
        }
        else if (t - _lastAlignedKick > 2.0)
        {
            _beatAnchor = t;
            _lastAlignedKick = t;
        }
    }

    // ---------------------------------------------------------------- frame side

    /// <summary>Writes the current frame into <paramref name="frame"/> (length <see cref="FrameLayout.FloatCount"/>).</summary>
    public void Analyze(float[] frame)
    {
        lock (_gate)
        {
            double t = (double)_totalSamples / _sampleRate;
            double dt = _lastAnalyzeTime < 0 ? 1.0 / 60 : Math.Clamp(t - _lastAnalyzeTime, 0, 0.25);
            _lastAnalyzeTime = t;

            Spectrum();
            Levels(frame, dt);
            Bands(frame, dt);
            Kick(frame, dt);
            Tempo(frame, t, dt);
            Timbre(frame);
            Waves(frame);

            frame[FrameLayout.Time] = (float)t;
            frame[FrameLayout.SampleRate] = _sampleRate;
        }
    }

    private void Spectrum()
    {
        int start = (_pos - FftSize) & RingMask;
        for (int i = 0; i < FftSize; i++)
        {
            _re[i] = _ringM[(start + i) & RingMask] * _window[i];
            _im[i] = 0;
        }
        _fft.Forward(_re, _im);

        float scale = 2f / _windowSum;
        for (int k = 0; k < _mag.Length; k++)
            _mag[k] = MathF.Sqrt(_re[k] * _re[k] + _im[k] * _im[k]) * scale;
    }

    private void Levels(float[] frame, double dt)
    {
        int n = Math.Min(RingSize, Math.Max(256, _sampleRate / 60));
        int start = (_pos - n) & RingMask;
        double sum = 0;
        float peak = 0;
        for (int i = 0; i < n; i++)
        {
            float v = _ringM[(start + i) & RingMask];
            sum += v * v;
            float a = MathF.Abs(v);
            if (a > peak) peak = a;
        }
        double rms = Math.Sqrt(sum / n);

        _silentFor = rms < 0.0005 ? _silentFor + dt : 0;

        frame[FrameLayout.Rms] = (float)Math.Min(1, rms);
        frame[FrameLayout.Peak] = Math.Min(1, peak);
        frame[FrameLayout.LoudnessDb] = (float)Math.Max(-120, 20 * Math.Log10(rms + 1e-9));
        frame[FrameLayout.Silent] = _silentFor > 0.4 ? 1 : 0;
    }

    private void Bands(float[] frame, double dt)
    {
        double frameMax = -200;
        for (int b = 0; b < FrameLayout.Bands; b++)
        {
            float lo = _bandLo[b], hi = _bandHi[b];
            double m;
            if (hi - lo < 1)
            {
                // Narrower than a bin: interpolate at the centre.
                double c = (lo + hi) * 0.5;
                int i = (int)c;
                double f = c - i;
                m = _mag[Math.Min(i, _mag.Length - 1)] * (1 - f) + _mag[Math.Min(i + 1, _mag.Length - 1)] * f;
            }
            else
            {
                int i0 = (int)MathF.Ceiling(lo), i1 = Math.Min((int)hi, _mag.Length - 1);
                double p = 0;
                int count = 0;
                for (int i = i0; i <= i1; i++) { p += _mag[i] * _mag[i]; count++; }
                m = count > 0 ? Math.Sqrt(p / count) : 0;
            }

            double db = 20 * Math.Log10(m + 1e-9) + _bandTilt[b];
            _bandDb[b] = (float)db;
            if (db > frameMax) frameMax = db;
        }

        // Adaptive ceiling: jumps up with loud music, drifts down 4 dB/s in quiet passages.
        if (frameMax > _ceilDb) _ceilDb += (frameMax - _ceilDb) * 0.6;
        else _ceilDb -= 4 * dt;
        _ceilDb = Math.Max(_ceilDb, CeilFloorDb);

        double floor = _ceilDb - RangeDb;
        float fall = MathF.Pow(Math.Clamp(Smoothing, 0f, 0.98f), (float)(dt * 60));
        float rise = (float)Math.Min(1, 0.65 * dt * 60);
        float sens = Math.Clamp(Sensitivity, 0.1f, 4f);

        double low = 0, mid = 0, high = 0;
        int nLow = 0, nMid = 0, nHigh = 0;
        for (int b = 0; b < FrameLayout.Bands; b++)
        {
            float lvl = (float)Math.Clamp((_bandDb[b] - floor) / RangeDb, 0, 1);
            lvl = Math.Min(1, MathF.Pow(lvl, 1.6f) * sens);

            float v = _bands[b];
            v = lvl > v ? v + (lvl - v) * rise : v * fall + lvl * (1 - fall);
            _bands[b] = v;
            frame[FrameLayout.BandsOffset + b] = v;

            float fc = _bandFreq[b];
            if (fc < 250) { low += v; nLow++; }
            else if (fc < 2000) { mid += v; nMid++; }
            else { high += v; nHigh++; }
        }

        frame[FrameLayout.Low] = nLow > 0 ? (float)(low / nLow) : 0;
        frame[FrameLayout.Mid] = nMid > 0 ? (float)(mid / nMid) : 0;
        frame[FrameLayout.High] = nHigh > 0 ? (float)(high / nHigh) : 0;
    }

    private void Kick(float[] frame, double dt)
    {
        if (_kickCount != _seenKicks)
        {
            _seenKicks = _kickCount;
            _kickEnv = 1;
        }
        else
        {
            _kickEnv *= (float)Math.Exp(-dt / 0.12);
        }
        frame[FrameLayout.Kick] = _kickEnv;
        frame[FrameLayout.KickCount] = _kickCount;
    }

    private void Tempo(float[] frame, double t, double dt)
    {
        if (t - _lastTempoAt >= 1.0)
        {
            _lastTempoAt = t;
            EstimateTempo(dt);
        }

        double phase = 0;
        if (_bpm > 0)
        {
            double period = 60.0 / _bpm;
            phase = (t - _beatAnchor) / period;
            phase -= Math.Floor(phase);
        }

        frame[FrameLayout.Bpm] = (float)_bpm;
        frame[FrameLayout.BpmConfidence] = (float)_bpmConfidence;
        frame[FrameLayout.BeatPhase] = (float)phase;
    }

    private void EstimateTempo(double dt)
    {
        int n = Math.Min(_onsetFilled, (int)(8 * _hopRate));
        if (n < 4 * _hopRate || _silentFor > 1)
        {
            if (_silentFor > 3) { _bpm = 0; _bpmConfidence = 0; }
            return;
        }

        Span<float> x = n <= 1024 ? stackalloc float[n] : new float[n];
        double mean = 0;
        for (int i = 0; i < n; i++)
        {
            x[i] = _onset[(_onsetPos - n + i + OnsetLength) % OnsetLength];
            mean += x[i];
        }
        mean /= n;
        double r0 = 0;
        for (int i = 0; i < n; i++) { x[i] -= (float)mean; r0 += x[i] * x[i]; }
        r0 /= n;
        if (r0 <= 1e-9) return;

        int lagMin = (int)Math.Floor(_hopRate * 60 / 180);
        int lagMax = (int)Math.Ceiling(_hopRate * 60 / 70);
        Span<double> r = stackalloc double[lagMax + 2];
        int bestLag = -1;
        double bestScore = 0;
        for (int lag = lagMin - 1; lag <= lagMax + 1; lag++)
        {
            double s = 0;
            for (int i = lag; i < n; i++) s += x[i] * x[i - lag];
            r[lag] = s / (n - lag);
            if (lag < lagMin || lag > lagMax) continue;

            double bpm = 60 * _hopRate / lag;
            double w = Math.Log2(bpm / 120) / 0.6;
            double score = r[lag] * Math.Exp(-0.5 * w * w); // prefer tempos near 120
            if (score > bestScore) { bestScore = score; bestLag = lag; }
        }
        if (bestLag < 0) return;

        // Parabolic interpolation for a sub-hop lag.
        double y0 = r[bestLag - 1], y1 = r[bestLag], y2 = r[bestLag + 1];
        double denom = y0 - 2 * y1 + y2;
        double shift = Math.Abs(denom) > 1e-12 ? Math.Clamp(0.5 * (y0 - y2) / denom, -0.5, 0.5) : 0;
        double estimate = 60 * _hopRate / (bestLag + shift);
        double confidence = Math.Clamp(y1 / r0, 0, 1);

        if (confidence < 0.12)
        {
            _lowConfidenceFor += 1;
            _bpmConfidence *= 0.8;
            if (_lowConfidenceFor > 5) { _bpm = 0; _bpmConfidence = 0; }
            return;
        }
        _lowConfidenceFor = 0;

        if (_bpm > 0 && Math.Abs(estimate - _bpm) / _bpm < 0.04)
        {
            _bpm = _bpm * 0.8 + estimate * 0.2;
            _bpmConfidence = _bpmConfidence * 0.7 + confidence * 0.3;
            _bpmCandidateHits = 0;
        }
        else if (_bpm <= 0)
        {
            _bpm = estimate;
            _bpmConfidence = confidence;
        }
        else
        {
            // A different tempo has to show up twice in a row before we switch.
            if (_bpmCandidate > 0 && Math.Abs(estimate - _bpmCandidate) / _bpmCandidate < 0.04) _bpmCandidateHits++;
            else { _bpmCandidate = estimate; _bpmCandidateHits = 1; }

            if (_bpmCandidateHits >= 2)
            {
                _bpm = estimate;
                _bpmConfidence = confidence;
                _bpmCandidateHits = 0;
            }
        }
    }

    private void Timbre(float[] frame)
    {
        double binHz = (double)_sampleRate / FftSize;
        int k0 = (int)(100 / binHz), k1 = Math.Min(_mag.Length - 1, (int)(8000 / binHz));
        double sumMag = 0, sumWeighted = 0, sumLog = 0, sumPow = 0;
        int count = 0;
        for (int k = k0; k <= k1; k++)
        {
            double m = _mag[k];
            double p = m * m + 1e-14;
            sumMag += m;
            sumWeighted += m * Math.Log(k * binHz);
            sumLog += Math.Log(p);
            sumPow += p;
            count++;
        }

        float centroid = 0, flatness = 0;
        if (sumMag > 1e-6 && count > 0)
        {
            double logCentroid = sumWeighted / sumMag; // log-frequency centroid
            centroid = (float)Math.Clamp((logCentroid - Math.Log(100)) / (Math.Log(8000) - Math.Log(100)), 0, 1);
            flatness = (float)Math.Clamp(Math.Exp(sumLog / count) / (sumPow / count), 0, 1);
        }
        frame[FrameLayout.Centroid] = centroid;
        frame[FrameLayout.Flatness] = flatness;
    }

    private void Waves(float[] frame)
    {
        int start = (_pos - FrameLayout.WaveLength) & RingMask;
        for (int i = 0; i < FrameLayout.WaveLength; i++)
        {
            int j = (start + i) & RingMask;
            frame[FrameLayout.WaveOffset + i] = _ringM[j];
            frame[FrameLayout.WaveLOffset + i] = _ringL[j];
            frame[FrameLayout.WaveROffset + i] = _ringR[j];
        }
    }

    /// <summary>Transposed direct-form II biquad.</summary>
    private struct Biquad
    {
        private double _b0, _b1, _b2, _a1, _a2, _z1, _z2;

        public static Biquad LowPass(double sampleRate, double freq, double q)
        {
            double w0 = 2 * Math.PI * freq / sampleRate;
            double cos = Math.Cos(w0), alpha = Math.Sin(w0) / (2 * q);
            double a0 = 1 + alpha;
            return new Biquad
            {
                _b0 = (1 - cos) / 2 / a0,
                _b1 = (1 - cos) / a0,
                _b2 = (1 - cos) / 2 / a0,
                _a1 = -2 * cos / a0,
                _a2 = (1 - alpha) / a0,
            };
        }

        public double Process(double x)
        {
            double y = _b0 * x + _z1;
            _z1 = _b1 * x - _a1 * y + _z2;
            _z2 = _b2 * x - _a2 * y;
            return y;
        }
    }
}
