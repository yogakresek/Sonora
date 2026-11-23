using System.Text.Json;
using System.Text.Json.Nodes;

namespace Sonora.Settings;

public sealed class WidgetSettings
{
    public bool Enabled { get; set; }
    public bool Locked { get; set; }
    /// <summary>False until the widget has been given a position (first run, or after a reset).</summary>
    public bool Placed { get; set; }
    /// <summary>Screen rectangle in physical pixels.</summary>
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    /// <summary>Look-and-feel options owned by the web side (style, colours, …).</summary>
    public JsonObject Options { get; set; } = [];
}

public sealed class AppSettings
{
    public int Version { get; set; } = 1;
    public bool FirstRunDone { get; set; }
    /// <summary>Hide every widget without forgetting which are on (tray toggle).</summary>
    public bool WidgetsHidden { get; set; }
    /// <summary>
    /// Suasana: the full-screen ambience shown instead of the widgets ("star", "vinyl"), or null.
    /// Stays on for every song until turned off. The widgets' own Enabled flags are left alone, so
    /// they come back exactly as they were.
    /// </summary>
    public string? Ambience { get; set; }

    /// <summary>Before 0.6 there was only Star Mode; read once and moved into <see cref="Ambience"/>.</summary>
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    public bool StarMode { get; set; }
    /// <summary>Shifts every lyric line; positive = words appear later.</summary>
    public int LyricsOffsetMs { get; set; }
    /// <summary>Widget drawing rate: 60 (smooth) or 30 (light).</summary>
    public int FrameRate { get; set; } = 60;
    /// <summary>No beat pulsing or flashing; slower, softer motion everywhere.</summary>
    public bool CalmMode { get; set; }
    /// <summary>Client ID of the user's own Spotify app (for the queue). Not a secret.</summary>
    public string? SpotifyClientId { get; set; }
    public float AudioSensitivity { get; set; } = 1f;
    public float AudioSmoothing { get; set; } = 0.72f;
    public Dictionary<string, WidgetSettings> Widgets { get; set; } = [];
}

/// <summary>Loads and saves data/settings.json. Saves are debounced and written atomically.</summary>
public sealed class SettingsStore : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly string _path = Path.Combine(AppInfo.DataDir, "settings.json");
    private readonly System.Windows.Forms.Timer _saveTimer = new() { Interval = 500 };

    public AppSettings Current { get; }

    /// <summary>Raised on the UI thread after any change made through <see cref="Changed"/>.</summary>
    public event Action? SettingsChanged;

    public SettingsStore()
    {
        Current = Load();
        _saveTimer.Tick += (_, _) => { _saveTimer.Stop(); Save(); };
    }

    private AppSettings Load()
    {
        try
        {
            if (File.Exists(_path))
            {
                var s = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(_path), Json) ?? new AppSettings();
                if (s.StarMode) { s.Ambience ??= "star"; s.StarMode = false; } // from 0.5.x
                return s;
            }
        }
        catch (Exception ex)
        {
            Log.Error("settings.json unreadable, starting fresh", ex);
            try { File.Copy(_path, _path + ".bad", overwrite: true); } catch { }
        }
        return new AppSettings();
    }

    /// <summary>Call after changing <see cref="Current"/>.</summary>
    public void Changed()
    {
        _saveTimer.Stop();
        _saveTimer.Start();
        SettingsChanged?.Invoke();
    }

    public void Save()
    {
        try
        {
            string tmp = _path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(Current, Json));
            File.Move(tmp, _path, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Error("Saving settings failed", ex);
        }
    }

    public void Dispose()
    {
        if (_saveTimer.Enabled) Save();
        _saveTimer.Dispose();
    }
}
