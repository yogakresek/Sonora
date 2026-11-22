using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Sonora.Audio;
using Sonora.Content;
using Sonora.Media;
using Sonora.Spotify;

namespace Sonora;

/// <summary>
/// The settings window. Hosts the web dashboard in WebView2 over a Windows 11 Mica backdrop
/// (dark title bar, frame extended into the client area, transparent web background).
/// </summary>
public sealed class DashboardForm : Form
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly Services _services;
    private readonly WebView2 _web;
    private IDisposable? _audioLease;
    private IDisposable? _queueLease;
    private bool _mica;

    public DashboardForm(Icon icon, Services services)
    {
        _services = services;
        Text = AppInfo.Name;
        Icon = icon;
        StartPosition = FormStartPosition.CenterScreen;
        // Sizes are in 96-dpi units; scale them to this screen.
        ClientSize = LogicalToDeviceUnits(new Size(1180, 780));
        MinimumSize = LogicalToDeviceUnits(new Size(900, 600));
        // Black is what DWM treats as "show the backdrop" once the frame covers the client area.
        BackColor = Color.Black;

        _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Transparent };
        Controls.Add(_web);

        Load += async (_, _) => await InitWebAsync();
        VisibleChanged += (_, _) => UpdateAudioLease();
        Resize += (_, _) => UpdateAudioLease();

        _services.Audio.StatusChanged += OnAudioStatus;
        _services.Media.Changed += OnTrack;
        _services.Lyrics.Changed += OnLyrics;
        _services.Widgets.Changed += OnWidgets;
        _services.Queue.Changed += OnQueue;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        _mica = ApplyBackdrop(Handle);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _services.Audio.StatusChanged -= OnAudioStatus;
            _services.Media.Changed -= OnTrack;
            _services.Lyrics.Changed -= OnLyrics;
            _services.Widgets.Changed -= OnWidgets;
            _services.Queue.Changed -= OnQueue;
            _queueLease?.Dispose();
            _queueLease = null;
            _audioLease?.Dispose();
            _audioLease = null;
        }
        base.Dispose(disposing);
    }

    /// <summary>Audio only runs for the dashboard while it can actually be seen.</summary>
    private void UpdateAudioLease()
    {
        bool want = Visible && WindowState != FormWindowState.Minimized;
        if (want && _audioLease is null) _audioLease = _services.Audio.Acquire();
        else if (!want && _audioLease is not null) { _audioLease.Dispose(); _audioLease = null; }
        if (want && _queueLease is null) _queueLease = _services.Queue.Acquire();
        else if (!want && _queueLease is not null) { _queueLease.Dispose(); _queueLease = null; }
    }

    private async Task InitWebAsync()
    {
        try
        {
            var env = await _services.GetWebEnvironmentAsync();
            await _web.EnsureCoreWebView2Async(env);
            var core = _web.CoreWebView2;

            bool dev = AppInfo.DevUrl is not null;
            core.Settings.AreDevToolsEnabled = dev || System.Diagnostics.Debugger.IsAttached;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = dev;
            core.Settings.IsZoomControlEnabled = false;

            core.WebMessageReceived += OnWebMessage;
            WebHosts.Map(core);

            if (WebHosts.HasBuiltFrontend)
            {
                // Dev aid: SONORA_PAGE=lyrics opens the dashboard on that page.
                string page = Environment.GetEnvironmentVariable("SONORA_PAGE") is { Length: > 0 } p ? $"#{p}" : "";
                core.Navigate(WebHosts.PageUrl("index.html") + page);
            }
            else
            {
                core.NavigateToString(
                    "<body style='background:#0e0e14;color:#ddd;font:14px Segoe UI;padding:24px'>" +
                    "Frontend belum dibuild. Jalankan <code>npm run build</code> di folder <code>web/</code>.</body>");
            }
        }
        catch (WebView2RuntimeNotFoundException ex)
        {
            Log.Error("WebView2 runtime not found", ex);
            MessageBox.Show(this, "Microsoft Edge WebView2 Runtime tidak ditemukan.", AppInfo.Name,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch (Exception ex)
        {
            Log.Error("WebView2 init failed", ex);
        }
    }

    // ---------------------------------------------------------------- messages from the page

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var root = JsonNode.Parse(e.WebMessageAsJson)?.AsObject();
            if (root is null) return;
            string? type = (string?)root["type"];
            string id = (string?)root["id"] ?? "";
            var settings = _services.Settings.Current;

            switch (type)
            {
                case "hello":
                    Post(new
                    {
                        type = "hello",
                        app = AppInfo.Name,
                        version = AppInfo.Version,
                        dataDir = AppInfo.DataDir,
                        runtime = RuntimeInformation.FrameworkDescription,
                        webview = _web.CoreWebView2.Environment.BrowserVersionString,
                        mica = _mica,
                        installed = Installation.IsInstalled,
                    });
                    Post(new { type = "audio-status", status = _services.Audio.Status });
                    Post(new { type = "track", track = _services.Media.Current });
                    Post(new { type = "lyrics", lyrics = _services.Lyrics.Current });
                    Post(new { type = "queue", queue = _services.Queue.Current, redirectUri = SpotifyClient.RedirectUri });
                    OnWidgets();
                    PostPrefs();
                    (await _services.GetAudioBridgeAsync()).Attach(_web.CoreWebView2);
                    break;

                case "media":
                    if ((string?)root["command"] is { } command) await _services.Media.CommandAsync(command);
                    break;

                case "widget-set":
                    if (root["enabled"] is JsonValue en) _services.Widgets.SetEnabled(id, (bool)en);
                    if (root["locked"] is JsonValue lk) _services.Widgets.SetLocked(id, (bool)lk);
                    break;

                case "widget-reset":
                    _services.Widgets.ResetPosition(id);
                    break;

                case "widget-options":
                    if (root["options"] is JsonObject options)
                        _services.Widgets.SetOptions(id, (JsonObject)options.DeepClone());
                    break;

                case "star-mode":
                    _services.Widgets.SetStarMode((bool?)root["on"] ?? false);
                    break;

                case "widgets-hidden":
                    _services.Widgets.SetHidden((bool?)root["hidden"] ?? false);
                    break;

                case "prefs":
                    if (root["fps"] is JsonValue fps) settings.FrameRate = Math.Clamp((int)fps, 15, 60);
                    if (root["lyricsOffsetMs"] is JsonValue off) settings.LyricsOffsetMs = Math.Clamp((int)off, -5000, 5000);
                    if (root["sensitivity"] is JsonValue sens)
                        _services.Audio.Sensitivity = settings.AudioSensitivity = Math.Clamp((float)sens, 0.2f, 3f);
                    if (root["smoothing"] is JsonValue sm)
                        _services.Audio.Smoothing = settings.AudioSmoothing = Math.Clamp((float)sm, 0f, 0.95f);
                    if (root["startWithWindows"] is JsonValue sw) Startup.Set((bool)sw);
                    if (root["calm"] is JsonValue calm) settings.CalmMode = (bool)calm;
                    _services.Settings.Changed();
                    _services.Widgets.BroadcastPrefs();
                    PostPrefs();
                    break;

                case "spotify-connect":
                    await _services.Queue.ConnectAsync((string?)root["clientId"] ?? "");
                    break;

                case "spotify-disconnect":
                    _services.Queue.Disconnect();
                    break;

                case "queue-play":
                    if (root["index"] is JsonValue qi) await _services.Queue.PlayAsync((int)qi);
                    break;

                case "queue-back":
                    if (root["index"] is JsonValue qb) await _services.Queue.PlayPreviousAsync((int)qb);
                    break;

                case "seek":
                    if (root["ms"] is JsonValue seekMs) await _services.Media.SeekAsync((double)seekMs);
                    break;

                case "open-url":
                    // Only the pages the dashboard links to.
                    if ((string?)root["url"] is { } url && Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == "https"
                        && uri.Host is "developer.spotify.com" or "lrclib.net")
                        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.ToString()) { UseShellExecute = true });
                    break;

                case "uninstall":
                    ConfirmUninstall();
                    break;

                case "log":
                    Log.Info($"[dashboard] {(string?)root["message"]}");
                    break;

                case "open-data-dir":
                    System.Diagnostics.Process.Start("explorer.exe", AppInfo.DataDir);
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Error("Bad web message", ex);
        }
    }

    private void ConfirmUninstall()
    {
        if (!Installation.IsInstalled)
        {
            MessageBox.Show(this, "Ini versi pengembangan (tidak dipasang lewat installer), jadi tidak ada yang perlu di-uninstall.",
                AppInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        var answer = MessageBox.Show(this,
            "Sonora akan dihapus sepenuhnya dari komputer ini:\n\n" +
            "•  program, shortcut Desktop dan Start Menu\n" +
            "•  semua pengaturan, cache lirik dan cover, log\n" +
            "•  login Spotify dan entri \"Mulai bersama Windows\"\n\n" +
            "Tindakan ini tidak bisa dibatalkan. Lanjutkan?",
            "Hapus Sonora sepenuhnya", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes) return;
        if (Installation.StartUninstall()) Application.Exit();
        else MessageBox.Show(this, "Uninstaller tidak ditemukan. Hapus Sonora lewat Settings → Apps.", AppInfo.Name,
            MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private void PostPrefs()
    {
        var s = _services.Settings.Current;
        Post(new
        {
            type = "prefs",
            fps = s.FrameRate,
            lyricsOffsetMs = s.LyricsOffsetMs,
            sensitivity = s.AudioSensitivity,
            smoothing = s.AudioSmoothing,
            startWithWindows = Startup.IsEnabled,
            calm = s.CalmMode,
        });
    }

    // ---------------------------------------------------------------- host events

    private void OnAudioStatus(AudioStatus status)
    {
        if (!IsHandleCreated || IsDisposed) return;
        BeginInvoke(() => Post(new { type = "audio-status", status }));
    }

    private void OnTrack(TrackState? track) => Post(new { type = "track", track });

    private void OnLyrics(LyricsState? lyrics) => Post(new { type = "lyrics", lyrics });

    private void OnQueue(QueueState queue) => Post(new { type = "queue", queue, redirectUri = SpotifyClient.RedirectUri });

    private void OnWidgets() =>
        Post(new { type = "widgets", items = _services.Widgets.Describe(), hidden = _services.Widgets.Hidden, star = _services.Widgets.DescribeStar() });

    private void Post(object message)
    {
        if (IsDisposed) return;
        _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message, Json));
    }

    // ---------------------------------------------------------------- Mica

    /// <summary>Dark title bar and Mica behind the whole window (Windows 11 22H2+). Returns false where unsupported.</summary>
    private static bool ApplyBackdrop(IntPtr hwnd)
    {
        try
        {
            int dark = 1;
            DwmSetWindowAttribute(hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref dark, sizeof(int));

            if (Environment.OSVersion.Version.Build < 22621) return false;
            int mica = 2; // DWMSBT_MAINWINDOW
            if (DwmSetWindowAttribute(hwnd, 38 /* DWMWA_SYSTEMBACKDROP_TYPE */, ref mica, sizeof(int)) != 0) return false;
            var margins = new MARGINS { Left = -1, Right = -1, Top = -1, Bottom = -1 };
            return DwmExtendFrameIntoClientArea(hwnd, ref margins) == 0;
        }
        catch
        {
            return false;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MARGINS { public int Left, Right, Top, Bottom; }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("dwmapi.dll")]
    private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);
}
