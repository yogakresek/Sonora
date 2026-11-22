using System.Drawing;
using System.Text.Json.Nodes;
using Sonora.Widgets;

namespace Sonora.Tests;

/// <summary>Star Mode takes clicks only on its buttons; everything else must reach the desktop.</summary>
public class HitAreasTests
{
    private static Rectangle[] Parse(string json) => HitAreas.Parse(JsonNode.Parse(json));

    [Fact]
    public void Fractional_rects_from_the_page_round_outwards()
    {
        var r = Parse("[[1357.5, 41.25, 120.4, 44.1]]");
        Assert.Single(r);
        Assert.True(HitAreas.Hits(r, new Point(1357, 41)));   // top-left edge pixel
        Assert.True(HitAreas.Hits(r, new Point(1477, 85)));   // bottom-right edge pixel
        Assert.False(HitAreas.Hits(r, new Point(1479, 86)));
    }

    [Fact]
    public void Card_and_exit_button_both_take_clicks_and_the_sky_does_not()
    {
        var r = Parse("[[100, 1200, 500, 160], [1300, 30, 120, 40]]");
        Assert.True(HitAreas.Hits(r, new Point(300, 1250)));  // the now-playing card
        Assert.True(HitAreas.Hits(r, new Point(1350, 50)));   // "Keluar"
        Assert.False(HitAreas.Hits(r, new Point(1280, 700))); // the middle of the sky
    }

    [Fact]
    public void Empty_or_broken_input_means_nothing_is_clickable()
    {
        Assert.Empty(Parse("[]"));
        Assert.Empty(Parse("null"));
        Assert.Empty(Parse("[[1, 2, 3]]"));
        Assert.Empty(Parse("[[\"a\", 2, 3, 4]]"));
        Assert.Empty(Parse("[[10, 10, 0, 50]]"));
        Assert.Empty(HitAreas.Parse(null));
        Assert.Single(Parse("[[1, 2, 3], [5, 5, 10, 10], {\"x\": 1}]"));
    }
}
