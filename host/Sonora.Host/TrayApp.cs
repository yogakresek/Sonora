namespace Sonora;

/// <summary>The app's lifetime: lives in the tray, owns the dashboard window.
/// Closing the dashboard only hides it; "Keluar" in the tray ends the process.</summary>
public sealed class TrayApp : ApplicationContext
{
    private readonly NotifyIcon _tray;
    private readonly Icon _icon;
    private readonly IDisposable _showListener;
    private DashboardForm? _dashboard;

    public TrayApp()
    {
        _icon = AppIcon.Create(32);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Buka dashboard", null, (_, _) => ShowDashboard());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Keluar", null, (_, _) => Quit());

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

        _showListener = SingleInstance.Listen(SynchronizationContext.Current!, ShowDashboard);

        // First run of M0: open the dashboard so there is something to see.
        ShowDashboard();
    }

    private void ShowDashboard()
    {
        if (_dashboard is null || _dashboard.IsDisposed)
            _dashboard = new DashboardForm(_icon);

        if (!_dashboard.Visible) _dashboard.Show();
        if (_dashboard.WindowState == FormWindowState.Minimized) _dashboard.WindowState = FormWindowState.Normal;
        _dashboard.Activate();
    }

    private void Quit()
    {
        _tray.Visible = false;
        _dashboard?.AllowClose();
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
            _icon.Dispose();
        }
        base.Dispose(disposing);
    }
}
