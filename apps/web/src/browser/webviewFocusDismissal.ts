/**
 * Calls `dismiss` when focus moves into the webview. Chromium refocuses an already focused
 * webview right after the host window's own `focus` event when the host is reactivated, such
 * as by a click on host UI after typing in the page; that is not a press into the page.
 */
export function subscribeWebviewFocusDismissal(
  host: EventTarget,
  webview: EventTarget,
  dismiss: () => void,
): () => void {
  let hostRefocusing = false;
  let reset: ReturnType<typeof setTimeout> | undefined;
  const onHostFocus = (event: Event) => {
    if (event.target !== host) return;
    hostRefocusing = true;
    clearTimeout(reset);
    reset = setTimeout(() => {
      hostRefocusing = false;
    });
  };
  const onWebviewFocus = () => {
    if (!hostRefocusing) dismiss();
    hostRefocusing = false;
  };
  host.addEventListener("focus", onHostFocus);
  webview.addEventListener("focus", onWebviewFocus);
  return () => {
    clearTimeout(reset);
    host.removeEventListener("focus", onHostFocus);
    webview.removeEventListener("focus", onWebviewFocus);
  };
}
