import {
  readWebFeatureFlagsFromUrl,
  normalizeWebFeatureFlags,
  type WebFeatureFlag,
} from "@t3tools/shared/webFeatureFlags";

const WEB_FEATURE_FLAGS_STORAGE_KEY = "salchi:web-feature-flags:v1";

function readSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readStoredFeatureFlags(): WebFeatureFlag[] {
  const storage = readSessionStorage();
  if (!storage) {
    return [];
  }

  try {
    const parsed = JSON.parse(storage.getItem(WEB_FEATURE_FLAGS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? normalizeWebFeatureFlags(parsed) : [];
  } catch {
    return [];
  }
}

function writeStoredFeatureFlags(flags: readonly WebFeatureFlag[]): void {
  const storage = readSessionStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(WEB_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify(flags));
  } catch {
    // Best effort only; URL flags still work on the current route.
  }
}

export function getEnabledWebFeatureFlags(): readonly WebFeatureFlag[] {
  if (typeof window === "undefined") {
    return [];
  }

  const urlFlags = readWebFeatureFlagsFromUrl(new URL(window.location.href));
  const flags = normalizeWebFeatureFlags([...readStoredFeatureFlags(), ...urlFlags]);
  if (urlFlags.length > 0) {
    writeStoredFeatureFlags(flags);
  }
  return flags;
}

export function isWebFeatureEnabled(flag: WebFeatureFlag): boolean {
  return getEnabledWebFeatureFlags().includes(flag);
}

export function resetWebFeatureFlagsForTests(): void {
  readSessionStorage()?.removeItem(WEB_FEATURE_FLAGS_STORAGE_KEY);
}
