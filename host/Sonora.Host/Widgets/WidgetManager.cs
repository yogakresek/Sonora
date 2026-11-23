using System.Text.Json;
using System.Text.Json.Nodes;
using Sonora.Audio;
using Sonora.Content;
using Sonora.Desktop;
using Sonora.Media;
using Sonora.Settings;

namespace Sonora.Widgets;

public sealed record WidgetInfo(string Id, string Name, string Description, int Width, int Height, bool KeepAspect);

/// <summary>
/// Creates, places and feeds the desktop widgets according to settings. Audio runs only while at
/// least one widget is on screen. Rebuilds everything if Explorer restarts.
/// </summary>
public sealed class WidgetManager : IDisposable
{
    public static readonly WidgetInfo[] Catalog =
    [
        new("cover", "Visualizer", "Cover lagu yang sedang diputar, dengan spektrum yang bergerak mengikuti musik.", 380, 380, true),
        new("lyrics", "Lirik", "Lirik yang berjalan seirama lagu; kata yang sedang dinyanyikan menyala.", 640, 240, false),
        new("queue", "Antrean", "Lagu berikutnya dari Spotify; klik salah satunya untuk langsung memutarnya.", 540, 380, false),
    ];

    /// <summary>
    /// Suasana: full-screen ambiences, at most one at a time, shown instead of the widgets. Not in
    /// the widget catalog: they aren't placed or moved. Adding one = an entry here + its web scene.
    /// </summary>
    public static readonly WidgetInfo[] Ambiences =
    [
        new("star", "Star Mode", "Lirik membentuk rasi bintang di layar.", 0, 0, false),
        new("vinyl", "Piringan Hitam", "Piringan berputar, lirik melengkung di alurnya.", 0, 0, false),
    ];

    public static bool IsAmbience(string id) => Ambiences.Any(a => a.Id == id);

    private static WidgetInfo? Info(string id) => Ambiences.FirstOrDefault(a => a.Id == id) ?? Catalog.FirstOrDefault(i => i.Id == id);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly Services _services;
    private readonly Dictionary<string, WidgetWindow> _windows = [];
    private readonly ExplorerWatcher _explorer;
    private readonly DesktopInput _input;
    private IDisposable? _audioLease;
    private IDisposable? _queueLease;
    private bool _disposed;

    /// <summary>A widget was double-clicked.</summary>
    public event Action? DashboardRequested;

    /// <summary>Enabled / locked / hidden changed (for the dashboard and tray).</summary>
    public event Action? Changed;

    public WidgetManager(Services services)
    {
        _services = services;
        _services.Media.Changed += track => Broadcast(new { type = "track", track });
        _services.Lyrics.Changed += lyrics => Broadcast(new { type = "lyrics", lyrics });
        _services.Queue.Changed += queue => Broadcast(new { type = "queue", queue });
        _services.Audio.StatusChanged += OnAudioStatus;
        _explorer = new ExplorerWatcher(Rebuild);
        _input = new DesktopInput(services.Ui, () => _windows.Values);
        // Resolution / scale / monitor changes: an ambience must keep covering the screen.
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += OnDisplayChanged;
        // Widgets are only see-through over the desktop's wallpaper layer; if Explorer ever drops it
        // while we run, bring it back (a couple of window lookups every few seconds).
        _layerCheck.Tick += (_, _) => { if (_windows.Count > 0) DesktopLayer.EnsureWallpaperLayer(); };
        _layerCheck.Start();
    }

    private readonly System.Windows.Forms.Timer _layerCheck = new() { Interval = 5000 };

    private void OnDisplayChanged(object? sender, EventArgs e) => _services.Ui.Post(_ => Apply(), null);

    public bool Hidden => _services.Settings.Current.WidgetsHidden;

    /// <summary>The ambience on screen ("star", "vinyl"), or null.</summary>
    public string? Ambience => _services.Settings.Current.Ambience is { } a && IsAmbience(a) ? a : null;

    public object DescribeAmbience() => new
    {
        active = Ambience,
        options = Ambiences.ToDictionary(a => a.Id, a => SettingsFor(a).Options),
    };

    /// <summary>Turns an ambience on (the widgets step aside, their settings untouched), switches to another, or off (null).</summary>
    public void SetAmbience(string? id)
    {
        if (id is not null && !IsAmbience(id)) return;
        if (Ambience == id) return;
        _services.Settings.Current.Ambience = id;
        _services.Settings.Changed();
        Log.Info($"Suasana: {id ?? "off"}");
        Apply();
        Changed?.Invoke();
    }

    public IEnumerable<object> Describe() => Catalog.Select(info =>
    {
        var s = SettingsFor(info);
        return new { id = info.Id, name = info.Name, description = info.Description, enabled = s.Enabled, locked = s.Locked, options = s.Options };
    });

    // ---------------------------------------------------------------- lifecycle

    /// <summary>Brings the windows in line with the settings.</summary>
    public void Apply()
    {
        if (_disposed) return;
        var settings = _services.Settings.Current;

        string? ambience = !settings.WidgetsHidden && WebHosts.HasBuiltFrontend ? Ambience : null;
        bool away = ambience is not null; // any ambience puts the widgets away
        foreach (var info in Catalog)
        {
            var s = SettingsFor(info);
            bool want = s.Enabled && !settings.WidgetsHidden && !away && WebHosts.HasBuiltFrontend;
            bool have = _windows.TryGetValue(info.Id, out var window);

            if (want && !have) Create(info, s);
            else if (!want && have) Close(window!);
            else if (have) window!.SetLocked(s.Locked);
        }

        // The sky covers the whole primary screen and never takes the mouse (desktop stays usable).
        foreach (var a in Ambiences)
        {
            bool have = _windows.TryGetValue(a.Id, out var layer);
            if (a.Id == ambience && !have) CreateAmbience(a.Id);
            else if (a.Id != ambience && have) Close(layer!);
            else if (have && Screen.PrimaryScreen is { } screen && layer!.ScreenBounds != screen.Bounds) layer.MoveTo(screen.Bounds);
        }

        _input.Update();
        if (_windows.ContainsKey("queue")) _queueLease ??= _services.Queue.Acquire();
        else { _queueLease?.Dispose(); _queueLease = null; }
        if (_windows.Count > 0) _audioLease ??= _services.Audio.Acquire();
        else { _audioLease?.Dispose(); _audioLease = null; }
    }

    private void Create(WidgetInfo info, WidgetSettings s)
    {
        if (!s.Placed)
        {
            var r = DefaultBounds(info);
            (s.X, s.Y, s.Width, s.Height, s.Placed) = (r.X, r.Y, r.Width, r.Height, true);
            _services.Settings.Changed();
        }

        var bounds = KeepOnScreen(new Rectangle(s.X, s.Y, s.Width, s.Height));
        var window = new WidgetWindow(this, info.Id, bounds, s.Locked);
        _windows[info.Id] = window;
        window.FormClosed += (_, _) => { if (_windows.GetValueOrDefault(info.Id) == window) _windows.Remove(info.Id); };
        window.Show();
        _ = StartAsync(window);
    }

    private void CreateAmbience(string id)
    {
        var bounds = Screen.PrimaryScreen?.Bounds ?? new Rectangle(0, 0, 1920, 1080);
        var window = new WidgetWindow(this, id, bounds, locked: true);
        _windows[id] = window;
        window.FormClosed += (_, _) => { if (_windows.GetValueOrDefault(id) == window) _windows.Remove(id); };
        window.Show();
        _ = StartAsync(window);
    }

    private async Task StartAsync(WidgetWindow window)
    {
        try { await window.StartAsync(await _services.GetWebEnvironmentAsync()); }
        catch (Exception ex) { Log.Error($"Widget '{window.Id}' failed to start", ex); }
    }

    private void Close(WidgetWindow window)
    {
        _windows.Remove(window.Id);
        window.Close();
        window.Dispose();
    }

    /// <summary>Explorer restarted: the desktop windows (and our children in them) are gone.</summary>
    private void Rebuild()
    {
        Log.Info("Explorer restarted; rebuilding widgets");
        foreach (var w in _windows.Values.ToList()) Close(w);
        Apply();
    }

    // ---------------------------------------------------------------- called by windows

    internal async Task OnWidgetReadyAsync(WidgetWindow window)
    {
        var info = Info(window.Id)!;
        var s = SettingsFor(info);
        window.Post(new
        {
            type = "widget-init",
            id = window.Id,
            locked = !IsAmbience(info.Id) && s.Locked, // an ambience hears the pointer (for its controls); the host keeps it in place
            keepAspect = info.KeepAspect,
            options = s.Options,
            lyricsOffsetMs = _services.Settings.Current.LyricsOffsetMs,
            fps = _services.Settings.Current.FrameRate,
            calm = _services.Settings.Current.CalmMode,
        }, Json);
        window.Post(new { type = "audio-status", status = _services.Audio.Status }, Json);
        window.Post(new { type = "track", track = _services.Media.Current }, Json);
        window.Post(new { type = "lyrics", lyrics = _services.Lyrics.Current }, Json);
        window.Post(new { type = "queue", queue = _services.Queue.Current }, Json);
        if (window.Core is { } core) (await _services.GetAudioBridgeAsync()).Attach(core);
        _input.Update();
    }

    internal void RequestDashboard() => DashboardRequested?.Invoke();

    internal Task MediaCommandAsync(string command) => _services.Media.CommandAsync(command);

    internal Task QueuePlayAsync(int index) => _services.Queue.PlayAsync(index);

    internal Task QueueBackAsync(int index) => _services.Queue.PlayPreviousAsync(index);

    internal Task SeekAsync(double positionMs) => _services.Media.SeekAsync(positionMs);

    internal void SaveBounds(string id, Rectangle r)
    {
        if (IsAmbience(id)) return; // always the full screen
        var s = SettingsFor(Catalog.First(i => i.Id == id));
        (s.X, s.Y, s.Width, s.Height) = (r.X, r.Y, r.Width, r.Height);
        _services.Settings.Changed();
    }

    internal void SaveOptions(string id, JsonObject options)
    {
        if (Info(id) is not { } info) return;
        SettingsFor(info).Options = options;
        _services.Settings.Changed();
    }

    /// <summary>From the dashboard: saves a widget's look and sends it to the widget right away.</summary>
    public void SetOptions(string id, JsonObject options)
    {
        if (Info(id) is null) return;
        SaveOptions(id, options);
        if (_windows.TryGetValue(id, out var w)) w.Post(new { type = "widget-options", options }, Json);
    }

    /// <summary>Settings every widget follows (frame rate, lyric timing).</summary>
    public void BroadcastPrefs()
    {
        var s = _services.Settings.Current;
        Broadcast(new { type = "prefs", fps = s.FrameRate, lyricsOffsetMs = s.LyricsOffsetMs, calm = s.CalmMode });
    }

    // ---------------------------------------------------------------- called by dashboard / tray

    public void SetEnabled(string id, bool enabled) => Update(id, s => s.Enabled = enabled);

    public void SetLocked(string id, bool locked) => Update(id, s => s.Locked = locked);

    public void ResetPosition(string id)
    {
        var info = Catalog.FirstOrDefault(i => i.Id == id);
        if (info is null) return;
        var r = DefaultBounds(info);
        Update(id, s => (s.X, s.Y, s.Width, s.Height, s.Placed) = (r.X, r.Y, r.Width, r.Height, true));
        if (_windows.TryGetValue(id, out var w)) w.MoveTo(r);
    }

    public void SetHidden(bool hidden)
    {
        _services.Settings.Current.WidgetsHidden = hidden;
        _services.Settings.Changed();
        Apply();
        Changed?.Invoke();
    }

    private void Update(string id, Action<WidgetSettings> change)
    {
        var info = Catalog.FirstOrDefault(i => i.Id == id);
        if (info is null) return;
        change(SettingsFor(info));
        _services.Settings.Changed();
        Apply();
        if (_windows.TryGetValue(id, out var w))
        {
            var s = SettingsFor(info);
            w.Post(new { type = "widget-state", locked = s.Locked }, Json);
        }
        Changed?.Invoke();
    }

    // ---------------------------------------------------------------- helpers

    private WidgetSettings SettingsFor(WidgetInfo info)
    {
        var all = _services.Settings.Current.Widgets;
        if (!all.TryGetValue(info.Id, out var s))
        {
            s = new WidgetSettings { Enabled = true };
            all[info.Id] = s;
        }
        return s;
    }

    private static Rectangle DefaultBounds(WidgetInfo info)
    {
        var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1040);
        double k = Native.ScaleAt(wa.X + wa.Width / 2, wa.Y + wa.Height / 2);
        int w = (int)(info.Width * k), h = (int)(info.Height * k);
        return info.Id switch
        {
            "cover" => new Rectangle(wa.Right - w - (int)(90 * k), wa.Top + (int)(140 * k), w, h),
            "lyrics" => new Rectangle(wa.Left + (wa.Width - w) / 2 - (int)(60 * k), wa.Top + (int)(wa.Height * 0.2), w, h),
            // Under the visualizer, which sits top-right.
            "queue" => new Rectangle(wa.Right - w - (int)(90 * k), Math.Min(wa.Top + (int)((140 + 380 + 20) * k), wa.Bottom - h), w, h),
            _ => new Rectangle(wa.Left + (wa.Width - w) / 2, wa.Top + (wa.Height - h) / 2, w, h),
        };
    }

    /// <summary>Keeps at least a grab-able strip of the widget on some screen.</summary>
    internal Rectangle KeepOnScreen(Rectangle r)
    {
        var vs = SystemInformation.VirtualScreen;
        int margin = 60;
        int x = Math.Clamp(r.X, vs.Left - r.Width + margin, vs.Right - margin);
        int y = Math.Clamp(r.Y, vs.Top, vs.Bottom - margin);
        return new Rectangle(x, y, r.Width, r.Height);
    }

    private void OnAudioStatus(AudioStatus status)
    {
        var ui = _services.Ui;
        ui.Post(_ => Broadcast(new { type = "audio-status", status }), null);
    }

    private void Broadcast(object message)
    {
        foreach (var w in _windows.Values) w.Post(message, Json);
    }

    public void Dispose()
    {
        _disposed = true;
        _layerCheck.Dispose();
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= OnDisplayChanged;
        _services.Audio.StatusChanged -= OnAudioStatus;
        _explorer.Dispose();
        _input.Dispose();
        foreach (var w in _windows.Values.ToList()) Close(w);
        _audioLease?.Dispose();
        _audioLease = null;
        _queueLease?.Dispose();
        _queueLease = null;
    }

    /// <summary>A hidden top-level window that hears Explorer's "TaskbarCreated" broadcast.</summary>
    private sealed class ExplorerWatcher : NativeWindow, IDisposable
    {
        private readonly Action _onRestart;
        private readonly System.Windows.Forms.Timer _delay = new() { Interval = 1500 };

        public ExplorerWatcher(Action onRestart)
        {
            _onRestart = onRestart;
            _delay.Tick += (_, _) => { _delay.Stop(); _onRestart(); };
            CreateHandle(new CreateParams { Caption = "Sonora.ExplorerWatcher" });
        }

        protected override void WndProc(ref Message m)
        {
            // Give the new Explorer a moment to build its desktop windows.
            if ((uint)m.Msg == DesktopLayer.TaskbarCreatedMessage) { _delay.Stop(); _delay.Start(); }
            base.WndProc(ref m);
        }

        public void Dispose()
        {
            _delay.Dispose();
            DestroyHandle();
        }
    }
}
