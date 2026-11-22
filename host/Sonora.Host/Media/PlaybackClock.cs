namespace Sonora.Media;

/// <summary>
/// Turns the media session's sparse timeline into a position the lyrics can trust.
///
/// Spotify reports its position only every ~4.5 s (measured), as "position P was true at time T";
/// between reports we extrapolate, which is accurate to ~10 ms while it plays. What goes wrong is
/// the edges, so this keeps its own anchor and only accepts a report when it really is newer:
///  - A new song is often announced while the timeline still holds the previous song's last report
///    (late in that song). Taking it would jump the lyrics far ahead for seconds. A report older
///    than the song change is ignored and the song is assumed to start at 0 from that moment.
///  - Pause / resume: the status flips before a fresh report arrives. We freeze or restart from our
///    own estimate at the flip, and ignore any report that predates it.
/// </summary>
public sealed class PlaybackClock
{
    /// <summary>A report this much older than a song change belongs to the previous song.</summary>
    private const long StaleBeforeChangeMs = 1000;

    private string? _track;
    private long _trackSince;
    private bool _playing;
    private long _statusSince;
    private double _pos;
    private long _at;
    private double _lastReportPos = double.NaN;
    private long _lastReportAt = long.MinValue;

    /// <param name="reportedAt">Unix ms when <paramref name="reportedPos"/> was true, or null if the session gave no usable time.</param>
    /// <returns>Position (ms) that was true at <c>At</c> (unix ms).</returns>
    public (double Pos, long At) Update(string track, bool playing, double reportedPos, long? reportedAt, double durationMs, long now)
    {
        long reportTime = Math.Min(reportedAt ?? now, now);
        // A report is new if its position or its timestamp moved (without a timestamp, only the position counts).
        bool fresh = reportedPos != _lastReportPos || (reportedAt is not null && reportTime != _lastReportAt);
        _lastReportPos = reportedPos;
        if (reportedAt is not null) _lastReportAt = reportTime;

        if (track != _track)
        {
            bool first = _track is null;
            _track = track;
            _trackSince = now;
            _playing = playing;
            _statusSince = now;
            bool stale = !first && reportTime < now - StaleBeforeChangeMs;
            if (stale) (_pos, _at) = (0, now);
            else (_pos, _at) = (reportedPos, playing ? reportTime : now);
            return Clamp(durationMs);
        }

        if (playing != _playing)
        {
            // Freeze (or resume) from where we think the song is right now.
            _pos = Estimate(now);
            _at = now;
            _playing = playing;
            _statusSince = now;
        }

        if (fresh && reportTime >= _statusSince - 300 && reportTime >= _trackSince - 300)
        {
            _pos = reportedPos;
            _at = playing ? reportTime : now;
        }
        return Clamp(durationMs);
    }

    private double Estimate(long now) => _pos + (_playing ? now - _at : 0);

    private (double, long) Clamp(double durationMs)
    {
        double pos = Math.Max(0, durationMs > 0 ? Math.Min(_pos, durationMs) : _pos);
        return (pos, _at);
    }
}
