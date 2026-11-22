using Microsoft.Web.WebView2.Core;
using Sonora.Audio;
using Sonora.Bridge;
using Sonora.Content;
using Sonora.Media;
using Sonora.Settings;
using Sonora.Spotify;
using Sonora.Widgets;

namespace Sonora;

/// <summary>The app's long-lived parts, created once on the UI thread and shared by every window.</summary>
public sealed class Services : IDisposable
{
    private Task<CoreWebView2Environment>? _env;
    private AudioBridge? _audioBridge;

    public SynchronizationContext Ui { get; }
    public SettingsStore Settings { get; } = new();
    public AudioEngine Audio { get; } = new();
    public MediaService Media { get; }
    public LyricsService Lyrics { get; }
    public QueueService Queue { get; }
    public WidgetManager Widgets { get; }

    public Services(SynchronizationContext ui)
    {
        Ui = ui;
        Audio.Sensitivity = Settings.Current.AudioSensitivity;
        Audio.Smoothing = Settings.Current.AudioSmoothing;
        Startup.Refresh();
        Media = new MediaService(ui);
        Lyrics = new LyricsService(Media);
        Queue = new QueueService(Settings, Media);
        Widgets = new WidgetManager(this);
        _ = StartMediaAsync();
    }

    private async Task StartMediaAsync()
    {
        try { await Media.StartAsync(); }
        catch (Exception ex) { Log.Error("Media service failed to start", ex); }
    }

    /// <summary>
    /// One WebView2 environment for every window, so they share one browser and one GPU process.
    /// --process-per-site also puts every page of the app in a single renderer, so each extra
    /// widget costs a little memory instead of a whole process.
    /// </summary>
    public Task<CoreWebView2Environment> GetWebEnvironmentAsync() =>
        _env ??= CoreWebView2Environment.CreateAsync(
            userDataFolder: AppInfo.WebViewDir,
            options: new CoreWebView2EnvironmentOptions("--process-per-site"));

    public async Task<AudioBridge> GetAudioBridgeAsync() =>
        _audioBridge ??= new AudioBridge(await GetWebEnvironmentAsync(), Audio);

    public void Dispose()
    {
        Widgets.Dispose();
        _audioBridge?.Dispose();
        Audio.Dispose();
        Lyrics.Dispose();
        Queue.Dispose();
        Media.Dispose();
        Settings.Dispose();
    }
}
