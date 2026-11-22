using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Sonora.Media;

namespace Sonora.Content;

public sealed record LyricLine(int T, string Text);

/// <param name="Key">Which track these belong to (title + artist), so stale results can be ignored.</param>
/// <param name="Status">"loading", "synced", "plain" (no timings), "none" or "error".</param>
public sealed record LyricsState(string Key, string Status, IReadOnlyList<LyricLine> Lines, string? Plain);

/// <summary>
/// Fetches lyrics for the current track from LRCLIB (free, community-run, no account) and caches
/// them under data/cache/lyrics. Tries an exact match first, then a search with the title cleaned
/// of streaming-service decorations ("- Remastered 2011", "(with …)", "(feat. …)").
/// </summary>
public sealed partial class LyricsService : IDisposable
{
    private const string Api = "https://lrclib.net/api";
    private static readonly TimeSpan RetryNotFoundAfter = TimeSpan.FromDays(3);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _http;
    private readonly string _cacheDir = Path.Combine(AppInfo.CacheDir, "lyrics");
    private CancellationTokenSource? _cts;
    private string? _key;

    /// <summary>Raised on the UI thread.</summary>
    public event Action<LyricsState?>? Changed;

    public LyricsState? Current { get; private set; }

    public LyricsService(MediaService media)
    {
        _http = new HttpClient(new SocketsHttpHandler { AutomaticDecompression = DecompressionMethods.All })
        {
            Timeout = TimeSpan.FromSeconds(10),
        };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd($"{AppInfo.Name}/{AppInfo.Version} (desktop music widget)");
        Directory.CreateDirectory(_cacheDir);
        media.Changed += OnTrack;
    }

    public static string KeyFor(TrackState t) => $"{t.Title}\n{t.Artist}";

    private async void OnTrack(TrackState? track)
    {
        string? key = track is null ? null : KeyFor(track);
        if (key == _key) return;
        _key = key;

        _cts?.Cancel();
        if (track is null || string.IsNullOrWhiteSpace(track.Title))
        {
            Publish(null);
            return;
        }

        var cts = _cts = new CancellationTokenSource();
        Publish(new LyricsState(key!, "loading", [], null));
        try
        {
            // Skipping through songs quickly shouldn't hammer the API.
            await Task.Delay(250, cts.Token);
            var result = await LoadAsync(track, key!, cts.Token);
            if (!cts.IsCancellationRequested) Publish(result);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Log.Error("Lyrics lookup failed", ex);
            if (!cts.IsCancellationRequested) Publish(new LyricsState(key!, "error", [], null));
        }
    }

    private void Publish(LyricsState? state)
    {
        Current = state;
        Changed?.Invoke(state);
    }

    // ---------------------------------------------------------------- lookup

    private async Task<LyricsState> LoadAsync(TrackState track, string key, CancellationToken ct)
    {
        string cacheFile = Path.Combine(_cacheDir, Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(key)))[..20] + ".json");
        if (File.Exists(cacheFile))
        {
            try
            {
                var cached = JsonSerializer.Deserialize<CacheEntry>(await File.ReadAllTextAsync(cacheFile, ct), Json);
                if (cached is not null && (cached.Status != "none" || DateTime.UtcNow - cached.FetchedAt < RetryNotFoundAfter))
                    return Build(key, cached);
            }
            catch (JsonException) { }
        }

        var record = await FindAsync(track, ct);
        var entry = new CacheEntry
        {
            Status = record?.SyncedLyrics is { Length: > 0 } ? "synced" : record?.PlainLyrics is { Length: > 0 } ? "plain" : "none",
            Synced = record?.SyncedLyrics,
            Plain = record?.PlainLyrics,
            FetchedAt = DateTime.UtcNow,
        };
        await File.WriteAllTextAsync(cacheFile, JsonSerializer.Serialize(entry, Json), ct);
        return Build(key, entry);
    }

    private async Task<LrcRecord?> FindAsync(TrackState t, CancellationToken ct)
    {
        int seconds = (int)Math.Round(t.DurationMs / 1000);
        string artist = PrimaryArtist(t.Artist);

        // 1. Exact match (needs every field).
        if (seconds > 0 && t.Album.Length > 0)
        {
            var exact = await GetAsync<LrcRecord>(
                $"{Api}/get?track_name={E(t.Title)}&artist_name={E(t.Artist)}&album_name={E(t.Album)}&duration={seconds}", ct);
            if (exact is { SyncedLyrics.Length: > 0 }) return exact;
        }

        // 2. Searches, from most to least specific.
        var titles = new[] { t.Title, CleanTitle(t.Title) }.Distinct().ToList();
        LrcRecord? bestPlain = null;
        foreach (var title in titles)
        {
            var found = await GetAsync<LrcRecord[]>($"{Api}/search?track_name={E(title)}&artist_name={E(artist)}", ct);
            var pick = Pick(found, seconds);
            if (pick is { SyncedLyrics.Length: > 0 }) return pick;
            bestPlain ??= pick;
        }

        // 3. Free-text search as a last resort.
        var loose = await GetAsync<LrcRecord[]>($"{Api}/search?q={E($"{CleanTitle(t.Title)} {artist}")}", ct);
        return Pick(loose, seconds) ?? bestPlain;
    }

    /// <summary>Prefers synced lyrics whose duration is within a few seconds of the track.</summary>
    private static LrcRecord? Pick(LrcRecord[]? results, int seconds)
    {
        if (results is null || results.Length == 0) return null;
        double Distance(LrcRecord r) => seconds > 0 && r.Duration > 0 ? Math.Abs(r.Duration - seconds) : 0;
        return results
            .Where(r => !r.Instrumental)
            .Where(r => seconds <= 0 || r.Duration <= 0 || Distance(r) <= 8)
            .OrderByDescending(r => r.SyncedLyrics is { Length: > 0 })
            .ThenBy(Distance)
            .FirstOrDefault();
    }

    private async Task<T?> GetAsync<T>(string url, CancellationToken ct) where T : class
    {
        using var response = await _http.GetAsync(url, ct);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return JsonSerializer.Deserialize<T>(await response.Content.ReadAsStringAsync(ct), Json);
    }

    private static string E(string s) => Uri.EscapeDataString(s);

    // ---------------------------------------------------------------- parsing

    private static LyricsState Build(string key, CacheEntry e) => e.Status switch
    {
        "synced" => new LyricsState(key, "synced", ParseLrc(e.Synced ?? ""), e.Plain),
        "plain" => new LyricsState(key, "plain", [], e.Plain),
        _ => new LyricsState(key, "none", [], null),
    };

    /// <summary>Parses "[mm:ss.xx] text" lines (a line may carry several timestamps).</summary>
    public static IReadOnlyList<LyricLine> ParseLrc(string lrc)
    {
        var lines = new List<LyricLine>();
        foreach (var raw in lrc.Split('\n'))
        {
            var stamps = TimeTag().Matches(raw);
            if (stamps.Count == 0) continue;
            string text = TimeTag().Replace(raw, "").Trim();
            foreach (Match m in stamps)
            {
                int min = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
                double sec = double.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
                lines.Add(new LyricLine((int)Math.Round((min * 60 + sec) * 1000), text));
            }
        }
        lines.Sort((a, b) => a.T.CompareTo(b.T));
        return lines;
    }

    /// <summary>"Song (with X) - Remastered 2011" → "Song".</summary>
    public static string CleanTitle(string title)
    {
        string s = DashSuffix().Replace(title, "");
        s = Decoration().Replace(s, "");
        s = s.Trim();
        return s.Length > 0 ? s : title;
    }

    /// <summary>"A, B & C" / "A feat. B" → "A".</summary>
    public static string PrimaryArtist(string artist)
    {
        string s = ArtistSplit().Split(artist)[0].Trim();
        return s.Length > 0 ? s : artist;
    }

    [GeneratedRegex(@"\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]")]
    private static partial Regex TimeTag();

    [GeneratedRegex(@"\s+-\s+.*$")]
    private static partial Regex DashSuffix();

    [GeneratedRegex(@"\s*[\(\[](?:feat\.?|ft\.?|with|from|remaster|live|version|edit|radio|explicit|clean|mono|stereo|deluxe|bonus)[^\)\]]*[\)\]]", RegexOptions.IgnoreCase)]
    private static partial Regex Decoration();

    [GeneratedRegex(@"\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|\band\b)\s*", RegexOptions.IgnoreCase)]
    private static partial Regex ArtistSplit();

    public void Dispose()
    {
        _cts?.Cancel();
        _http.Dispose();
    }

    private sealed class CacheEntry
    {
        public string Status { get; set; } = "none";
        public string? Synced { get; set; }
        public string? Plain { get; set; }
        public DateTime FetchedAt { get; set; }
    }

    private sealed class LrcRecord
    {
        public string? TrackName { get; set; }
        public string? ArtistName { get; set; }
        // LRCLIB sometimes sends null here; one such entry used to fail the whole search.
        [System.Text.Json.Serialization.JsonPropertyName("duration")]
        public double? RawDuration { get; set; }
        [System.Text.Json.Serialization.JsonIgnore]
        public double Duration => RawDuration ?? 0;
        [System.Text.Json.Serialization.JsonPropertyName("instrumental")]
        public bool? RawInstrumental { get; set; }
        [System.Text.Json.Serialization.JsonIgnore]
        public bool Instrumental => RawInstrumental ?? false;
        public string? PlainLyrics { get; set; }
        public string? SyncedLyrics { get; set; }
    }
}
