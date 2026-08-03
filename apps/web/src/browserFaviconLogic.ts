import { FAVICON_DATA_URL_MAX_LENGTH } from "@t3tools/contracts";

import { isLocalLoopbackHost, normalizeHostname } from "./browser/browserTargetResolver";

export type BrowserFaviconEntry = { dataUrl: string; updatedAt: number };

export const BROWSER_FAVICON_MAX_DATA_URL_LENGTH = FAVICON_DATA_URL_MAX_LENGTH;
export const BROWSER_FAVICON_MAX_ENTRIES = 40;

export function faviconKey(
  projectRefKey: string,
  url: string,
  environmentHostname: string | null,
): string | null {
  if (projectRefKey.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = normalizeHostname(parsed.hostname);
    const collapsesToLocal =
      isLocalLoopbackHost(host) ||
      host === "0.0.0.0" ||
      (environmentHostname !== null && host === normalizeHostname(environmentHostname));
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const canonicalHost = collapsesToLocal ? "local" : host;
    return `${projectRefKey} ${parsed.protocol}//${canonicalHost}:${port}`;
  } catch {
    return null;
  }
}

export function isStorableFaviconDataUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^data:image\/[a-z0-9.+-]+;base64,/i.test(value) ||
    value.length > BROWSER_FAVICON_MAX_DATA_URL_LENGTH
  ) {
    return false;
  }
  const commaIndex = value.indexOf(",");
  if (commaIndex === -1) return false;
  const payload = value.slice(commaIndex + 1);
  return (
    payload.length > 0 &&
    payload.length % 4 !== 1 &&
    !/[^a-z0-9+/=]/i.test(payload) &&
    /^[a-z0-9+/]*={0,2}$/i.test(payload)
  );
}

export function evictExcessFavicons(
  byKey: Record<string, BrowserFaviconEntry>,
): Record<string, BrowserFaviconEntry> {
  const keys = Object.keys(byKey);
  if (keys.length <= BROWSER_FAVICON_MAX_ENTRIES) return byKey;
  const kept = keys
    .toSorted((a, b) => (byKey[b]?.updatedAt ?? 0) - (byKey[a]?.updatedAt ?? 0))
    .slice(0, BROWSER_FAVICON_MAX_ENTRIES);
  return Object.fromEntries(kept.map((key) => [key, byKey[key] as BrowserFaviconEntry]));
}

export function migratePersistedBrowserFaviconState(persistedState: unknown): {
  byKey: Record<string, BrowserFaviconEntry>;
} {
  if (!persistedState || typeof persistedState !== "object") return { byKey: {} };
  const raw = "byKey" in persistedState ? (persistedState as { byKey?: unknown }).byKey : null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { byKey: {} };
  const byKey: Record<string, BrowserFaviconEntry> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { dataUrl, updatedAt } = value as Record<string, unknown>;
    if (!isStorableFaviconDataUrl(dataUrl)) continue;
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) continue;
    byKey[key] = { dataUrl, updatedAt };
  }
  return { byKey: evictExcessFavicons(byKey) };
}
