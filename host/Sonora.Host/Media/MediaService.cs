using System.Security.Cryptography;
using Windows.Media.Control;
using Session = Windows.Media.Control.GlobalSystemMediaTransportControlsSession;
using SessionManager = Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager;

namespace Sonora.Media;

/// <summary>
/// Follows whatever is playing through the Windows media controls (SMTC) — the same source as
/// the volume flyout — so Spotify links up by itself the moment it plays, with no login.
///
/// Picks one session: a playing Spotify first, then anything playing, then the one we already
/// had (paused), then Spotify, then the system's current session. Album art is written to
/// data/cache/art and handed to the web side as a URL.
///
/// Everything runs on the UI thread: WinRT events only schedule a refresh there. A 1 s poll
/// backs up the events, since some players are sparse with them.
/// </summary>
public sealed class MediaService : IDisposable
{
    public const string CoverHost = "media.sonora";

    private readonly SynchronizationContext _ui;
    private readonly System.Windows.Forms.Timer _poll = new() { Interval = 1000 };
    private SessionManager? _manager;
    private readonly List<Session> _hooked = [];
    private string? _currentAppId;
    private string? _trackKey;
    private string? _cover;
    private int _coverAttempts;
    private bool _refreshing, _refreshAgain, _refreshQueued;
    private bool _disposed;

    /// <summary>Raised on the UI thread when anything about the current track changes; null = nothing.</summary>
    public event Action<TrackState?>? Changed;

    public TrackState? Current { get; private set; }

    /// <summary>App user model IDs that win over others when both play. Lower-case substrings.</summary>
    public IReadOnlyList<string> Preferred { get; set; } = ["spotify"];

    public static string ArtDir { get; } = Path.Combine(AppInfo.CacheDir, "art");

    public MediaService(SynchronizationContext ui)
    {
        _ui = ui;
        _poll.Tick += (_, _) => QueueRefresh();
    }

    public async Task StartAsync()
    {
        Directory.CreateDirectory(ArtDir);
        PruneArt();

        try
        {
            _manager = await SessionManager.RequestAsync();
        }
        catch (Exception ex)
        {
            Log.Error("SMTC unavailable", ex);
            return;
        }

        _manager.SessionsChanged += (_, _) => _ui.Post(_ => { RehookSessions(); QueueRefresh(); }, null);
        _manager.CurrentSessionChanged += (_, _) => QueueRefresh();
        RehookSessions();
        _poll.Start();
        await RefreshAsync();
    }

    public async Task CommandAsync(string command)
    {
        var session = FindSession(_currentAppId);
        if (session is null) return;
        try
        {
            _ = command switch
            {
                "toggle" => await session.TryTogglePlayPauseAsync(),
                "next" => await session.TrySkipNextAsync(),
                "previous" => await session.TrySkipPreviousAsync(),
                _ => false,
            };
        }
        catch (Exception ex)
        {
            Log.Error($"Media command '{command}' failed", ex);
        }
        QueueRefresh();
    }

    // ---------------------------------------------------------------- sessions

    private void RehookSessions()
    {
        foreach (var s in _hooked)
        {
            s.MediaPropertiesChanged -= OnSessionEvent;
            s.PlaybackInfoChanged -= OnSessionEvent;
            s.TimelinePropertiesChanged -= OnSessionEvent;
        }
        _hooked.Clear();
        if (_manager is null) return;

        foreach (var s in _manager.GetSessions())
        {
            s.MediaPropertiesChanged += OnSessionEvent;
            s.PlaybackInfoChanged += OnSessionEvent;
            s.TimelinePropertiesChanged += OnSessionEvent;
            _hooked.Add(s);
        }
    }

    private void OnSessionEvent(Session sender, object args) => QueueRefresh();

    private Session? FindSession(string? appId) =>
        appId is null ? null : _manager?.GetSessions().FirstOrDefault(s => s.SourceAppUserModelId == appId);

    private Session? ChooseSession()
    {
        if (_manager is null) return null;
        var sessions = _manager.GetSessions().ToList();
        if (sessions.Count == 0) return null;

        bool IsPlaying(Session s)
        {
            try { return s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing; }
            catch { return false; }
        }
        bool IsPreferred(Session s) =>
            Preferred.Any(p => s.SourceAppUserModelId.Contains(p, StringComparison.OrdinalIgnoreCase));

        var playing = sessions.Where(IsPlaying).ToList();
        return playing.FirstOrDefault(IsPreferred)
            ?? playing.FirstOrDefault(s => s.SourceAppUserModelId == _currentAppId)
            ?? playing.FirstOrDefault()
            ?? sessions.FirstOrDefault(s => s.SourceAppUserModelId == _currentAppId)
            ?? sessions.FirstOrDefault(IsPreferred)
            ?? _manager.GetCurrentSession()
            ?? sessions[0];
    }

    // ---------------------------------------------------------------- refresh

    /// <summary>Safe from any thread: WinRT session events arrive on the thread pool.</summary>
    private void QueueRefresh() => _ui.Post(_ => QueueRefreshOnUi(), null);

    private void QueueRefreshOnUi()
    {
        if (_refreshQueued || _disposed) return;
        _refreshQueued = true;
        // Coalesce bursts of events (a track change fires several) into one refresh.
        _ui.Post(async _ =>
        {
            await Task.Delay(40);
            _refreshQueued = false;
            await RefreshAsync();
        }, null);
    }

    private async Task RefreshAsync()
    {
        if (_disposed) return;
        if (_refreshing) { _refreshAgain = true; return; }
        _refreshing = true;
        try
        {
            do
            {
                _refreshAgain = false;
                Publish(await ReadAsync());
            } while (_refreshAgain && !_disposed);
        }
        catch (Exception ex)
        {
            Log.Error("Media refresh failed", ex);
        }
        finally
        {
            _refreshing = false;
        }
    }

    private async Task<TrackState?> ReadAsync()
    {
        var session = ChooseSession();
        if (session is null)
        {
            _currentAppId = null;
            return null;
        }

        string appId = session.SourceAppUserModelId;
        _currentAppId = appId;

        GlobalSystemMediaTransportControlsSessionMediaProperties? props;
        try { props = await session.TryGetMediaPropertiesAsync(); }
        catch { return null; } // session vanished mid-read; the next event will sort it out
        if (props is null) return null;

        var playback = session.GetPlaybackInfo();
        var timeline = session.GetTimelineProperties();

        string title = props.Title ?? "";
        string artist = string.IsNullOrEmpty(props.Artist) ? props.AlbumArtist ?? "" : props.Artist;
        string album = props.AlbumTitle ?? "";
        if (title.Length == 0 && artist.Length == 0) return null;

        string key = $"{appId}\n{title}\n{artist}\n{album}";
        if (key != _trackKey)
        {
            _trackKey = key;
            _cover = null;
            _coverAttempts = 0;
        }
        // Spotify often announces the track before its thumbnail is ready: retry a few times.
        if (_cover is null && _coverAttempts < 5 && props.Thumbnail is not null)
        {
            _coverAttempts++;
            _cover = await SaveCoverAsync(props.Thumbnail);
            if (key != _trackKey) return Current; // track changed while we were reading
        }

        double duration = (timeline.EndTime - timeline.StartTime).TotalMilliseconds;
        double position = (timeline.Position - timeline.StartTime).TotalMilliseconds;
        var updated = timeline.LastUpdatedTime;
        long updatedAt = updated.Year < 2000 ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : updated.ToUnixTimeMilliseconds();

        var controls = playback.Controls;
        return new TrackState(
            title, artist, album, appId, FriendlyAppName(appId), _cover,
            playback.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing,
            Math.Max(0, position), Math.Max(0, duration), updatedAt,
            controls.IsPlayPauseToggleEnabled, controls.IsNextEnabled, controls.IsPreviousEnabled);
    }

    private void Publish(TrackState? state)
    {
        if (Equals(state, Current)) return;
        Current = state;
        Changed?.Invoke(state);
    }

    // ---------------------------------------------------------------- cover art

    private static async Task<string?> SaveCoverAsync(Windows.Storage.Streams.IRandomAccessStreamReference thumbnail)
    {
        try
        {
            using var stream = await thumbnail.OpenReadAsync();
            using var input = stream.AsStreamForRead();
            using var ms = new MemoryStream();
            await input.CopyToAsync(ms);
            if (ms.Length == 0) return null;

            byte[] bytes = ms.ToArray();
            string ext = bytes.Length > 4 && bytes[0] == 0x89 && bytes[1] == 0x50 ? "png" : "jpg";
            string name = $"{Convert.ToHexString(SHA1.HashData(bytes))[..16].ToLowerInvariant()}.{ext}";
            string path = Path.Combine(ArtDir, name);
            if (!File.Exists(path)) await File.WriteAllBytesAsync(path, bytes);
            return $"https://{CoverHost}/art/{name}";
        }
        catch (Exception ex)
        {
            Log.Error("Reading album art failed", ex);
            return null;
        }
    }

    /// <summary>Keeps the art cache small: the newest 100 covers.</summary>
    private static void PruneArt()
    {
        try
        {
            foreach (var f in new DirectoryInfo(ArtDir).GetFiles().OrderByDescending(f => f.LastWriteTimeUtc).Skip(100))
                f.Delete();
        }
        catch { }
    }

    // ---------------------------------------------------------------- names

    private static string FriendlyAppName(string appId)
    {
        string id = appId.ToLowerInvariant();
        (string match, string name)[] known =
        [
            ("spotify", "Spotify"), ("chrome", "Chrome"), ("msedge", "Edge"), ("firefox", "Firefox"),
            ("opera", "Opera"), ("brave", "Brave"), ("vlc", "VLC"), ("tidal", "TIDAL"),
            ("applemusic", "Apple Music"), ("itunes", "iTunes"), ("zunemusic", "Media Player"),
            ("deezer", "Deezer"), ("youtube", "YouTube Music"), ("foobar", "foobar2000"),
            ("musicbee", "MusicBee"), ("aimp", "AIMP"), ("gom", "GOM"), ("amazon", "Amazon Music"),
        ];
        foreach (var (match, name) in known)
            if (id.Contains(match)) return name;

        // "Something.exe" or "Publisher.App_hash!App" -> "Something" / "App"
        string s = appId;
        int bang = s.LastIndexOf('!');
        if (bang >= 0) s = s[(bang + 1)..];
        if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) s = s[..^4];
        return s.Length > 0 ? s : appId;
    }

    public void Dispose()
    {
        _disposed = true;
        _poll.Dispose();
        foreach (var s in _hooked)
        {
            s.MediaPropertiesChanged -= OnSessionEvent;
            s.PlaybackInfoChanged -= OnSessionEvent;
            s.TimelinePropertiesChanged -= OnSessionEvent;
        }
        _hooked.Clear();
    }
}
