import { runBrowserViewportMutation } from "./browserViewportActions";

/** Serialize captures with viewport commits for the same preview tab. */
export function captureBrowserScreenshot<T>(tabId: string, capture: () => Promise<T>): Promise<T> {
  return runBrowserViewportMutation(tabId, capture);
}
