using Microsoft.Web.WebView2.Core;
using Sonora.Audio;
using Sonora.Bridge;
using Sonora.Media;

namespace Sonora;

/// <summary>The app's long-lived parts, created once on the UI thread and shared by every window.</summary>
public sealed class Services : IDisposable
{
    private Task<CoreWebView2Environment>? _env;
    private AudioBridge? _audioBridge;

    public AudioEngine Audio { get; } = new();
    public MediaService Media { get; }

    public Services(SynchronizationContext ui)
    {
        Media = new MediaService(ui);
        _ = StartMediaAsync();
    }

    private async Task StartMediaAsync()
    {
        try { await Media.StartAsync(); }
        catch (Exception ex) { Log.Error("Media service failed to start", ex); }
    }

    /// <summary>One WebView2 environment for all windows, so they share a single browser process.</summary>
    public Task<CoreWebView2Environment> GetWebEnvironmentAsync() =>
        _env ??= CoreWebView2Environment.CreateAsync(userDataFolder: AppInfo.WebViewDir);

    public async Task<AudioBridge> GetAudioBridgeAsync() =>
        _audioBridge ??= new AudioBridge(await GetWebEnvironmentAsync(), Audio);

    public void Dispose()
    {
        _audioBridge?.Dispose();
        Audio.Dispose();
        Media.Dispose();
    }
}
