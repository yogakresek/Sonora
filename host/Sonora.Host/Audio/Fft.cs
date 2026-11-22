namespace Sonora.Audio;

/// <summary>In-place radix-2 complex FFT with precomputed twiddles. Not thread-safe; one per analyser.</summary>
public sealed class Fft
{
    public int Size { get; }
    private readonly int[] _rev;
    private readonly float[] _cos;
    private readonly float[] _sin;

    public Fft(int size)
    {
        if (size < 2 || (size & (size - 1)) != 0) throw new ArgumentException("Size must be a power of two.", nameof(size));
        Size = size;

        int bits = (int)Math.Log2(size);
        _rev = new int[size];
        for (int i = 0; i < size; i++)
        {
            int r = 0;
            for (int b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
            _rev[i] = r;
        }

        _cos = new float[size / 2];
        _sin = new float[size / 2];
        for (int i = 0; i < size / 2; i++)
        {
            double a = -2 * Math.PI * i / size;
            _cos[i] = (float)Math.Cos(a);
            _sin[i] = (float)Math.Sin(a);
        }
    }

    /// <summary>Forward transform of (re, im), in place.</summary>
    public void Forward(Span<float> re, Span<float> im)
    {
        int n = Size;
        for (int i = 0; i < n; i++)
        {
            int j = _rev[i];
            if (j > i)
            {
                (re[i], re[j]) = (re[j], re[i]);
                (im[i], im[j]) = (im[j], im[i]);
            }
        }

        for (int len = 2; len <= n; len <<= 1)
        {
            int half = len >> 1;
            int step = n / len;
            for (int start = 0; start < n; start += len)
            {
                for (int k = 0; k < half; k++)
                {
                    float wr = _cos[k * step], wi = _sin[k * step];
                    int a = start + k, b = a + half;
                    float tr = re[b] * wr - im[b] * wi;
                    float ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
        }
    }
}
