using Microsoft.Win32;

namespace Sonora;

/// <summary>"Start with Windows": one value under HKCU\...\Run, removed again by the uninstaller.</summary>
public static class Startup
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string Argument = "--startup";

    private static string Command => $"\"{Environment.ProcessPath}\" {Argument}";

    public static bool IsEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(AppInfo.Name) is string value && value.Length > 0;
        }
    }

    public static void Set(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (enabled) key.SetValue(AppInfo.Name, Command);
        else key.DeleteValue(AppInfo.Name, throwOnMissingValue: false);
        Log.Info($"Start with Windows: {(enabled ? "on" : "off")}");
    }

    /// <summary>If the app moved (e.g. reinstalled elsewhere), point the entry at this copy.</summary>
    public static void Refresh()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
            if (key?.GetValue(AppInfo.Name) is string value && value != Command) key.SetValue(AppInfo.Name, Command);
        }
        catch (Exception ex)
        {
            Log.Error("Refreshing startup entry failed", ex);
        }
    }
}
