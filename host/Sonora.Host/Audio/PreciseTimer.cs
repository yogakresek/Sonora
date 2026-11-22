using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Sonora.Audio;

/// <summary>
/// Sleeps until a Stopwatch timestamp with ~1 ms accuracy, using a high-resolution waitable
/// timer (Windows 10 1803+). Unlike timeBeginPeriod this does not raise the clock rate for
/// the whole system. Falls back to Thread.Sleep if the timer can't be created.
/// </summary>
internal sealed class PreciseTimer : IDisposable
{
    private const uint CreateWaitableTimerHighResolution = 0x00000002;
    private const uint TimerAllAccess = 0x1F0003;
    private const uint Infinite = 0xFFFFFFFF;

    private readonly IntPtr _handle;

    public PreciseTimer()
    {
        _handle = CreateWaitableTimerExW(IntPtr.Zero, null, CreateWaitableTimerHighResolution, TimerAllAccess);
    }

    public void WaitUntil(long stopwatchTimestamp)
    {
        long remaining = stopwatchTimestamp - Stopwatch.GetTimestamp();
        if (remaining <= 0) return;

        // Stopwatch ticks -> 100 ns units, negative = relative.
        long due = -(long)(remaining * (10_000_000.0 / Stopwatch.Frequency));
        if (_handle != IntPtr.Zero && SetWaitableTimer(_handle, ref due, 0, IntPtr.Zero, IntPtr.Zero, false))
        {
            WaitForSingleObject(_handle, Infinite);
        }
        else
        {
            Thread.Sleep(TimeSpan.FromTicks(-due));
        }
    }

    public void Dispose()
    {
        if (_handle != IntPtr.Zero) CloseHandle(_handle);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWaitableTimerExW(IntPtr attributes, string? name, uint flags, uint access);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetWaitableTimer(IntPtr timer, ref long dueTime, int period, IntPtr completion, IntPtr arg, bool resume);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
