/**
 * Mirrors Codex's generic Browser Use fallback: ask the page origin for its
 * conventional favicon and let the image element fall back to a browser glyph.
 * Chrome-backed tools can pass their tab's explicit favicon URL separately.
 */
export function faviconUrlForPage(rawUrl: string | null | undefined, _size = 32): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return null;
    return new URL("/favicon.ico", pageUrl.origin).href;
  } catch {
    return null;
  }
}

const THEMED_FAVICON_BY_HOSTNAME: Readonly<
  Record<string, Readonly<{ light: string; dark: string }>>
> = {
  "github.com": {
    light: "https://github.githubassets.com/favicons/favicon.svg",
    dark: "https://github.githubassets.com/favicons/favicon-dark.svg",
  },
};

function themedFaviconUrlForPage(
  rawUrl: string | null | undefined,
  appearance: "light" | "dark",
): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return null;
    return THEMED_FAVICON_BY_HOSTNAME[pageUrl.hostname.toLowerCase()]?.[appearance] ?? null;
  } catch {
    return null;
  }
}

/** Accepts image URLs supplied by a trusted provider event. */
export function explicitFaviconUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Chooses a website icon for the app's resolved theme. Provider-supplied
 * variants mirror Codex's Chrome-selected favicon path. A small site-owned
 * fallback table covers websites whose conventional favicon is illegible in
 * one appearance without recoloring full-color icons.
 */
export function toolActivityFaviconUrl(
  icon: {
    readonly pageUrl: string;
    readonly faviconUrl?: string | undefined;
    readonly faviconUrlDark?: string | undefined;
  },
  appearance: "light" | "dark",
  size = 32,
): string | null {
  if (appearance === "dark") {
    return (
      explicitFaviconUrl(icon.faviconUrlDark) ??
      themedFaviconUrlForPage(icon.pageUrl, "dark") ??
      explicitFaviconUrl(icon.faviconUrl) ??
      faviconUrlForPage(icon.pageUrl, size)
    );
  }
  return (
    explicitFaviconUrl(icon.faviconUrl) ??
    themedFaviconUrlForPage(icon.pageUrl, "light") ??
    faviconUrlForPage(icon.pageUrl, size)
  );
}
