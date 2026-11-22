namespace Sonora.Media;

/// <summary>What is playing right now, as sent to the web side.</summary>
/// <param name="PositionMs">Position at <paramref name="UpdatedAt"/>; readers add the time since then while playing.</param>
/// <param name="Palette">A few bright colours taken from the cover (null without one). Same instance while the cover is unchanged.</param>
/// <param name="UpdatedAt">Unix ms when <paramref name="PositionMs"/> was true.</param>
public sealed record TrackState(
    string Title,
    string Artist,
    string Album,
    string AppId,
    string AppName,
    string? Cover,
    bool Playing,
    double PositionMs,
    double DurationMs,
    long UpdatedAt,
    bool CanToggle,
    bool CanNext,
    bool CanPrevious,
    IReadOnlyList<string>? Palette,
    bool CanSeek = false);
