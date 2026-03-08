import { saveBrowserUrl } from "../components/BrowserPanel";

/**
 * Strip ANSI escape sequences so regex can match URLs inside colored terminal
 * output (e.g. Vite wraps `http://localhost:5173/` in color codes).
 */
const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g");

function stripAnsi(data: string): string {
  return data.replace(ANSI_RE, "");
}

/**
 * Detects localhost dev-server URLs in terminal output.
 *
 * Matches patterns like:
 *   - http://localhost:3000
 *   - http://127.0.0.1:5173/
 *   - https://localhost:8080/path
 */
const DEV_SERVER_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/;

export function detectDevServerUrl(data: string): string | null {
  const clean = stripAnsi(data);
  const match = clean.match(DEV_SERVER_URL_RE);
  if (!match) return null;
  // Normalize: strip trailing slash for consistent storage
  let url = match[0];
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }
  return url;
}

/**
 * Saves a detected dev-server URL for a project and notifies the BrowserPanel
 * in the same tab via a custom DOM event.
 */
export function setDetectedBrowserUrl(projectId: string | undefined, url: string): void {
  saveBrowserUrl(projectId, url);
  const event = () =>
    window.dispatchEvent(
      new CustomEvent("t3code:browser-url-updated", { detail: { projectId } }),
    );
  // Dispatch immediately for already-mounted listeners
  event();
  // Re-dispatch after a delay for lazy-loaded components that may not have mounted yet
  setTimeout(event, 300);
}
