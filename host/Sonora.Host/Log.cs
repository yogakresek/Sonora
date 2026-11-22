namespace Sonora;

/// <summary>Tiny file logger: one file per day under data/logs, oldest pruned after 7 days.</summary>
public static class Log
{
    private static readonly object Gate = new();

    public static void Info(string message) => Write("INFO", message);
    public static void Error(string message, Exception? ex = null) =>
        Write("ERROR", ex is null ? message : $"{message}: {ex}");

    private static void Write(string level, string message)
    {
        try
        {
            var line = $"{DateTime.Now:HH:mm:ss.fff} [{level}] {message}{Environment.NewLine}";
            var file = Path.Combine(AppInfo.LogDir, $"{DateTime.Now:yyyy-MM-dd}.log");
            lock (Gate) File.AppendAllText(file, line);
            System.Diagnostics.Debug.Write(line);
        }
        catch
        {
            // Logging must never take the app down.
        }
    }

    public static void Prune()
    {
        try
        {
            foreach (var f in Directory.EnumerateFiles(AppInfo.LogDir, "*.log"))
                if (File.GetLastWriteTime(f) < DateTime.Now.AddDays(-7)) File.Delete(f);
        }
        catch { }
    }
}
