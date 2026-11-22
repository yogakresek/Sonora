using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Sonora.Audio;

public sealed record AudioStatus(string State, string? Device = null, int SampleRate = 0, int Channels = 0, string? Error = null)
{
    public static readonly AudioStatus Stopped = new("stopped");
}

/// <summary>
/// Captures what the PC is playing (WASAPI loopback on the default output) and publishes an
/// analysed frame ~60 times a second through <see cref="FrameReady"/>.
///
/// It only runs while someone holds a lease (<see cref="Acquire"/>): with no widget or dashboard
/// showing, there is no capture and no analysis thread at all. It follows the default output
/// device when the user switches it, and restarts itself if the device goes away.
/// </summary>
public sealed class AudioEngine : IDisposable
{
    private const double FrameRate = 60;

    private readonly object _gate = new();
    private readonly float[] _frame = new float[FrameLayout.FloatCount];
    private int _leases;
    private bool _disposed;

    private MMDeviceEnumerator? _enumerator;
    private MMDeviceNotificationClient? _notifications;
    private WasapiRecorder? _capture;
    private AudioAnalyzer? _analyzer;
    private Converter? _convert;
    private int _channels;
    private float[] _scratch = new float[4096];
    private long _lastDataTicks;

    private Thread? _frameThread;
    private volatile bool _frameRun;
    private CancellationTokenSource? _restartCts;

    /// <summary>Raised on the frame thread. The array is reused; copy what you need before returning.</summary>
    public event Action<float[]>? FrameReady;

    /// <summary>Raised on any thread.</summary>
    public event Action<AudioStatus>? StatusChanged;

    public AudioStatus Status { get; private set; } = AudioStatus.Stopped;

    public float Smoothing { get; set; } = 0.72f;
    public float Sensitivity { get; set; } = 1f;

    /// <summary>Keeps the engine running until the returned lease is disposed.</summary>
    public IDisposable Acquire()
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_leases++ == 0) StartLocked();
        }
        return new Lease(this);
    }

    private void Release()
    {
        lock (_gate)
        {
            if (_leases == 0) return;
            if (--_leases == 0) StopLocked();
        }
    }

    // ------------------------------------------------------------------ lifecycle

    private void StartLocked()
    {
        _enumerator ??= new MMDeviceEnumerator();
        if (_notifications is null)
        {
            _notifications = _enumerator.CreateNotificationClient(useSynchronizationContext: false);
            _notifications.DefaultDeviceChanged += (_, e) =>
            {
                if (e.Flow == DataFlow.Render && e.Role == Role.Multimedia) ScheduleRestart(TimeSpan.FromMilliseconds(400), "default device changed");
            };
        }

        StartCaptureLocked();
        StartFrameThreadLocked();
    }

    private void StopLocked()
    {
        _restartCts?.Cancel();
        _restartCts = null;
        StopFrameThreadLocked();
        StopCaptureLocked();
        _notifications?.Dispose();
        _notifications = null;
        SetStatus(AudioStatus.Stopped);
    }

    private void StartCaptureLocked()
    {
        StopCaptureLocked();

        if (!_enumerator!.TryGetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia, out var device) || device is null)
        {
            SetStatus(new AudioStatus("no-device"));
            ScheduleRestart(TimeSpan.FromSeconds(3), "no output device");
            return;
        }

        try
        {
            var capture = new WasapiRecorderBuilder()
                .WithDevice(device)
                .WithLoopbackCapture()
                .WithSharedMode()
                .Build();
            var format = capture.WaveFormat;
            var convert = Converter.For(format);
            if (convert is null)
            {
                capture.Dispose();
                SetStatus(new AudioStatus("error", device.FriendlyName, format.SampleRate, format.Channels,
                    $"Format tidak didukung: {format.Encoding} {format.BitsPerSample}-bit"));
                return;
            }

            _channels = format.Channels;
            _convert = convert;
            if (_analyzer is null || _analyzer.SampleRate != format.SampleRate)
                _analyzer = new AudioAnalyzer(format.SampleRate);

            capture.DataAvailable += OnData;
            capture.RecordingStopped += OnStopped;
            _capture = capture;
            _lastDataTicks = Stopwatch.GetTimestamp();
            capture.StartRecording();

            Log.Info($"Audio capture: {device.FriendlyName}, {format.SampleRate} Hz, {format.Channels} ch, {format.Encoding} {format.BitsPerSample}-bit");
            SetStatus(new AudioStatus("running", device.FriendlyName, format.SampleRate, format.Channels));
        }
        catch (Exception ex)
        {
            Log.Error("Audio capture failed to start", ex);
            StopCaptureLocked();
            SetStatus(new AudioStatus("error", device.FriendlyName, Error: ex.Message));
            ScheduleRestart(TimeSpan.FromSeconds(3), "start failed");
        }
    }

    private void StopCaptureLocked()
    {
        var capture = _capture;
        if (capture is null) return;
        _capture = null;
        capture.DataAvailable -= OnData;
        capture.RecordingStopped -= OnStopped;
        try { capture.StopRecording(); } catch { }
        capture.Dispose();
    }

    private void ScheduleRestart(TimeSpan delay, string reason)
    {
        CancellationTokenSource cts;
        lock (_gate)
        {
            if (_leases == 0 || _disposed) return;
            _restartCts?.Cancel();
            cts = _restartCts = new CancellationTokenSource();
        }

        _ = Task.Delay(delay, cts.Token).ContinueWith(_ =>
        {
            lock (_gate)
            {
                if (cts.IsCancellationRequested || _leases == 0 || _disposed) return;
                Log.Info($"Audio restart: {reason}");
                StartCaptureLocked();
            }
        }, TaskContinuationOptions.OnlyOnRanToCompletion);
    }

    // ------------------------------------------------------------------ capture thread

    private void OnData(ReadOnlySpan<byte> buffer, AudioClientBufferFlags flags, long devicePosition, long qpcPosition)
    {
        var analyzer = _analyzer;
        var convert = _convert;
        if (analyzer is null || convert is null || buffer.Length <= 0) return;

        int samples = convert.SampleCount(buffer.Length);
        if ((flags & AudioClientBufferFlags.Silent) != 0)
        {
            analyzer.FeedSilence(samples / Math.Max(1, _channels));
        }
        else
        {
            if (_scratch.Length < samples) _scratch = new float[samples];
            convert.Convert(buffer, _scratch);
            analyzer.Feed(_scratch.AsSpan(0, samples), _channels);
        }
        Interlocked.Exchange(ref _lastDataTicks, Stopwatch.GetTimestamp());
    }

    private void OnStopped(object? sender, StoppedEventArgs e)
    {
        if (e.Exception is null) return;
        Log.Error("Audio capture stopped", e.Exception);
        SetStatus(Status with { State = "error", Error = e.Exception.Message });
        ScheduleRestart(TimeSpan.FromSeconds(1), "device lost");
    }

    // ------------------------------------------------------------------ frame thread

    private void StartFrameThreadLocked()
    {
        if (_frameThread is not null) return;
        _frameRun = true;
        _frameThread = new Thread(FrameLoop) { IsBackground = true, Name = "Sonora audio frames", Priority = ThreadPriority.AboveNormal };
        _frameThread.Start();
    }

    private void StopFrameThreadLocked()
    {
        var thread = _frameThread;
        if (thread is null) return;
        _frameRun = false;
        _frameThread = null;
        // The loop never takes _gate and wakes every frame, so this returns within ~17 ms.
        thread.Join(500);
    }

    private void FrameLoop()
    {
        using var timer = new PreciseTimer();
        long period = (long)(Stopwatch.Frequency / FrameRate);
        long next = Stopwatch.GetTimestamp();

        while (_frameRun)
        {
            next += period;
            long now = Stopwatch.GetTimestamp();
            if (next < now - period) next = now; // fell behind (sleep, debugger): don't try to catch up
            timer.WaitUntil(next);

            var analyzer = _analyzer;
            if (analyzer is null) continue;

            // Loopback delivers nothing while nothing plays: keep the clock moving with silence.
            long sinceData = Stopwatch.GetTimestamp() - Interlocked.Read(ref _lastDataTicks);
            if (sinceData > Stopwatch.Frequency / 20)
            {
                analyzer.FeedSilence((int)(analyzer.SampleRate / FrameRate));
            }

            analyzer.Smoothing = Smoothing;
            analyzer.Sensitivity = Sensitivity;
            analyzer.Analyze(_frame);

            try { FrameReady?.Invoke(_frame); }
            catch (Exception ex) { Log.Error("FrameReady handler failed", ex); }
        }
    }

    // ------------------------------------------------------------------ misc

    private void SetStatus(AudioStatus status)
    {
        if (status == Status) return;
        Status = status;
        try { StatusChanged?.Invoke(status); }
        catch (Exception ex) { Log.Error("StatusChanged handler failed", ex); }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _leases = 0;
            StopLocked();
            _disposed = true;
        }
        _enumerator?.Dispose();
    }

    private sealed class Lease(AudioEngine owner) : IDisposable
    {
        private int _done;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _done, 1) == 0) owner.Release();
        }
    }

    /// <summary>Converts the device's mix format to float32.</summary>
    private abstract class Converter
    {
        // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT / KSDATAFORMAT_SUBTYPE_PCM
        private static readonly Guid SubtypeIeeeFloat = new("00000003-0000-0010-8000-00aa00389b71");
        private static readonly Guid SubtypePcm = new("00000001-0000-0010-8000-00aa00389b71");

        public abstract int SampleCount(int bytes);
        public abstract void Convert(ReadOnlySpan<byte> src, Span<float> dst);

        public static Converter? For(WaveFormat f)
        {
            bool isFloat = f.Encoding == WaveFormatEncoding.IeeeFloat
                || (f is WaveFormatExtensible x && x.SubFormat == SubtypeIeeeFloat);
            bool isPcm = f.Encoding == WaveFormatEncoding.Pcm
                || (f is WaveFormatExtensible y && y.SubFormat == SubtypePcm);

            if (isFloat && f.BitsPerSample == 32) return new Float32();
            if (isPcm && f.BitsPerSample == 16) return new Pcm16();
            if (isPcm && f.BitsPerSample == 24) return new Pcm24();
            if (isPcm && f.BitsPerSample == 32) return new Pcm32();
            return null;
        }

        private sealed class Float32 : Converter
        {
            public override int SampleCount(int bytes) => bytes / 4;
            public override void Convert(ReadOnlySpan<byte> src, Span<float> dst) =>
                MemoryMarshal.Cast<byte, float>(src[..(src.Length / 4 * 4)]).CopyTo(dst);
        }

        private sealed class Pcm16 : Converter
        {
            public override int SampleCount(int bytes) => bytes / 2;
            public override void Convert(ReadOnlySpan<byte> src, Span<float> dst)
            {
                var s = MemoryMarshal.Cast<byte, short>(src[..(src.Length / 2 * 2)]);
                for (int i = 0; i < s.Length; i++) dst[i] = s[i] / 32768f;
            }
        }

        private sealed class Pcm24 : Converter
        {
            public override int SampleCount(int bytes) => bytes / 3;
            public override void Convert(ReadOnlySpan<byte> src, Span<float> dst)
            {
                int n = src.Length / 3;
                for (int i = 0; i < n; i++)
                {
                    int v = (src[i * 3] << 8) | (src[i * 3 + 1] << 16) | (src[i * 3 + 2] << 24);
                    dst[i] = (v >> 8) / 8388608f;
                }
            }
        }

        private sealed class Pcm32 : Converter
        {
            public override int SampleCount(int bytes) => bytes / 4;
            public override void Convert(ReadOnlySpan<byte> src, Span<float> dst)
            {
                var s = MemoryMarshal.Cast<byte, int>(src[..(src.Length / 4 * 4)]);
                for (int i = 0; i < s.Length; i++) dst[i] = s[i] / 2147483648f;
            }
        }
    }
}
