using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Sonora;

/// <summary>The settings window. Hosts the web dashboard in WebView2.</summary>
public sealed class DashboardForm : Form
{
    private readonly WebView2 _web;
    private bool _allowClose;

    public DashboardForm(Icon icon)
    {
        Text = AppInfo.Name;
        Icon = icon;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1100, 720);
        MinimumSize = new Size(760, 520);
        BackColor = Color.FromArgb(14, 14, 20);

        _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
        Controls.Add(_web);

        Load += async (_, _) => await InitWebAsync();
    }

    /// <summary>Lets the window really close (on quit) instead of hiding.</summary>
    public void AllowClose() => _allowClose = true;

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Closing the dashboard leaves the app running in the tray.
        if (!_allowClose && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnFormClosing(e);
    }

    private async Task InitWebAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: AppInfo.WebViewDir);
            await _web.EnsureCoreWebView2Async(env);
            var core = _web.CoreWebView2;

            core.Settings.AreDevToolsEnabled = AppInfo.DevUrl is not null || System.Diagnostics.Debugger.IsAttached;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = AppInfo.DevUrl is not null;

            core.WebMessageReceived += OnWebMessage;

            if (AppInfo.DevUrl is { } dev)
            {
                core.Navigate(dev);
            }
            else if (File.Exists(Path.Combine(AppInfo.WebDir, "index.html")))
            {
                core.SetVirtualHostNameToFolderMapping(AppInfo.WebHost, AppInfo.WebDir,
                    CoreWebView2HostResourceAccessKind.DenyCors);
                core.Navigate($"https://{AppInfo.WebHost}/index.html");
            }
            else
            {
                core.NavigateToString(
                    "<body style='background:#0e0e14;color:#ddd;font:14px Segoe UI;padding:24px'>" +
                    "Frontend belum dibuild. Jalankan <code>npm run build</code> di folder <code>web/</code>.</body>");
            }
        }
        catch (WebView2RuntimeNotFoundException ex)
        {
            Log.Error("WebView2 runtime not found", ex);
            MessageBox.Show(this, "Microsoft Edge WebView2 Runtime tidak ditemukan.", AppInfo.Name,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch (Exception ex)
        {
            Log.Error("WebView2 init failed", ex);
        }
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var type = doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null;

            switch (type)
            {
                case "hello":
                    Post(new
                    {
                        type = "hello",
                        app = AppInfo.Name,
                        version = AppInfo.Version,
                        dataDir = AppInfo.DataDir,
                        runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
                        webview = _web.CoreWebView2.Environment.BrowserVersionString,
                    });
                    break;
                case "open-data-dir":
                    System.Diagnostics.Process.Start("explorer.exe", AppInfo.DataDir);
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Error("Bad web message", ex);
        }
    }

    private void Post(object message) =>
        _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message));
}
