using System.Text.Json.Nodes;

namespace Sonora.Widgets;

/// <summary>
/// The clickable parts of a hover-only layer (Star Mode), as reported by its page. Everything
/// outside them lets clicks through to the desktop.
/// </summary>
public static class HitAreas
{
    public static bool Hits(Rectangle[] areas, Point p)
    {
        foreach (var r in areas) if (r.Contains(p)) return true;
        return false;
    }

    /// <summary>[[x, y, w, h], ...] (physical px, possibly fractional) → rectangles; anything malformed is skipped.</summary>
    public static Rectangle[] Parse(JsonNode? node)
    {
        if (node is not JsonArray list) return [];
        var result = new List<Rectangle>();
        foreach (var item in list)
        {
            if (item is not JsonArray r || r.Count != 4) continue;
            try
            {
                double x = r[0]!.GetValue<double>(), y = r[1]!.GetValue<double>(), w = r[2]!.GetValue<double>(), h = r[3]!.GetValue<double>();
                if (w <= 0 || h <= 0 || !double.IsFinite(x + y + w + h)) continue;
                // Round outwards, so the button's edge pixels still count as the button.
                int left = (int)Math.Floor(x), top = (int)Math.Floor(y);
                result.Add(Rectangle.FromLTRB(left, top, (int)Math.Ceiling(x + w), (int)Math.Ceiling(y + h)));
            }
            catch (Exception) { /* not numbers */ }
        }
        return [.. result];
    }
}
