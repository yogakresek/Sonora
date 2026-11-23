namespace Sonora.Desktop;

/// <summary>
/// Puts widget windows on the desktop itself: as children of the window that holds the desktop
/// icons (Progman on Windows 11 24H2+, a WorkerW on older builds), stacked just above the icons.
/// That keeps them behind every app, out of Alt-Tab and the taskbar, there after Win+D, and
/// visible. (Mouse input comes from <see cref="DesktopInput"/>, not the window itself.)
///
/// If Explorer restarts, the icon window — and every child in it — is destroyed; listen for
/// <see cref="TaskbarCreatedMessage"/> and attach again.
/// </summary>
internal static class DesktopLayer
{
    public static readonly uint TaskbarCreatedMessage = Native.RegisterWindowMessageW("TaskbarCreated");

    /// <summary>The window that owns SHELLDLL_DefView (the icons), or zero if there is none.</summary>
    public static IntPtr FindIconHost()
    {
        var progman = Native.FindWindowW("Progman", null);
        if (progman != IntPtr.Zero && Native.FindWindowExW(progman, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
            return progman;

        // Older layout: the icons live in a top-level WorkerW.
        IntPtr found = IntPtr.Zero;
        Native.EnumWindows((hwnd, _) =>
        {
            if (Native.FindWindowExW(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
            {
                found = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /// <summary>
    /// Makes sure the desktop has its wallpaper layer (a WorkerW). Widgets are see-through only over
    /// that layer: without it they show a black box. Explorer creates it only when asked (by the
    /// undocumented message 0x052C, the one live-wallpaper apps use) or by itself on, e.g., a
    /// wallpaper change. Before a reboot something had usually asked; right after one, nothing has,
    /// so every widget came up black. Cheap and harmless to call again: if the layer exists, nothing
    /// happens. Returns true if it had to be created.
    /// </summary>
    public static bool EnsureWallpaperLayer()
    {
        var progman = Native.FindWindowW("Progman", null);
        if (progman == IntPtr.Zero) return false;
        // 24H2+: the layer is a WorkerW inside Progman. Older builds: a top-level WorkerW next to it.
        bool newLayout = Native.FindWindowExW(progman, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero;
        if (newLayout && Native.FindWindowExW(progman, IntPtr.Zero, "WorkerW", null) != IntPtr.Zero) return false;
        if (!newLayout) return false; // the older layout keeps its own WorkerW host; nothing to fix there
        Native.SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, Native.SMTO_NORMAL, 1000, out _);
        bool created = Native.FindWindowExW(progman, IntPtr.Zero, "WorkerW", null) != IntPtr.Zero;
        Log.Info(created ? "Desktop wallpaper layer was missing; asked Explorer to create it"
                         : "Desktop wallpaper layer missing and Explorer did not create it");
        return created;
    }

    /// <summary>Makes <paramref name="hwnd"/> a child of the icon host. Returns the host, or zero (left as a normal window).</summary>
    public static IntPtr Attach(IntPtr hwnd)
    {
        EnsureWallpaperLayer();
        var host = FindIconHost();
        if (host == IntPtr.Zero) return IntPtr.Zero;

        // Stays a popup (not WS_CHILD): WinForms moves parentless WS_CHILD forms into its hidden
        // parking window. A popup with a parent behaves the same on screen.
        long style = Native.GetStyle(hwnd, Native.GWL_STYLE);
        Native.SetStyle(hwnd, Native.GWL_STYLE, style | Native.WS_CLIPSIBLINGS | Native.WS_CLIPCHILDREN);

        if (Native.SetParent(hwnd, host) == IntPtr.Zero && Native.GetParent(hwnd) != host)
        {
            Log.Error($"SetParent to desktop failed (error {System.Runtime.InteropServices.Marshal.GetLastWin32Error()})");
            return IntPtr.Zero;
        }
        return host;
    }

    /// <summary>Places a child window at a screen rectangle, above the icons.</summary>
    public static void Place(IntPtr hwnd, IntPtr host, Rectangle screen, bool show)
    {
        int x = screen.X, y = screen.Y;
        if (host != IntPtr.Zero)
        {
            var p = new Native.POINT(screen.X, screen.Y);
            Native.ScreenToClient(host, ref p);
            x = p.X;
            y = p.Y;
        }
        uint flags = Native.SWP_NOACTIVATE | (show ? Native.SWP_SHOWWINDOW : 0);
        Native.SetWindowPos(hwnd, host != IntPtr.Zero ? Native.HWND_TOP : Native.HWND_BOTTOM,
            x, y, screen.Width, screen.Height, flags);
    }
}
