using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Sonora.Desktop;

/// <summary>What a widget needs to take part in desktop input.</summary>
internal interface IDesktopTarget
{
    Rectangle ScreenBounds { get; }
    bool AcceptsInput { get; }
    void PointerEnter(Point screen);
    void PointerMove(Point screen);
    void PointerLeave();
    void PointerDown(Point screen, int clicks);
    void PointerUp(Point screen);
    /// <summary>True when a press at this point should go to the desktop instead (a layer that
    /// only wants hover, apart from a few buttons on it).</summary>
    bool PassThrough(Point screen);
}

/// <summary>
/// Mouse input for widgets that live inside the desktop window.
///
/// Such windows only get real mouse input when layered, and a layered window loses the
/// per-pixel transparency of the web content. So input is taken here instead, with a low-level
/// mouse hook: when the pointer is over a widget and that spot of the desktop is actually
/// visible (no app window on top), hover, press and release go to the widget, and presses are
/// swallowed so the desktop doesn't also start a selection rectangle. Movement is never
/// swallowed, so the cursor never sticks. Locked widgets are ignored, so clicks reach the desktop.
///
/// The hook is only installed while some widget accepts input. The callback does rectangle
/// checks only and defers everything else to the UI thread, so it returns in microseconds.
/// </summary>
internal sealed class DesktopInput : IDisposable
{
    private const int WH_MOUSE_LL = 14;
    private const int WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202,
        WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205, WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208;
    private const uint GA_ROOT = 2;

    private readonly SynchronizationContext _ui;
    private readonly Func<IReadOnlyCollection<IDesktopTarget>> _targets;
    private readonly HookProc _proc;
    private IntPtr _hook;

    private IDesktopTarget? _hover;
    private IDesktopTarget? _capture;
    private long _lastMoveTicks;
    private long _lastDownTicks;
    private Point _lastDownPoint;
    private int _clicks;
    private readonly Dictionary<IntPtr, bool> _desktopRoots = [];

    public DesktopInput(SynchronizationContext ui, Func<IReadOnlyCollection<IDesktopTarget>> targets)
    {
        _ui = ui;
        _targets = targets;
        _proc = HookCallback; // keep the delegate alive for as long as the hook is installed
    }

    public bool Installed => _hook != IntPtr.Zero;

    /// <summary>Installs or removes the hook depending on whether any widget wants input.</summary>
    public void Update()
    {
        bool want = _targets().Any(t => t.AcceptsInput);
        if (want && _hook == IntPtr.Zero)
        {
            _hook = SetWindowsHookExW(WH_MOUSE_LL, _proc, GetModuleHandleW(null), 0);
            if (_hook == IntPtr.Zero) Log.Error($"Mouse hook failed (error {Marshal.GetLastWin32Error()})");
            else Log.Info("Desktop mouse hook installed");
        }
        else if (!want && _hook != IntPtr.Zero)
        {
            Uninstall();
        }
    }

    private void Uninstall()
    {
        if (_hook == IntPtr.Zero) return;
        UnhookWindowsHookEx(_hook);
        _hook = IntPtr.Zero;
        if (_hover is { } h) { _hover = null; _ui.Post(_ => h.PointerLeave(), null); }
        _capture = null;
        Log.Info("Desktop mouse hook removed");
    }

    private IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0) return CallNextHookEx(_hook, code, wParam, lParam);

        int msg = (int)wParam;
        var data = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
        var pt = new Point(data.X, data.Y);

        try
        {
            // A press that started on a widget belongs to it until release, wherever the pointer goes.
            if (_capture is { } captured)
            {
                if (msg == WM_MOUSEMOVE)
                {
                    if (Throttle()) _ui.Post(_ => captured.PointerMove(pt), null);
                    return CallNextHookEx(_hook, code, wParam, lParam);
                }
                if (msg == WM_LBUTTONUP)
                {
                    _capture = null;
                    _ui.Post(_ => captured.PointerUp(pt), null);
                    return 1;
                }
                return CallNextHookEx(_hook, code, wParam, lParam);
            }

            var target = FindTarget(pt);
            if (target != _hover)
            {
                var old = _hover;
                _hover = target;
                if (old is not null) _ui.Post(_ => old.PointerLeave(), null);
                if (target is not null) _ui.Post(_ => target.PointerEnter(pt), null);
            }
            if (target is null) return CallNextHookEx(_hook, code, wParam, lParam);

            if (msg == WM_MOUSEMOVE)
            {
                if (Throttle()) _ui.Post(_ => target.PointerMove(pt), null);
                return CallNextHookEx(_hook, code, wParam, lParam); // never swallow movement
            }
            // Hover-only layers (Star Mode) let presses through, except on their own buttons.
            if (target.PassThrough(pt)) return CallNextHookEx(_hook, code, wParam, lParam);

            switch (msg)
            {
                case WM_LBUTTONDOWN:
                    _capture = target;
                    int clicks = CountClicks(pt);
                    _ui.Post(_ => target.PointerDown(pt, clicks), null);
                    return 1;
                case WM_LBUTTONUP:
                case WM_RBUTTONDOWN:
                case WM_RBUTTONUP:
                case WM_MBUTTONDOWN:
                case WM_MBUTTONUP:
                    return 1; // keep the desktop's own menus and selection out of the widget
            }
        }
        catch (Exception ex)
        {
            Log.Error("Mouse hook", ex);
        }
        return CallNextHookEx(_hook, code, wParam, lParam);
    }

    private IDesktopTarget? FindTarget(Point pt)
    {
        IDesktopTarget? found = null;
        foreach (var t in _targets())
        {
            if (t.AcceptsInput && t.ScreenBounds.Contains(pt)) { found = t; break; }
        }
        if (found is null) return null;
        return IsDesktopVisibleAt(pt) ? found : null;
    }

    /// <summary>True when the top-most window at the point is the desktop (or something inside it, like a widget).</summary>
    private bool IsDesktopVisibleAt(Point pt)
    {
        var hwnd = WindowFromPoint(new POINT { X = pt.X, Y = pt.Y });
        if (hwnd == IntPtr.Zero) return false;
        var root = GetAncestor(hwnd, GA_ROOT);
        if (!_desktopRoots.TryGetValue(root, out bool isDesktop))
        {
            var sb = new StringBuilder(64);
            GetClassNameW(root, sb, sb.Capacity);
            string cls = sb.ToString();
            isDesktop = cls is "Progman" or "WorkerW";
            if (_desktopRoots.Count > 256) _desktopRoots.Clear();
            _desktopRoots[root] = isDesktop;
        }
        return isDesktop;
    }

    /// <summary>~120 move updates a second at most; gaming mice report up to 8000.</summary>
    private bool Throttle()
    {
        long now = Stopwatch.GetTimestamp();
        if (now - _lastMoveTicks < Stopwatch.Frequency / 120) return false;
        _lastMoveTicks = now;
        return true;
    }

    private int CountClicks(Point pt)
    {
        long now = Stopwatch.GetTimestamp();
        double ms = (now - _lastDownTicks) * 1000.0 / Stopwatch.Frequency;
        bool near = Math.Abs(pt.X - _lastDownPoint.X) <= 6 && Math.Abs(pt.Y - _lastDownPoint.Y) <= 6;
        _clicks = ms <= GetDoubleClickTime() && near ? _clicks + 1 : 1;
        _lastDownTicks = now;
        _lastDownPoint = pt;
        return _clicks;
    }

    public void Dispose() => Uninstall();

    // ---------------------------------------------------------------- interop

    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public int X, Y;
        public uint MouseData, Flags, Time;
        public IntPtr ExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookExW(int idHook, HookProc proc, IntPtr hMod, uint threadId);

    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandleW(string? name);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT p);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int max);

    [DllImport("user32.dll")]
    private static extern uint GetDoubleClickTime();
}
