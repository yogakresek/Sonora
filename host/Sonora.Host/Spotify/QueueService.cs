using System.Text.Json.Nodes;
using Sonora.Media;
using Sonora.Settings;

namespace Sonora.Spotify;

public sealed record QueueItem(string Title, string Artist, string? Cover, long DurationMs);

/// <param name="Status">"no-client" (no Client ID yet), "disconnected", "connecting", "ok", "empty" (nothing queued / no active device) or "error".</param>
public sealed record QueueState(string Status, IReadOnlyList<QueueItem> Items, IReadOnlyList<QueueItem> History, string? Error, string? ClientId);

/// <summary>
/// What plays next (from the Spotify Web API, once connected) and what played before (from the
/// media controls, always). Polls only while something shows the queue. Jumping to a queued song
/// presses "next" through the media controls the right number of times, so it works without
/// Spotify Premium and leaves the queue intact.
/// </summary>
public sealed class QueueService : IDisposable
{
    private const int MaxItems = 10;
    private const int MaxHistory = 8;

    private readonly SettingsStore _settings;
    private readonly MediaService _media;
    private readonly System.Windows.Forms.Timer _poll = new() { Interval = 5000 };
    private readonly System.Windows.Forms.Timer _soon = new() { Interval = 900 };
    private SpotifyClient _client;
    private readonly List<QueueItem> _history = [];
    private TrackState? _lastTrack;
    private int _active;
    private bool _busy, _skipping;
    private CancellationTokenSource? _connectCts;

    /// <summary>Raised on the UI thread.</summary>
    public event Action<QueueState>? Changed;

    public QueueState Current { get; private set; }

    public QueueService(SettingsStore settings, MediaService media)
    {
        _settings = settings;
        _media = media;
        _client = new SpotifyClient(settings.Current.SpotifyClientId);
        Current = Snapshot(_client.IsConnected ? "ok" : NotConnectedStatus(), [], null);

        _media.Changed += OnTrack;
        _poll.Tick += async (_, _) => await RefreshAsync();
        _soon.Tick += async (_, _) => { _soon.Stop(); await RefreshAsync(); };
    }

    private string NotConnectedStatus() => string.IsNullOrWhiteSpace(_settings.Current.SpotifyClientId) ? "no-client" : "disconnected";

    /// <summary>Something started (or stopped) showing the queue; polling runs while any is.</summary>
    public IDisposable Acquire()
    {
        if (_active++ == 0)
        {
            _poll.Start();
            _ = RefreshAsync();
        }
        return new Lease(this);
    }

    private void Release()
    {
        if (_active > 0 && --_active == 0) _poll.Stop();
    }

    // ---------------------------------------------------------------- connection

    public async Task ConnectAsync(string clientId)
    {
        clientId = clientId.Trim();
        if (clientId.Length < 16)
        {
            Publish(Snapshot("error", Current.Items, "Client ID tidak valid. Salin dari halaman app di developer.spotify.com."));
            return;
        }
        _connectCts?.Cancel();
        var cts = _connectCts = new CancellationTokenSource();
        _settings.Current.SpotifyClientId = clientId;
        _settings.Changed();
        Publish(Snapshot("connecting", [], null));
        try
        {
            _client.Dispose();
            _client = new SpotifyClient(clientId);
            await _client.ConnectAsync(clientId, cts.Token);
            await RefreshAsync(force: true);
        }
        catch (OperationCanceledException)
        {
            Publish(Snapshot("error", [], "Waktu login habis. Klik Sambungkan untuk mencoba lagi."));
        }
        catch (Exception ex)
        {
            Log.Error("Spotify connect failed", ex);
            Publish(Snapshot("error", [], ex.Message));
        }
    }

    public void Disconnect()
    {
        _connectCts?.Cancel();
        _client.Disconnect();
        Publish(Snapshot(NotConnectedStatus(), [], null));
    }

    // ---------------------------------------------------------------- queue

    private void OnTrack(TrackState? track)
    {
        // History: remember the song we just left.
        if (_lastTrack is { } last && (track is null || last.Title != track.Title || last.Artist != track.Artist))
        {
            _history.RemoveAll(h => h.Title == last.Title && h.Artist == last.Artist);
            _history.Insert(0, new QueueItem(last.Title, last.Artist, last.Cover, (long)last.DurationMs));
            if (_history.Count > MaxHistory) _history.RemoveRange(MaxHistory, _history.Count - MaxHistory);
            Publish(Snapshot(Current.Status, Current.Items, Current.Error));
            // Spotify updates its queue a moment after the track changes.
            if (_active > 0) { _soon.Stop(); _soon.Start(); }
        }
        if (track is not null) _lastTrack = track;
    }

    public async Task RefreshAsync(bool force = false)
    {
        if (_busy || (!force && _active == 0)) return;
        if (!_client.IsConnected)
        {
            if (Current.Status is not ("connecting" or "error")) Publish(Snapshot(NotConnectedStatus(), [], null));
            return;
        }
        _busy = true;
        try
        {
            var json = await _client.GetQueueAsync(CancellationToken.None);
            var items = (json?["queue"] as JsonArray)?.Select(Map).OfType<QueueItem>().Take(MaxItems).ToList() ?? [];
            Publish(Snapshot(items.Count > 0 ? "ok" : "empty", items, null));
        }
        catch (Exception ex)
        {
            Log.Error("Spotify queue failed", ex);
            Publish(Snapshot(_client.IsConnected ? "error" : NotConnectedStatus(), Current.Items, _client.IsConnected ? ex.Message : null));
        }
        finally
        {
            _busy = false;
        }
    }

    /// <summary>Jumps to the queued song at <paramref name="index"/> (0 = next).</summary>
    public async Task PlayAsync(int index)
    {
        if (_skipping || index < 0 || index >= Current.Items.Count) return;
        _skipping = true;
        try
        {
            for (int i = 0; i <= index; i++)
            {
                await _media.CommandAsync("next");
                await Task.Delay(i == index ? 200 : 450);
            }
        }
        finally
        {
            _skipping = false;
        }
        _soon.Stop();
        _soon.Start();
    }

    private static QueueItem? Map(JsonNode? node)
    {
        if (node is null) return null;
        string title = (string?)node["name"] ?? "";
        if (title.Length == 0) return null;
        string artist = node["artists"] is JsonArray artists
            ? string.Join(", ", artists.Select(a => (string?)a?["name"]).Where(n => !string.IsNullOrEmpty(n)))
            : (string?)node["show"]?["name"] ?? "";
        var images = (node["album"]?["images"] ?? node["images"] ?? node["show"]?["images"]) as JsonArray;
        // Smallest image that is still at least 64 px.
        string? cover = images?
            .Select(i => (url: (string?)i?["url"], w: (int?)i?["width"] ?? 0))
            .Where(i => i.url is not null)
            .OrderBy(i => i.w >= 64 ? i.w : int.MaxValue)
            .Select(i => i.url)
            .FirstOrDefault();
        return new QueueItem(title, artist, cover, (long?)node["duration_ms"] ?? 0);
    }

    private QueueState Snapshot(string status, IReadOnlyList<QueueItem> items, string? error) =>
        new(status, items, _history.ToList(), error, _settings.Current.SpotifyClientId);

    private void Publish(QueueState state)
    {
        Current = state;
        Changed?.Invoke(state);
    }

    public void Dispose()
    {
        _connectCts?.Cancel();
        _poll.Dispose();
        _soon.Dispose();
        _client.Dispose();
    }

    private sealed class Lease(QueueService owner) : IDisposable
    {
        private bool _done;
        public void Dispose()
        {
            if (_done) return;
            _done = true;
            owner.Release();
        }
    }
}
