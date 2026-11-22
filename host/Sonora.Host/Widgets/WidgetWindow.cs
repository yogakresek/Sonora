using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Sonora.Desktop;

namespace Sonora.Widgets;

/// <summary>
/// One widget on the desktop: a borderless, per-pixel transparent window (no redirection bitmap,
/// so DWM composites the web page's alpha directly), living inside the desktop icon window.
///
/// Mouse input comes from <see cref="DesktopInput"/> (a desktop child can't take the mouse
/// without losing its transparency) and is forwarded to the page as "pointer" messages. On a
/// press the page answers whether it starts a drag, a resize or neither (a button); the host
/// then moves the window by following the real cursor, exact on any DPI and across monitors.
/// </summary>
public sealed class WidgetWindow : Form, IDesktopTarget
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly WidgetManager _manager;
    private readonly WebView2 _web;
    private IntPtr _host;
    private Rectangle _screen;
    private bool _locked;
    private bool _ready;

    // Press and gesture state.
    private bool _pressed;
    private Point _downCursor;
    private Rectangle _downBounds;
    private string? _gesture;
    private bool _keepAspect;

    // Star Mode's layer: always locked in place, but it hears the mouse so it can show its
    // controls, and takes clicks only on the areas the page reports (its buttons).
    private readonly bool _hoverOnly;
    private volatile Rectangle[] _hot = [];

    public string Id { get; }
    public Rectangle ScreenBounds => _screen;
    public bool AcceptsInput => (!_locked || _hoverOnly) && _ready && Visible;

    public bool PassThrough(Point screen) => _hoverOnly && !HitAreas.Hits(_hot, new Point(screen.X - _screen.X, screen.Y - _screen.Y));
    public CoreWebView2? Core => _web.CoreWebView2;

    public WidgetWindow(WidgetManager manager, string id, Rectangle screen, bool locked)
    {
        _manager = manager;
        Id = id;
        _screen = screen;
        _locked = locked;
        _hoverOnly = id == WidgetManager.Star.Id;

        FormBorderStyle = FormBorderStyle.None;
        // ShowInTaskbar stays true on purpose: false makes WinForms give the window a hidden owner,
        // which would replace the desktop as its parent. WS_EX_TOOLWINDOW keeps it off the taskbar.
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.Black;
        Text = $"{AppInfo.Name} — {id}";

        _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Transparent };
        Controls.Add(_web);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= (int)(Native.WS_EX_NOREDIRECTIONBITMAP | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE);
            cp.ExStyle &= ~(int)Native.WS_EX_APPWINDOW;
            return cp;
        }
    }

    protected override bool ShowWithoutActivation => true;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        DesktopLayer.Place(Handle, IntPtr.Zero, _screen, show: false);
    }

    /// <summary>Moves the (already shown) window into the desktop. WinForms resets a window's
    /// owner while showing it, which would undo a parent set any earlier.</summary>
    private void AttachToDesktop()
    {
        _host = DesktopLayer.Attach(Handle);
        if (_host == IntPtr.Zero) Log.Info($"Widget '{Id}': desktop icon window not found, using a normal window");
        else Log.Info($"Widget '{Id}' attached to desktop window {_host}");
        DesktopLayer.Place(Handle, _host, _screen, show: true);
    }

    public async Task StartAsync(CoreWebView2Environment env)
    {
        AttachToDesktop();
        await _web.EnsureCoreWebView2Async(env);
        var core = _web.CoreWebView2;
        bool dev = AppInfo.DevUrl is not null;
        core.Settings.AreDevToolsEnabled = dev;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = dev;
        core.WebMessageReceived += OnWebMessage;
        core.NavigationCompleted += (_, _) => WatchForHello();
        WebHosts.Map(core);
        core.Navigate(WebHosts.PageUrl("widget.html", $"id={Uri.EscapeDataString(Id)}"));
    }

    // A loaded page that never says hello can't hear the host either, and would sit on the
    // desktop empty. Reload it a few times; it normally answers within a fraction of a second.
    private System.Windows.Forms.Timer? _watchdog;
    private int _reloads;

    private void WatchForHello()
    {
        if (_ready || IsDisposed) return;
        _watchdog?.Dispose();
        _watchdog = new System.Windows.Forms.Timer { Interval = 5000 };
        _watchdog.Tick += (_, _) =>
        {
            _watchdog?.Stop();
            if (_ready || IsDisposed || _web.CoreWebView2 is not { } core) return;
            if (_reloads++ >= 3) { Log.Info($"Widget '{Id}' never said hello; giving up"); return; }
            Log.Info($"Widget '{Id}' silent after loading; reloading (try {_reloads})");
            core.Reload();
        };
        _watchdog.Start();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _watchdog?.Dispose();
        base.Dispose(disposing);
    }

    public void SetLocked(bool locked)
    {
        _locked = locked;
        if (locked) { CancelPress(); PostPointer("leave", Point.Empty); }
    }

    public void MoveTo(Rectangle screen)
    {
        _screen = screen;
        if (IsHandleCreated) DesktopLayer.Place(Handle, _host, screen, show: Visible);
    }

    public void Post(object message, JsonSerializerOptions json)
    {
        if (IsDisposed) return;
        _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message, json));
    }

    // ---------------------------------------------------------------- input from DesktopInput

    void IDesktopTarget.PointerEnter(Point screen) => PostPointer("enter", screen);

    void IDesktopTarget.PointerMove(Point screen)
    {
        if (_gesture is not null) UpdateGesture(screen);
        else PostPointer("move", screen);
    }

    void IDesktopTarget.PointerLeave() => PostPointer("leave", Point.Empty);

    void IDesktopTarget.PointerDown(Point screen, int clicks)
    {
        _pressed = true;
        _downCursor = screen;
        _downBounds = _screen;
        PostPointer("down", screen, clicks);
    }

    void IDesktopTarget.PointerUp(Point screen)
    {
        if (_gesture is not null) UpdateGesture(screen);
        EndGesture();
        _pressed = false;
        PostPointer("up", screen);
    }

    private void PostPointer(string kind, Point screen, int clicks = 0)
    {
        if (!_ready) return;
        Post(new { type = "pointer", kind, x = screen.X - _screen.X, y = screen.Y - _screen.Y, clicks }, Json);
    }

    private void CancelPress()
    {
        EndGesture();
        _pressed = false;
    }

    // ---------------------------------------------------------------- messages from the page

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var msg = JsonNode.Parse(e.WebMessageAsJson)?.AsObject();
            string? type = msg?["type"]?.GetValue<string>();
            switch (type)
            {
                case "hello":
                    _ready = true;
                    await _manager.OnWidgetReadyAsync(this);
                    break;
                case "drag-start":
                case "resize-start":
                    // The page's answer to a "down"; ignore it if the button is already up.
                    if (_locked || !_pressed) break;
                    _gesture = type == "drag-start" ? "drag" : "resize";
                    _keepAspect = msg?["keepAspect"]?.GetValue<bool>() ?? false;
                    Native.GetCursorPos(out var now);
                    UpdateGesture(new Point(now.X, now.Y));
                    break;
                case "open-dashboard":
                    CancelPress();
                    _manager.RequestDashboard();
                    break;
                case "media":
                    if (msg?["command"]?.GetValue<string>() is { } command) await _manager.MediaCommandAsync(command);
                    break;
                case "queue-play":
                    if (msg?["index"] is JsonValue idx) await _manager.QueuePlayAsync((int)idx);
                    break;
                case "queue-back":
                    if (msg?["index"] is JsonValue back) await _manager.QueueBackAsync((int)back);
                    break;
                case "hit-areas":
                    // [[x, y, w, h], ...] in physical pixels relative to the window.
                    _hot = HitAreas.Parse(msg?["rects"]);
                    break;
                case "star-mode":
                    // Turning it off closes this very window: do that after this handler returns.
                    if (_hoverOnly && msg?["on"] is JsonValue on && !(bool)on) BeginInvoke(() => _manager.SetStarMode(false));
                    break;
                case "seek":
                    if (msg?["ms"] is JsonValue ms) await _manager.SeekAsync((double)ms);
                    break;
                case "options":
                    if (msg?["options"] is JsonObject options) _manager.SaveOptions(Id, options);
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Error($"Widget '{Id}' message failed", ex);
        }
    }

    private void UpdateGesture(Point cursor)
    {
        if (_gesture is null) return;
        int dx = cursor.X - _downCursor.X, dy = cursor.Y - _downCursor.Y;
        var r = _downBounds;

        if (_gesture == "drag")
        {
            r.Offset(dx, dy);
        }
        else
        {
            double scale = Native.ScaleAt(r.X, r.Y);
            int min = (int)(120 * scale);
            int w = Math.Max(min, r.Width + dx), h = Math.Max(min, r.Height + dy);
            if (_keepAspect)
            {
                int side = Math.Max(w, h);
                w = h = side;
            }
            r.Size = new Size(w, h);
        }
        MoveTo(_manager.KeepOnScreen(r));
    }

    private void EndGesture()
    {
        if (_gesture is null) return;
        _gesture = null;
        _manager.SaveBounds(Id, _screen);
    }
}
