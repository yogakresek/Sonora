// Messages between the web UI and the .NET host (WebView2 postMessage).

export type HostMessage =
  | { type: 'hello'; app: string; version: string; dataDir: string; runtime: string; webview: string };

export type WebMessage = { type: 'hello' } | { type: 'open-data-dir' };

interface WebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
}

const webview: WebViewBridge | undefined = (window as unknown as { chrome?: { webview?: WebViewBridge } })
  .chrome?.webview;

/** True when running inside the app (false in a normal browser during development). */
export const inHost = webview !== undefined;

export function send(message: WebMessage): void {
  webview?.postMessage(message);
}

export function onMessage(handler: (message: HostMessage) => void): void {
  webview?.addEventListener('message', (e) => handler(e.data as HostMessage));
}
