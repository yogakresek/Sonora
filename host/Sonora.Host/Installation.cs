using System.Diagnostics;
using Velopack.Locators;

namespace Sonora;

/// <summary>
/// Install and uninstall. Setup.exe (Velopack) installs per user into %LOCALAPPDATA%\Sonora with
/// Desktop and Start Menu shortcuts and an entry in Settings → Apps; data lives apart in
/// %LOCALAPPDATA%\SonoraData. Uninstalling — from there or from the dashboard — runs
/// <see cref="CleanUp"/> first (startup entry, data folder), then Velopack removes the program
/// folder and shortcuts. Nothing is left behind (docs/ARCHITECTURE.md §10).
/// </summary>
public static class Installation
{
    /// <summary>The installed version, or null for a development build.</summary>
    public static string? InstalledVersion
    {
        get
        {
            try { return VelopackLocator.Current.CurrentlyInstalledVersion?.ToString(); }
            catch { return null; }
        }
    }

    public static bool IsInstalled => InstalledVersion is not null;

    /// <summary>Starts Velopack's uninstaller (which calls back into <see cref="CleanUp"/>). Returns false if not installed.</summary>
    public static bool StartUninstall()
    {
        if (!IsInstalled) return false;
        string? update = VelopackLocator.Current.UpdateExePath;
        if (update is null || !File.Exists(update)) return false;
        Log.Info("Uninstall requested from the dashboard");
        Process.Start(new ProcessStartInfo(update, "--uninstall") { UseShellExecute = false });
        return true;
    }

    /// <summary>Removes everything Sonora put outside its program folder, then its data.</summary>
    public static void CleanUp()
    {
        Try(() => Startup.Set(false));
        // The data folder: settings, caches, logs, the WebView2 profile and the Spotify token.
        for (int attempt = 0; attempt < 10 && Directory.Exists(AppInfo.DataDir); attempt++)
        {
            try { Directory.Delete(AppInfo.DataDir, recursive: true); }
            catch { Thread.Sleep(300); } // WebView2 may still be letting go of its files
        }
        // Where data lived before 0.4 (inside the program folder), in case anything is left.
        Try(() => { string old = Path.Combine(AppInfo.Root, "data"); if (Directory.Exists(old)) Directory.Delete(old, true); });
        Try(() => { string old = Path.Combine(AppInfo.Root, "app"); if (Directory.Exists(old)) Directory.Delete(old, true); });
    }

    private static void Try(Action action)
    {
        try { action(); } catch { }
    }
}
