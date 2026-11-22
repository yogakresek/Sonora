namespace Sonora;

/// <summary>Lets a second launch tell the running copy to open its dashboard, via a named event.</summary>
public static class SingleInstance
{
    private static readonly string EventName = $@"Local\{AppInfo.Name}.Show";

    public static void SignalShow()
    {
        try
        {
            using var ev = EventWaitHandle.OpenExisting(EventName);
            ev.Set();
        }
        catch (WaitHandleCannotBeOpenedException) { }
    }

    /// <summary>Calls <paramref name="onShow"/> on the UI thread whenever another launch signals.</summary>
    public static IDisposable Listen(SynchronizationContext ui, Action onShow)
    {
        var ev = new EventWaitHandle(false, EventResetMode.AutoReset, EventName);
        var reg = ThreadPool.RegisterWaitForSingleObject(ev,
            (_, _) => ui.Post(_ => onShow(), null), null, Timeout.Infinite, executeOnlyOnce: false);
        return new Registration(ev, reg);
    }

    private sealed class Registration(EventWaitHandle ev, RegisteredWaitHandle reg) : IDisposable
    {
        public void Dispose()
        {
            reg.Unregister(null);
            ev.Dispose();
        }
    }
}
