using System.Reflection;

namespace Sonora;

/// <summary>Name, version and every folder the app writes to. Keeping all of it here
/// is what lets the uninstaller remove everything in one go (see docs/ARCHITECTURE.md §10).</summary>
public static class AppInfo
{
    public const string Name = "Sonora";

    public static string Version { get; } =
        Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion.Split('+')[0] ?? "0.0.0";

    private static readonly string LocalAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    /// <summary>%LOCALAPPDATA%\Sonora — the program, managed by the installer (which empties it on install).</summary>
    public static string Root { get; } = Path.Combine(LocalAppData, Name);

    /// <summary>
    /// %LOCALAPPDATA%\SonoraData — settings, caches, logs, the Spotify token. Kept apart from the
    /// program so reinstalling or updating never touches it; the uninstaller deletes it.
    /// </summary>
    public static string DataDir { get; } = Path.Combine(LocalAppData, Name + "Data");

    /// <summary>WebView2 profile (cache, local storage).</summary>
    public static string WebViewDir { get; } = Path.Combine(DataDir, "webview");

    public static string LogDir { get; } = Path.Combine(DataDir, "logs");

    /// <summary>Album art, lyrics and other things that can be fetched again.</summary>
    public static string CacheDir { get; } = Path.Combine(DataDir, "cache");

    /// <summary>Built frontend shipped beside the exe.</summary>
    public static string WebDir { get; } = Path.Combine(AppContext.BaseDirectory, "web");

    /// <summary>Virtual host the frontend is served from inside WebView2.</summary>
    public const string WebHost = "app.sonora";

    /// <summary>Set to e.g. http://localhost:5173 to load the Vite dev server instead of web/.</summary>
    public static string? DevUrl { get; } = Environment.GetEnvironmentVariable("SONORA_DEV_URL");

    public static void EnsureDirs()
    {
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(WebViewDir);
        Directory.CreateDirectory(LogDir);
        Directory.CreateDirectory(CacheDir);
    }
}
