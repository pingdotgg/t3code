import { randomUUID } from "./lib/utils";

export type BrowserTab = {
  id: string;
  url: string;
  title?: string | null;
  faviconUrl?: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  lastError?: string | null;
};

export type BrowserUrlParseResult = { ok: true; url: string } | { ok: false; error: string };

const EXPLICIT_SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;

export function createBrowserTab(url = "about:blank"): BrowserTab {
  return {
    id: `browser-tab-${randomUUID()}`,
    url,
    title: null,
    faviconUrl: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    lastError: null,
  };
}

export function normalizeBrowserDisplayUrl(url: string | null | undefined): string {
  if (!url || url === "about:blank") {
    return "";
  }
  return url;
}

export function getBrowserTabLabel(tab: Pick<BrowserTab, "title" | "url">): string {
  const title = tab.title?.trim();
  if (title) {
    return title;
  }
  if (tab.url === "about:blank") {
    return "New tab";
  }

  try {
    const parsed = new URL(tab.url);
    return parsed.host || parsed.href;
  } catch {
    return tab.url;
  }
}

export function parseSubmittedBrowserUrl(rawValue: string): BrowserUrlParseResult {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return { ok: true, url: "about:blank" };
  }

  if (trimmed === "about:blank") {
    return { ok: true, url: trimmed };
  }

  const candidate = EXPLICIT_SCHEME_PATTERN.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    return { ok: true, url: new URL(candidate).toString() };
  } catch {
    return { ok: false, error: "Enter a valid URL." };
  }
}
