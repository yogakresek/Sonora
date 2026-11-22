namespace Sonora;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // One copy at a time; a second launch just asks the first to show its dashboard.
        using var mutex = new Mutex(initiallyOwned: true, $@"Local\{AppInfo.Name}.SingleInstance", out var isFirst);
        if (!isFirst)
        {
            SingleInstance.SignalShow();
            return;
        }

        AppInfo.EnsureDirs();
        Log.Prune();
        Log.Info($"{AppInfo.Name} {AppInfo.Version} starting");

        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Log.Error("UI thread exception", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Error("Unhandled exception", e.ExceptionObject as Exception);

        ApplicationConfiguration.Initialize();
        using var app = new TrayApp();
        Application.Run(app);

        Log.Info("Exited cleanly");
    }
}
