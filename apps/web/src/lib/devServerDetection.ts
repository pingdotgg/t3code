import { saveBrowserUrl } from "../components/BrowserPanel";

/**
 * Detects localhost dev-server URLs in terminal output.
 *
 * Matches patterns like:
 *   - http://localhost:3000
 *   - http://127.0.0.1:5173
 *   - https://localhost:8080/
 */
const DEV_SERVER_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/;

export function detectDevServerUrl(data: string): string | null {
  const match = data.match(DEV_SERVER_URL_RE);
  return match ? match[0] : null;
}

/**
 * Saves a detected dev-server URL for a project and notifies the BrowserPanel
 * in the same tab via a custom DOM event.
 */
export function setDetectedBrowserUrl(projectId: string | undefined, url: string): void {
  saveBrowserUrl(projectId, url);
  window.dispatchEvent(
    new CustomEvent("t3code:browser-url-updated", { detail: { projectId } }),
  );
}
