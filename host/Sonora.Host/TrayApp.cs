namespace Sonora;

/// <summary>The app's lifetime: lives in the tray, owns the services, the widgets and the dashboard.
/// Closing the dashboard only closes that window; "Keluar" in the tray ends the process.</summary>
public sealed class TrayApp : ApplicationContext
{
    private readonly NotifyIcon _tray;
    private readonly Icon _icon;
    private readonly IDisposable _showListener;
    private readonly Services _services;
    private readonly ToolStripMenuItem _hideItem;
    private DashboardForm? _dashboard;

    public TrayApp()
    {
        // Make sure WinForms' context is installed before anything captures it.
        if (SynchronizationContext.Current is not WindowsFormsSynchronizationContext)
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
        var ui = SynchronizationContext.Current!;

        _icon = AppIcon.Create(32);
        _services = new Services(ui);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Buka dashboard", null, (_, _) => ShowDashboard());
        _hideItem = new ToolStripMenuItem("Sembunyikan widget", null, (_, _) => _services.Widgets.SetHidden(!_services.Widgets.Hidden));
        menu.Items.Add(_hideItem);
        // Suasana ▸ Mati / Star Mode / Piringan Hitam (one at a time).
        var ambienceMenu = new ToolStripMenuItem("Suasana");
        var offItem = new ToolStripMenuItem("Mati", null, (_, _) => _services.Widgets.SetAmbience(null));
        ambienceMenu.DropDownItems.Add(offItem);
        ambienceMenu.DropDownItems.Add(new ToolStripSeparator());
        foreach (var a in Widgets.WidgetManager.Ambiences)
        {
            string id = a.Id;
            ambienceMenu.DropDownItems.Add(new ToolStripMenuItem(a.Name, null, (_, _) => _services.Widgets.SetAmbience(id)) { Tag = id });
        }
        menu.Items.Add(ambienceMenu);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Keluar", null, (_, _) => Quit());
        menu.Opening += (_, _) =>
        {
            _hideItem.Text = _services.Widgets.Hidden ? "Tampilkan widget" : "Sembunyikan widget";
            string? on = _services.Widgets.Ambience;
            offItem.Checked = on is null;
            foreach (ToolStripItem item in ambienceMenu.DropDownItems)
                if (item is ToolStripMenuItem m && m.Tag is string id) m.Checked = id == on;
        };

        _tray = new NotifyIcon
        {
            Icon = _icon,
            Text = $"{AppInfo.Name} {AppInfo.Version}",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _tray.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) ShowDashboard();
        };

        _showListener = SingleInstance.Listen(ui, ShowDashboard);
        _services.Widgets.DashboardRequested += ShowDashboard;
        _services.Widgets.Apply();

        // First run: open the dashboard so there is something to read.
        if (!_services.Settings.Current.FirstRunDone)
        {
            _services.Settings.Current.FirstRunDone = true;
            _services.Settings.Changed();
            ShowDashboard();
        }
    }

    private void ShowDashboard()
    {
        if (_dashboard is null || _dashboard.IsDisposed)
            _dashboard = new DashboardForm(_icon, _services);

        if (!_dashboard.Visible) _dashboard.Show();
        if (_dashboard.WindowState == FormWindowState.Minimized) _dashboard.WindowState = FormWindowState.Normal;
        _dashboard.Activate();
    }

    private void Quit()
    {
        _tray.Visible = false;
        _dashboard?.Close();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _showListener.Dispose();
            _tray.Dispose();
            _dashboard?.Dispose();
            _services.Dispose();
            _icon.Dispose();
        }
        base.Dispose(disposing);
    }
}
