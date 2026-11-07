import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";

/**
 * Keeps the client-settings snapshot in a dependency-free module so readers such
 * as the i18n layer can subscribe without importing the persistence layer, which
 * itself imports UI modules that translate.
 */

export type ClientSettingsHydrationStatus = "pending" | "ready" | "failed" | "retrying";

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();
let clientSettingsSnapshot: ClientSettings = DEFAULT_CLIENT_SETTINGS;
let clientSettingsHydrationStatus: ClientSettingsHydrationStatus = "pending";

let hydrateClientSettings: (() => Promise<void>) | null = null;

/** Registered by the persistence module so subscribers can start hydration lazily. */
export function registerClientSettingsHydrator(hydrate: () => Promise<void>): void {
  hydrateClientSettings = hydrate;
}

function requestHydration(): void {
  void hydrateClientSettings?.().catch(() => undefined);
}

export function getClientSettingsSnapshot(): ClientSettings {
  return clientSettingsSnapshot;
}

export function replaceClientSettingsSnapshot(settings: ClientSettings): void {
  clientSettingsSnapshot = settings;
  for (const listener of clientSettingsListeners) {
    listener();
  }
}

export function getClientSettings(): ClientSettings {
  return clientSettingsSnapshot;
}

export function subscribeClientSettings(listener: () => void): () => void {
  clientSettingsListeners.add(listener);
  requestHydration();
  return () => {
    clientSettingsListeners.delete(listener);
  };
}

export function setClientSettingsHydrationStatus(nextStatus: ClientSettingsHydrationStatus): void {
  if (clientSettingsHydrationStatus === nextStatus) {
    return;
  }
  clientSettingsHydrationStatus = nextStatus;
  for (const listener of clientSettingsHydrationListeners) {
    listener();
  }
}

export function getClientSettingsHydratedSnapshot(): boolean {
  return clientSettingsHydrationStatus === "ready";
}

export function getClientSettingsHydrationStatusSnapshot(): ClientSettingsHydrationStatus {
  return clientSettingsHydrationStatus;
}

export function subscribeClientSettingsHydration(listener: () => void): () => void {
  clientSettingsHydrationListeners.add(listener);
  requestHydration();
  return () => {
    clientSettingsHydrationListeners.delete(listener);
  };
}

export function __resetClientSettingsStoreForTests(): void {
  clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  clientSettingsHydrationStatus = "pending";
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
}

export function __setClientSettingsStoreForTests(settings: ClientSettings): void {
  clientSettingsSnapshot = settings;
  clientSettingsHydrationStatus = "ready";
}
