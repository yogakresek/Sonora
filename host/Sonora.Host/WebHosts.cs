using Microsoft.Web.WebView2.Core;
using Sonora.Media;

namespace Sonora;

/// <summary>Where pages are loaded from: the built frontend, or the Vite dev server in development.</summary>
internal static class WebHosts
{
    /// <summary>Maps the app and media virtual hosts into a web view.</summary>
    public static void Map(CoreWebView2 core)
    {
        core.SetVirtualHostNameToFolderMapping(MediaService.CoverHost, AppInfo.CacheDir, CoreWebView2HostResourceAccessKind.Allow);
        if (AppInfo.DevUrl is null)
            core.SetVirtualHostNameToFolderMapping(AppInfo.WebHost, AppInfo.WebDir, CoreWebView2HostResourceAccessKind.DenyCors);
    }

    public static bool HasBuiltFrontend => AppInfo.DevUrl is not null || File.Exists(Path.Combine(AppInfo.WebDir, "index.html"));

    public static string PageUrl(string page, string? query = null)
    {
        string root = AppInfo.DevUrl?.TrimEnd('/') ?? $"https://{AppInfo.WebHost}";
        return query is null ? $"{root}/{page}" : $"{root}/{page}?{query}";
    }
}
