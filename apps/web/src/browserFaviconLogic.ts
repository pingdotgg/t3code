import { FAVICON_CAPTURED_AT_MAX, FAVICON_DATA_URL_MAX_LENGTH } from "@t3tools/contracts";

import { isLocalLoopbackHost, normalizeHostname } from "./browser/browserTargetResolver";

export type BrowserFaviconEntry = {
  dataUrl: string;
  capturedAt: number;
  aliases?: ReadonlyArray<string>;
};

export const BROWSER_FAVICON_MAX_ENTRIES = 40;
export const BROWSER_FAVICON_MAX_KEY_LENGTH = 4_096;
const BROWSER_FAVICON_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
export const BROWSER_FAVICON_MAX_ALIASES_PER_ENTRY = 4;
const BROWSER_FAVICON_MAX_ALIAS_LENGTH = 255;

function formatFaviconHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export function canCanonicalizeFaviconWithoutEnvironment(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = normalizeHostname(parsed.hostname);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (isLocalLoopbackHost(host) || host === "0.0.0.0")
    );
  } catch {
    return false;
  }
}

export function isValidFaviconCapturedAt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= FAVICON_CAPTURED_AT_MAX &&
    value <= Date.now() + BROWSER_FAVICON_MAX_FUTURE_SKEW_MS
  );
}

function migratePersistedFaviconKey(key: string): string | null {
  if (key.length === 0 || key.length > BROWSER_FAVICON_MAX_KEY_LENGTH) return null;
  const separator = key.indexOf(" ");
  if (separator <= 0) return null;
  const scope = key.slice(0, separator);
  const origin = key.slice(separator + 1);
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    )
      return null;
    if (normalizeHostname(parsed.hostname) !== "local") return key;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${scope} ${parsed.protocol}//localhost:${port}`;
  } catch {
    return null;
  }
}

function persistedFaviconAlias(value: unknown): string | null {
  if (typeof value !== "string" || value.length > BROWSER_FAVICON_MAX_ALIAS_LENGTH) return null;
  const normalized = normalizeHostname(value);
  if (!normalized || normalized !== value) return null;
  try {
    const parsed = new URL(`http://${formatFaviconHost(normalized)}`);
    return normalizeHostname(parsed.hostname) === normalized ? normalized : null;
  } catch {
    return null;
  }
}

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
    const canonicalHost =
      isLocalLoopbackHost(host) ||
      host === "0.0.0.0" ||
      (environmentHostname !== null && host === normalizeHostname(environmentHostname))
        ? "localhost"
        : host;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${projectRefKey} ${parsed.protocol}//${formatFaviconHost(canonicalHost)}:${port}`;
  } catch {
    return null;
  }
}

export function faviconStorageLocation(
  projectRefKey: string,
  url: string,
  environmentHostname: string | null,
): { readonly aliases: ReadonlyArray<string>; readonly key: string } | null {
  const canonicalKey = faviconKey(projectRefKey, url, environmentHostname);
  if (!canonicalKey) return null;
  if (environmentHostname === null) return { aliases: [], key: canonicalKey };
  try {
    const parsed = new URL(url);
    const host = normalizeHostname(parsed.hostname);
    const normalizedEnvironmentHostname = normalizeHostname(environmentHostname);
    if (
      normalizedEnvironmentHostname.length === 0 ||
      (!isLocalLoopbackHost(host) && host !== "0.0.0.0" && host !== normalizedEnvironmentHostname)
    ) {
      return { aliases: [], key: canonicalKey };
    }
    return {
      aliases:
        isLocalLoopbackHost(normalizedEnvironmentHostname) ||
        normalizedEnvironmentHostname === "0.0.0.0"
          ? []
          : [normalizedEnvironmentHostname],
      key: canonicalKey,
    };
  } catch {
    return { aliases: [], key: canonicalKey };
  }
}

export function isStorableFaviconDataUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("data:image/png;base64,") ||
    value.length > FAVICON_DATA_URL_MAX_LENGTH
  ) {
    return false;
  }
  const payload = value.slice("data:image/png;base64,".length);
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
  return Object.fromEntries(
    keys
      .toSorted((left, right) => (byKey[right]?.capturedAt ?? 0) - (byKey[left]?.capturedAt ?? 0))
      .slice(0, BROWSER_FAVICON_MAX_ENTRIES)
      .map((key) => [key, byKey[key] as BrowserFaviconEntry]),
  );
}

export function migratePersistedBrowserFaviconState(persistedState: unknown): {
  byKey: Record<string, BrowserFaviconEntry>;
} {
  if (!persistedState || typeof persistedState !== "object") return { byKey: {} };
  const raw = "byKey" in persistedState ? (persistedState as { byKey?: unknown }).byKey : null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { byKey: {} };
  const byKey: Record<string, BrowserFaviconEntry> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const migratedKey = migratePersistedFaviconKey(key);
    if (!migratedKey) continue;
    if (!value || typeof value !== "object") continue;
    const { dataUrl, capturedAt } = value as Record<string, unknown>;
    if (!isStorableFaviconDataUrl(dataUrl)) continue;
    if (!isValidFaviconCapturedAt(capturedAt)) continue;
    const rawAliases = (value as Record<string, unknown>).aliases;
    const aliases = Array.isArray(rawAliases)
      ? [...new Set(rawAliases.map(persistedFaviconAlias).filter((alias) => alias !== null))].slice(
          0,
          BROWSER_FAVICON_MAX_ALIASES_PER_ENTRY,
        )
      : [];
    const existing = byKey[migratedKey];
    const newest = !existing || capturedAt > existing.capturedAt;
    const mergedAliases = [
      ...new Set([
        ...(newest ? aliases : (existing?.aliases ?? [])),
        ...(newest ? (existing?.aliases ?? []) : aliases),
      ]),
    ].slice(0, BROWSER_FAVICON_MAX_ALIASES_PER_ENTRY);
    byKey[migratedKey] = {
      dataUrl: newest ? dataUrl : existing.dataUrl,
      capturedAt: newest ? capturedAt : existing.capturedAt,
      ...(mergedAliases.length > 0 ? { aliases: mergedAliases } : {}),
    };
  }
  return { byKey: evictExcessFavicons(byKey) };
}
