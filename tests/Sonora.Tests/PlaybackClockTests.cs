using Sonora.Media;

namespace Sonora.Tests;

/// <summary>Scenarios measured from Spotify's media session (reports every ~4.5 s).</summary>
public class PlaybackClockTests
{
    private const long T0 = 1_800_000_000_000;

    /// <summary>Where the web side will place the song at <paramref name="now"/>.</summary>
    private static double At((double Pos, long At) c, long now, bool playing) => c.Pos + (playing ? now - c.At : 0);

    [Fact]
    public void Steady_playback_follows_the_reports()
    {
        var clock = new PlaybackClock();
        var c = clock.Update("A", true, 94_532, T0 - 2_799, 200_000, T0);
        Assert.Equal(97_331, At(c, T0, true), 0);

        // Same report polled again: nothing moves.
        c = clock.Update("A", true, 94_532, T0 - 2_799, 200_000, T0 + 1_000);
        Assert.Equal(98_331, At(c, T0 + 1_000, true), 0);

        // Next report 4.5 s later agrees within a few ms.
        c = clock.Update("A", true, 99_043, T0 + 1_678, 200_000, T0 + 2_000);
        Assert.InRange(At(c, T0 + 2_000, true), 99_300, 99_400);
    }

    [Fact]
    public void A_new_song_ignores_the_previous_songs_last_report()
    {
        var clock = new PlaybackClock();
        clock.Update("A", true, 180_000, T0 - 1_000, 200_000, T0);

        // Song B is announced, but the timeline still says 3:20 from 3 s ago.
        var c = clock.Update("B", true, 200_000, T0 + 2_000, 240_000, T0 + 5_000);
        Assert.InRange(At(c, T0 + 5_000, true), 0, 50);
        Assert.InRange(At(c, T0 + 7_000, true), 1_950, 2_050);

        // That stale report polled again changes nothing...
        c = clock.Update("B", true, 200_000, T0 + 2_000, 240_000, T0 + 6_000);
        Assert.InRange(At(c, T0 + 6_000, true), 950, 1_050);

        // ...until Spotify sends a real one for song B.
        c = clock.Update("B", true, 1_400, T0 + 6_500, 240_000, T0 + 6_600);
        Assert.InRange(At(c, T0 + 6_600, true), 1_450, 1_550);
    }

    [Fact]
    public void A_fresh_report_with_a_new_song_is_trusted()
    {
        var clock = new PlaybackClock();
        clock.Update("A", true, 180_000, T0 - 1_000, 200_000, T0);
        var c = clock.Update("B", true, 300, T0 + 4_900, 240_000, T0 + 5_000);
        Assert.InRange(At(c, T0 + 5_000, true), 350, 450);
    }

    [Fact]
    public void Pause_freezes_and_resume_continues_without_a_jump()
    {
        var clock = new PlaybackClock();
        clock.Update("A", true, 130_613, T0, 200_000, T0);

        // Paused at T0+3 s; the timeline still carries the old report.
        var c = clock.Update("A", false, 130_613, T0, 200_000, T0 + 3_000);
        Assert.InRange(At(c, T0 + 3_000, false), 133_600, 133_620);
        Assert.InRange(At(c, T0 + 9_000, false), 133_600, 133_620); // stays frozen

        // Spotify's own pause report lands.
        c = clock.Update("A", false, 133_773, T0 + 3_400, 200_000, T0 + 3_500);
        Assert.Equal(133_773, At(c, T0 + 9_000, false), 0);

        // Resumed at T0+10 s, before Spotify reports again: continue from the frozen spot.
        c = clock.Update("A", true, 133_773, T0 + 3_400, 200_000, T0 + 10_000);
        Assert.InRange(At(c, T0 + 11_000, true), 134_700, 134_800);
    }

    [Fact]
    public void A_seek_is_followed_immediately()
    {
        var clock = new PlaybackClock();
        clock.Update("A", true, 10_000, T0, 200_000, T0);
        var c = clock.Update("A", true, 120_000, T0 + 2_000, 200_000, T0 + 2_100);
        Assert.InRange(At(c, T0 + 2_100, true), 120_050, 120_150);
    }
}
