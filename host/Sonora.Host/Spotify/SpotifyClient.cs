using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Sonora.Spotify;

/// <summary>
/// Optional connection to the Spotify Web API, used only to read the play queue (Windows' media
/// controls don't expose it).
///
/// Sign-in is OAuth "authorization code with PKCE": no client secret, so the app can be shared.
/// The user registers their own app on developer.spotify.com (free) and pastes its Client ID;
/// the redirect comes back to a one-shot listener on 127.0.0.1. Only read scopes are asked for.
/// The refresh token is stored encrypted for the current Windows user (DPAPI).
/// </summary>
public sealed class SpotifyClient : IDisposable
{
    public const int CallbackPort = 43821;
    public static readonly string RedirectUri = $"http://127.0.0.1:{CallbackPort}/callback";
    private const string Scopes = "user-read-playback-state user-read-currently-playing";

    private static readonly string TokenFile = Path.Combine(AppInfo.DataDir, "spotify-token.bin");
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Sonora.Spotify.v1");

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(12) };
    private string? _clientId;
    private string? _refreshToken;
    private string? _accessToken;
    private DateTimeOffset _expiresAt;

    public bool IsConnected => _refreshToken is not null && _clientId is not null;

    public SpotifyClient(string? clientId)
    {
        _clientId = string.IsNullOrWhiteSpace(clientId) ? null : clientId.Trim();
        LoadToken();
    }

    // ---------------------------------------------------------------- sign-in

    /// <summary>Opens the browser for sign-in and waits for the redirect (up to 3 minutes).</summary>
    public async Task ConnectAsync(string clientId, CancellationToken ct)
    {
        _clientId = clientId.Trim();
        string verifier = Base64Url(RandomNumberGenerator.GetBytes(48));
        string challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        string state = Base64Url(RandomNumberGenerator.GetBytes(16));

        using var listener = new TcpListener(IPAddress.Loopback, CallbackPort);
        listener.Start();

        string url = "https://accounts.spotify.com/authorize" +
            $"?client_id={Uri.EscapeDataString(_clientId)}&response_type=code" +
            $"&redirect_uri={Uri.EscapeDataString(RedirectUri)}" +
            $"&code_challenge_method=S256&code_challenge={challenge}" +
            $"&scope={Uri.EscapeDataString(Scopes)}&state={state}";
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(3));

        while (true)
        {
            using var socket = await listener.AcceptTcpClientAsync(timeout.Token);
            var query = await ReadRequestQueryAsync(socket, timeout.Token);
            if (query is null) continue; // favicon or similar

            query.TryGetValue("error", out var error);
            query.TryGetValue("code", out var code);
            query.TryGetValue("state", out var returnedState);
            bool ok = error is null && code is not null && returnedState == state;
            await RespondAsync(socket, ok, error);
            if (!ok) throw new InvalidOperationException(error ?? "Login dibatalkan atau tidak valid.");

            await TokenRequestAsync(new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["code"] = code!,
                ["redirect_uri"] = RedirectUri,
                ["client_id"] = _clientId,
                ["code_verifier"] = verifier,
            }, timeout.Token);
            Log.Info("Spotify connected");
            return;
        }
    }

    public void Disconnect()
    {
        _refreshToken = _accessToken = null;
        try { File.Delete(TokenFile); } catch { }
        Log.Info("Spotify disconnected");
    }

    private static async Task<Dictionary<string, string>?> ReadRequestQueryAsync(TcpClient socket, CancellationToken ct)
    {
        var stream = socket.GetStream();
        var buffer = new byte[8192];
        int n = await stream.ReadAsync(buffer, ct);
        string head = Encoding.ASCII.GetString(buffer, 0, n);
        // "GET /callback?code=...&state=... HTTP/1.1"
        var line = head.Split("\r\n")[0].Split(' ');
        if (line.Length < 2 || !line[1].StartsWith("/callback", StringComparison.Ordinal)) return null;
        int q = line[1].IndexOf('?');
        var result = new Dictionary<string, string>();
        if (q < 0) return result;
        foreach (var pair in line[1][(q + 1)..].Split('&'))
        {
            int eq = pair.IndexOf('=');
            if (eq > 0) result[Uri.UnescapeDataString(pair[..eq])] = Uri.UnescapeDataString(pair[(eq + 1)..]);
        }
        return result;
    }

    private static async Task RespondAsync(TcpClient socket, bool ok, string? error)
    {
        string body = $"""
            <!doctype html><meta charset="utf-8"><title>Sonora</title>
            <body style="background:#0f0f14;color:#f1f1f5;font:16px 'Segoe UI',sans-serif;display:grid;place-items:center;height:100vh;margin:0">
            <div style="text-align:center"><div style="font-size:42px">{(ok ? "✓" : "✕")}</div>
            <h2>{(ok ? "Spotify tersambung ke Sonora" : "Gagal menyambungkan Spotify")}</h2>
            <p style="color:#a7a7b8">{(ok ? "Tab ini boleh ditutup." : WebUtility.HtmlEncode(error ?? "Coba lagi dari dashboard Sonora."))}</p></div>
            """;
        byte[] bytes = Encoding.UTF8.GetBytes(body);
        string header = $"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n";
        var stream = socket.GetStream();
        await stream.WriteAsync(Encoding.ASCII.GetBytes(header));
        await stream.WriteAsync(bytes);
    }

    // ---------------------------------------------------------------- tokens

    private async Task TokenRequestAsync(Dictionary<string, string> form, CancellationToken ct)
    {
        using var response = await _http.PostAsync("https://accounts.spotify.com/api/token", new FormUrlEncodedContent(form), ct);
        string json = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode is HttpStatusCode.BadRequest && form["grant_type"] == "refresh_token") Disconnect();
            throw new InvalidOperationException($"Token Spotify ditolak ({(int)response.StatusCode}).");
        }
        var doc = JsonNode.Parse(json)!;
        _accessToken = (string?)doc["access_token"];
        _expiresAt = DateTimeOffset.UtcNow.AddSeconds(((int?)doc["expires_in"] ?? 3600) - 60);
        if ((string?)doc["refresh_token"] is { } refresh) _refreshToken = refresh;
        SaveToken();
    }

    private async Task<string> AccessTokenAsync(CancellationToken ct)
    {
        if (_accessToken is not null && DateTimeOffset.UtcNow < _expiresAt) return _accessToken;
        if (_refreshToken is null || _clientId is null) throw new InvalidOperationException("Spotify belum tersambung.");
        await TokenRequestAsync(new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = _refreshToken,
            ["client_id"] = _clientId,
        }, ct);
        return _accessToken!;
    }

    private void SaveToken()
    {
        if (_refreshToken is null || _clientId is null) return;
        var payload = JsonSerializer.SerializeToUtf8Bytes(new { clientId = _clientId, refreshToken = _refreshToken });
        File.WriteAllBytes(TokenFile, ProtectedData.Protect(payload, Entropy, DataProtectionScope.CurrentUser));
    }

    private void LoadToken()
    {
        try
        {
            if (!File.Exists(TokenFile)) return;
            var json = JsonNode.Parse(ProtectedData.Unprotect(File.ReadAllBytes(TokenFile), Entropy, DataProtectionScope.CurrentUser));
            string? clientId = (string?)json?["clientId"];
            // A token belongs to the Client ID it was issued for.
            if (clientId is null || (_clientId is not null && clientId != _clientId)) return;
            _clientId = clientId;
            _refreshToken = (string?)json?["refreshToken"];
        }
        catch (Exception ex)
        {
            Log.Error("Reading Spotify token failed", ex);
        }
    }

    // ---------------------------------------------------------------- API

    /// <summary>GET /me/player/queue: what plays now and what comes next.</summary>
    public async Task<JsonNode?> GetQueueAsync(CancellationToken ct)
    {
        for (int attempt = 0; attempt < 2; attempt++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.spotify.com/v1/me/player/queue");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await AccessTokenAsync(ct));
            using var response = await _http.SendAsync(request, ct);
            if (response.StatusCode == HttpStatusCode.Unauthorized && attempt == 0) { _accessToken = null; continue; }
            if (response.StatusCode == HttpStatusCode.NoContent) return null;
            if ((int)response.StatusCode == 429) throw new InvalidOperationException("Terlalu sering meminta antrean; coba sebentar lagi.");
            response.EnsureSuccessStatusCode();
            return JsonNode.Parse(await response.Content.ReadAsStringAsync(ct));
        }
        return null;
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public void Dispose() => _http.Dispose();
}
