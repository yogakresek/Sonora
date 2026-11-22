using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Sonora.Audio;

namespace Sonora.Bridge;

/// <summary>
/// Publishes audio frames to every web view through one block of shared memory, so 60 frames a
/// second cost a memcpy instead of 60 JSON messages per view. See <see cref="FrameLayout"/> for
/// the seqlock that keeps readers from seeing half-written frames.
/// </summary>
public sealed unsafe class AudioBridge : IDisposable
{
    private readonly AudioEngine _engine;
    private readonly CoreWebView2SharedBuffer _buffer;
    private readonly byte* _ptr;
    private readonly object _gate = new();
    private bool _disposed;

    private static readonly string Meta = JsonSerializer.Serialize(new
    {
        layout = FrameLayout.Version,
        headerBytes = FrameLayout.HeaderBytes,
        bands = FrameLayout.Bands,
        waveLength = FrameLayout.WaveLength,
        floatCount = FrameLayout.FloatCount,
    });

    public AudioBridge(CoreWebView2Environment env, AudioEngine engine)
    {
        _engine = engine;
        _buffer = env.CreateSharedBuffer((ulong)FrameLayout.TotalBytes);
        _ptr = (byte*)_buffer.Buffer;
        new Span<byte>(_ptr, FrameLayout.TotalBytes).Clear();

        int* header = (int*)_ptr;
        header[1] = FrameLayout.Version;
        header[2] = FrameLayout.Bands;
        header[3] = FrameLayout.WaveLength;

        _engine.FrameReady += Write;
    }

    /// <summary>Hands the buffer to a page. Call again after each navigation (the page asks on load).</summary>
    public void Attach(CoreWebView2 core) =>
        core.PostSharedBufferToScript(_buffer, CoreWebView2SharedBufferAccess.ReadOnly, Meta);

    private void Write(float[] frame)
    {
        lock (_gate)
        {
            if (_disposed) return;
            int* seq = (int*)_ptr;
            int s = *seq;
            Interlocked.Exchange(ref *seq, s + 1); // odd: writing (full fence before the data)
            fixed (float* src = frame)
            {
                long bytes = (long)FrameLayout.FloatCount * sizeof(float);
                Buffer.MemoryCopy(src, _ptr + FrameLayout.HeaderBytes, bytes, bytes);
            }
            Volatile.Write(ref *seq, s + 2); // even: done
        }
    }

    public void Dispose()
    {
        _engine.FrameReady -= Write;
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            _buffer.Dispose();
        }
    }
}
