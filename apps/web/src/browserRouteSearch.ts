const BROWSER_OPEN_STORAGE_KEY = "t3code:browser-open";

export interface BrowserRouteSearch {
  browser?: "1";
}

function isBrowserOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

export function saveBrowserOpenState(open: boolean): void {
  try {
    if (open) {
      localStorage.setItem(BROWSER_OPEN_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(BROWSER_OPEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures (private mode, quota exceeded, etc.)
  }
}

function readBrowserOpenState(): boolean {
  try {
    return localStorage.getItem(BROWSER_OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function stripBrowserSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "browser"> {
  const { browser: _browser, ...rest } = params;
  return rest as Omit<T, "browser">;
}

export function parseBrowserRouteSearch(search: Record<string, unknown>): BrowserRouteSearch {
  const browser = isBrowserOpenValue(search["browser"]) ? ("1" as const) : undefined;
  if (browser) {
    return { browser };
  }
  // Auto-restore from localStorage so the browser panel stays open across thread switches
  if (readBrowserOpenState()) {
    return { browser: "1" };
  }
  return {};
}
