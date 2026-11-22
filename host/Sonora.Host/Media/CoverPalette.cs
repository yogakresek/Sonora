using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace Sonora.Media;

/// <summary>
/// Picks a few colours from album art that glow well on a dark desktop: buckets the pixels by
/// hue/saturation/brightness, ranks buckets by how much of the cover they cover and how vivid
/// they are, and lifts the winners' brightness so they read as light.
/// </summary>
public static class CoverPalette
{
    public static string[] FromImage(byte[] imageBytes, int count = 3)
    {
        using var ms = new MemoryStream(imageBytes);
        using var src = Image.FromStream(ms);
        const int size = 48;
        using var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBilinear;
            g.DrawImage(src, 0, 0, size, size);
        }

        var buckets = new Dictionary<int, (int n, double r, double g, double b, double s, double v)>();
        for (int y = 0; y < size; y++)
        for (int x = 0; x < size; x++)
        {
            var c = bmp.GetPixel(x, y);
            if (c.A < 128) continue;
            var (h, s, v) = Hsv(c);
            int key = (int)(h / 30) * 100 + Math.Min(2, (int)(s * 3)) * 10 + Math.Min(2, (int)(v * 3));
            var e = buckets.GetValueOrDefault(key);
            buckets[key] = (e.n + 1, e.r + c.R, e.g + c.G, e.b + c.B, e.s + s, e.v + v);
        }

        var ranked = buckets
            .Select(kv =>
            {
                var e = kv.Value;
                var color = Color.FromArgb((int)(e.r / e.n), (int)(e.g / e.n), (int)(e.b / e.n));
                double s = e.s / e.n, v = e.v / e.n;
                double score = e.n * (0.15 + s) * (0.25 + v);
                return (color, score, s);
            })
            .OrderByDescending(x => x.score)
            .ToList();

        var picked = new List<Color>();
        foreach (var (color, _, sat) in ranked)
        {
            if (picked.Count >= count) break;
            if (sat < 0.12 && picked.Count < count - 1 && ranked.Any(r => r.s >= 0.12)) continue; // greys last
            if (picked.Any(p => HueDistance(p, color) < 28 && Math.Abs(Hsv(p).v - Hsv(color).v) < 0.25)) continue;
            picked.Add(color);
        }

        if (picked.Count == 0) picked.Add(Color.FromArgb(168, 85, 247));
        while (picked.Count < count) picked.Add(Rotate(picked[^1], 40));

        return picked.Select(c => Hex(Lift(c))).ToArray();
    }

    private static (double h, double s, double v) Hsv(Color c)
    {
        double r = c.R / 255.0, g = c.G / 255.0, b = c.B / 255.0;
        double max = Math.Max(r, Math.Max(g, b)), min = Math.Min(r, Math.Min(g, b)), d = max - min;
        double h = d == 0 ? 0 : max == r ? 60 * (((g - b) / d) % 6) : max == g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
        if (h < 0) h += 360;
        return (h, max == 0 ? 0 : d / max, max);
    }

    private static Color FromHsv(double h, double s, double v)
    {
        double c = v * s, x = c * (1 - Math.Abs(h / 60 % 2 - 1)), m = v - c;
        (double r, double g, double b) = h switch
        {
            < 60 => (c, x, 0d), < 120 => (x, c, 0d), < 180 => (0d, c, x),
            < 240 => (0d, x, c), < 300 => (x, 0d, c), _ => (c, 0d, x),
        };
        return Color.FromArgb((int)((r + m) * 255), (int)((g + m) * 255), (int)((b + m) * 255));
    }

    private static double HueDistance(Color a, Color b)
    {
        double d = Math.Abs(Hsv(a).h - Hsv(b).h);
        return Math.Min(d, 360 - d);
    }

    /// <summary>Bright enough to glow; keeps hue, nudges saturation up a little.</summary>
    private static Color Lift(Color c)
    {
        var (h, s, v) = Hsv(c);
        return FromHsv(h, Math.Min(1, s < 0.12 ? s : s * 1.1 + 0.05), Math.Max(v, 0.82));
    }

    private static Color Rotate(Color c, double degrees)
    {
        var (h, s, v) = Hsv(c);
        return FromHsv((h + degrees) % 360, Math.Max(s, 0.5), v);
    }

    private static string Hex(Color c) => $"#{c.R:x2}{c.G:x2}{c.B:x2}";
}
