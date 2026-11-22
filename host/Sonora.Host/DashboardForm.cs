using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Sonora.Audio;
using Sonora.Media;

namespace Sonora;

/// <summary>The settings window. Hosts the web dashboard in WebView2.</summary>
public sealed class DashboardForm : Form
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly Services _services;
    private readonly WebView2 _web;
    private IDisposable? _audioLease;

    public DashboardForm(Icon icon, Services services)
    {
        _services = services;
        Text = AppInfo.Name;
        Icon = icon;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1100, 760);
        MinimumSize = new Size(760, 520);
        BackColor = Color.FromArgb(14, 14, 20);

        _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
        Controls.Add(_web);

        Load += async (_, _) => await InitWebAsync();
        VisibleChanged += (_, _) => UpdateAudioLease();
        Resize += (_, _) => UpdateAudioLease();

        _services.Audio.StatusChanged += OnAudioStatus;
        _services.Media.Changed += OnTrack;
        _services.Widgets.Changed += OnWidgets;
    }

    // Closing the dashboard really closes it (the app stays in the tray). With no web view left,
    // WebView2's browser, GPU and renderer processes exit too, which frees ~250 MB.

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _services.Audio.StatusChanged -= OnAudioStatus;
            _services.Media.Changed -= OnTrack;
            _services.Widgets.Changed -= OnWidgets;
            _audioLease?.Dispose();
            _audioLease = null;
        }
        base.Dispose(disposing);
    }

    /// <summary>Audio only runs while the dashboard can actually be seen.</summary>
    private void UpdateAudioLease()
    {
        bool want = Visible && WindowState != FormWindowState.Minimized;
        if (want && _audioLease is null) _audioLease = _services.Audio.Acquire();
        else if (!want && _audioLease is not null) { _audioLease.Dispose(); _audioLease = null; }
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

            core.WebMessageReceived += OnWebMessage;
            WebHosts.Map(core);

            if (WebHosts.HasBuiltFrontend)
            {
                core.Navigate(WebHosts.PageUrl("index.html"));
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

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            string? type = root.TryGetProperty("type", out var t) ? t.GetString() : null;

            switch (type)
            {
                case "hello":
                    Post(new
                    {
                        type = "hello",
                        app = AppInfo.Name,
                        version = AppInfo.Version,
                        dataDir = AppInfo.DataDir,
                        runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
                        webview = _web.CoreWebView2.Environment.BrowserVersionString,
                    });
                    Post(new { type = "audio-status", status = _services.Audio.Status });
                    Post(new { type = "track", track = _services.Media.Current });
                    Post(new { type = "widgets", items = _services.Widgets.Describe(), hidden = _services.Widgets.Hidden });
                    (await _services.GetAudioBridgeAsync()).Attach(_web.CoreWebView2);
                    break;

                case "widget-set":
                {
                    string id = root.GetProperty("id").GetString() ?? "";
                    if (root.TryGetProperty("enabled", out var en)) _services.Widgets.SetEnabled(id, en.GetBoolean());
                    if (root.TryGetProperty("locked", out var lk)) _services.Widgets.SetLocked(id, lk.GetBoolean());
                    break;
                }

                case "widget-reset":
                    _services.Widgets.ResetPosition(root.GetProperty("id").GetString() ?? "");
                    break;

                case "widgets-hidden":
                    _services.Widgets.SetHidden(root.GetProperty("hidden").GetBoolean());
                    break;

                case "media":
                    if (root.TryGetProperty("command", out var c) && c.GetString() is { } command)
                        await _services.Media.CommandAsync(command);
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

    private void OnAudioStatus(AudioStatus status)
    {
        if (!IsHandleCreated || IsDisposed) return;
        BeginInvoke(() => Post(new { type = "audio-status", status }));
    }

    private void OnTrack(TrackState? track) => Post(new { type = "track", track });

    private void OnWidgets() => Post(new { type = "widgets", items = _services.Widgets.Describe(), hidden = _services.Widgets.Hidden });

    private void Post(object message)
    {
        if (IsDisposed) return;
        _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message, Json));
    }
}
