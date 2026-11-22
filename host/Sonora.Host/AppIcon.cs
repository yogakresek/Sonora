using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace Sonora;

/// <summary>Draws the placeholder app icon (a ring with a few spectrum bars) until there is real artwork.</summary>
public static class AppIcon
{
    public static Icon Create(int size)
    {
        using var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);

            float s = size;
            using var bg = new LinearGradientBrush(new RectangleF(0, 0, s, s),
                Color.FromArgb(255, 124, 58, 237), Color.FromArgb(255, 34, 211, 238), 45f);
            g.FillEllipse(bg, 1, 1, s - 2, s - 2);

            float[] heights = [0.30f, 0.55f, 0.80f, 0.55f, 0.30f];
            float barW = s / 11f, gap = s / 22f;
            float total = heights.Length * barW + (heights.Length - 1) * gap;
            float x = (s - total) / 2f;
            using var white = new SolidBrush(Color.White);
            foreach (var h in heights)
            {
                float bh = s * 0.6f * h;
                g.FillRectangle(white, x, (s - bh) / 2f, barW, bh);
                x += barW + gap;
            }
        }

        // Icon.FromHandle does not own the handle; clone so the handle can be freed.
        var hIcon = bmp.GetHicon();
        try
        {
            using var temp = Icon.FromHandle(hIcon);
            return (Icon)temp.Clone();
        }
        finally
        {
            DestroyIcon(hIcon);
        }
    }

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr handle);
}
