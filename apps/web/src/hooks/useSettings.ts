/**
 * Environment-scoped settings hooks.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and
 * client-only settings (persisted in localStorage).
 *
 * Live server settings always require an environment id. Primary-environment
 * access is intentionally named as such so environment-sensitive consumers
 * cannot silently read the wrong server's settings.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  type ClientSettingsPatch,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { ensureLocalApi } from "~/localApi";
import { readRendererStateWithRetries } from "~/rendererStateStorage";
import * as Struct from "effect/Struct";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";
import { usePrimaryEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();
let clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let clientSettingsHydrated = false;
let clientSettingsPersistenceReady = false;
let clientSettingsHydrationPromise: Promise<void> | null = null;
let clientSettingsHydrationGeneration = 0;
let clientSettingsHydrationBaseline: ClientSettings | null = null;
let clientSettingsWriteQueue: Promise<void> = Promise.resolve();

function emitClientSettingsChange() {
  for (const listener of clientSettingsListeners) {
    listener();
  }
}

function emitClientSettingsHydrationChange() {
  for (const listener of clientSettingsHydrationListeners) {
    listener();
  }
}

function getClientSettingsSnapshot(): ClientSettings {
  return clientSettingsSnapshot;
}

function replaceClientSettingsSnapshot(settings: ClientSettings): void {
  clientSettingsSnapshot = settings;
  emitClientSettingsChange();
}

function setClientSettingsHydrated(nextHydrated: boolean): void {
  if (clientSettingsHydrated === nextHydrated) {
    return;
  }
  clientSettingsHydrated = nextHydrated;
  emitClientSettingsHydrationChange();
}

function subscribeClientSettings(listener: () => void): () => void {
  clientSettingsListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsListeners.delete(listener);
  };
}

function getClientSettingsHydratedSnapshot(): boolean {
  return clientSettingsHydrated;
}

function subscribeClientSettingsHydration(listener: () => void): () => void {
  clientSettingsHydrationListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsHydrationListeners.delete(listener);
  };
}

function persistedSettingsValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainSettingsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reconcilePersistedSettingsValue(
  persisted: unknown,
  current: unknown,
  baseline: unknown,
): unknown {
  if (persistedSettingsValuesEqual(current, baseline)) {
    return persisted;
  }
  if (
    isPlainSettingsObject(persisted) &&
    isPlainSettingsObject(current) &&
    isPlainSettingsObject(baseline)
  ) {
    const reconciled: Record<string, unknown> = {};
    const keys = new Set([
      ...Object.keys(persisted),
      ...Object.keys(current),
      ...Object.keys(baseline),
    ]);
    for (const key of keys) {
      const currentHasKey = Object.hasOwn(current, key);
      const baselineHasKey = Object.hasOwn(baseline, key);
      if (currentHasKey !== baselineHasKey) {
        if (currentHasKey) {
          reconciled[key] = current[key];
        }
        continue;
      }
      if (!currentHasKey) {
        if (Object.hasOwn(persisted, key)) {
          reconciled[key] = persisted[key];
        }
        continue;
      }
      reconciled[key] = reconcilePersistedSettingsValue(
        persisted[key],
        current[key],
        baseline[key],
      );
    }
    return reconciled;
  }
  return current;
}

function reconcileHydratedClientSettings(
  persisted: ClientSettings,
  current: ClientSettings,
  baseline: ClientSettings,
): ClientSettings {
  return reconcilePersistedSettingsValue(persisted, current, baseline) as ClientSettings;
}

export function continueClientSettingsHydrationInBackground(): void {
  if (clientSettingsPersistenceReady) {
    return;
  }
  clientSettingsHydrationBaseline ??= clientSettingsSnapshot;
  clientSettingsHydrationGeneration += 1;
  clientSettingsHydrationPromise = null;
  setClientSettingsHydrated(true);
  void hydrateClientSettings();
}

export async function hydrateClientSettings(): Promise<void> {
  if (clientSettingsPersistenceReady) {
    return;
  }
  if (clientSettingsHydrationPromise) {
    return clientSettingsHydrationPromise;
  }

  const hydrationGeneration = clientSettingsHydrationGeneration;
  clientSettingsHydrationBaseline ??= clientSettingsSnapshot;
  const nextHydration = (async () => {
    try {
      const persistedSettings = await readRendererStateWithRetries(() =>
        ensureLocalApi().persistence.getClientSettings(),
      );
      if (hydrationGeneration !== clientSettingsHydrationGeneration) {
        return;
      }
      const baseline = clientSettingsHydrationBaseline ?? DEFAULT_CLIENT_SETTINGS;
      const current = clientSettingsSnapshot;
      const hadLocalChanges = !persistedSettingsValuesEqual(current, baseline);
      const reconciledSettings = reconcileHydratedClientSettings(
        persistedSettings
          ? { ...DEFAULT_CLIENT_SETTINGS, ...persistedSettings }
          : DEFAULT_CLIENT_SETTINGS,
        current,
        baseline,
      );
      replaceClientSettingsSnapshot(reconciledSettings);
      clientSettingsPersistenceReady = true;
      clientSettingsHydrationBaseline = null;
      if (hadLocalChanges) {
        await enqueueClientSettingsPersistence(reconciledSettings).catch(
          logClientSettingsPersistenceError,
        );
      }
    } catch (error) {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} hydrate failed`, {
        operation: "hydrate",
        ...safeErrorLogAttributes(error),
      });
    } finally {
      if (hydrationGeneration === clientSettingsHydrationGeneration) {
        setClientSettingsHydrated(true);
      }
    }
  })();

  const hydrationPromise = nextHydration.finally(() => {
    if (clientSettingsHydrationPromise === hydrationPromise) {
      clientSettingsHydrationPromise = null;
    }
  });
  clientSettingsHydrationPromise = hydrationPromise;

  return clientSettingsHydrationPromise;
}

function enqueueClientSettingsPersistence(settings: ClientSettings): Promise<void> {
  const write = clientSettingsWriteQueue
    .catch(() => undefined)
    .then(() => ensureLocalApi().persistence.setClientSettings(settings));
  clientSettingsWriteQueue = write;
  return write;
}

function logClientSettingsPersistenceError(error: unknown): void {
  console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, {
    operation: "persist",
    ...safeErrorLogAttributes(error),
  });
}

function persistClientSettings(settings: ClientSettings): void {
  replaceClientSettingsSnapshot(settings);
  if (!clientSettingsPersistenceReady) {
    continueClientSettingsHydrationInBackground();
    return;
  }
  void enqueueClientSettingsPersistence(settings).catch(logClientSettingsPersistenceError);
}

export async function flushClientSettingsPersistence(): Promise<void> {
  if (!clientSettingsPersistenceReady) {
    return;
  }
  await enqueueClientSettingsPersistence(clientSettingsSnapshot);
}

// ── Key sets for routing patches ─────────────────────────────────────

const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function splitPatch(patch: Partial<UnifiedSettings>): {
  serverPatch: ServerSettingsPatch;
  clientPatch: ClientSettingsPatch;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    } else {
      clientPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    clientPatch: clientPatch as ClientSettingsPatch,
  };
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Non-hook accessor for the current merged client settings snapshot.
 * Used by non-React code paths (e.g. runtime services) that need the latest
 * settings without subscribing.
 */
export function getClientSettings(): ClientSettings {
  return getClientSettingsSnapshot();
}

export function useClientSettingsHydrated(): boolean {
  return useSyncExternalStore(
    subscribeClientSettingsHydration,
    getClientSettingsHydratedSnapshot,
    () => false,
  );
}

function useClientSettingsValue(): ClientSettings {
  return useSyncExternalStore(
    subscribeClientSettings,
    getClientSettingsSnapshot,
    () => DEFAULT_CLIENT_SETTINGS,
  );
}

export function mergeEnvironmentSettings(
  serverSettings: ServerSettings,
  clientSettings: ClientSettings,
): UnifiedSettings {
  return { ...serverSettings, ...clientSettings };
}

function useMergedSettings<T>(
  serverSettings: ServerSettings,
  selector: ((settings: UnifiedSettings) => T) | undefined,
): T {
  const clientSettings = useClientSettingsValue();

  const merged = useMemo<UnifiedSettings>(
    () => mergeEnvironmentSettings(serverSettings, clientSettings),
    [clientSettings, serverSettings],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

export function useClientSettings<T = ClientSettings>(
  selector?: (settings: ClientSettings) => T,
): T {
  const settings = useClientSettingsValue();
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

/** Read current settings for one environment, merged with client-local preferences. */
export function useEnvironmentSettings<T = UnifiedSettings>(
  environmentId: EnvironmentId,
  selector?: (settings: UnifiedSettings) => T,
): T {
  const serverSettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  return useMergedSettings(serverSettings ?? DEFAULT_SERVER_SETTINGS, selector);
}

/** Primary-only settings access for the settings UI and other explicitly global surfaces. */
export function usePrimarySettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  return useMergedSettings(useAtomValue(primaryServerSettingsAtom), selector);
}

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys are optimistically patched in atom-backed server state, then
 * persisted via RPC. Client keys go through client persistence.
 */
function useUpdateSettingsTarget(environmentId: EnvironmentId | null) {
  const persistServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "server settings update",
  );
  const updateSettings = useCallback(
    (patch: Partial<UnifiedSettings>) => {
      const { serverPatch, clientPatch } = splitPatch(patch);

      if (Object.keys(serverPatch).length > 0) {
        if (environmentId) {
          void persistServerSettings({
            environmentId,
            input: { patch: serverPatch },
          });
        }
      }

      if (Object.keys(clientPatch).length > 0) {
        persistClientSettings({
          ...getClientSettingsSnapshot(),
          ...clientPatch,
        });
      }
    },
    [environmentId, persistServerSettings],
  );

  return updateSettings;
}

export function useUpdateEnvironmentSettings(environmentId: EnvironmentId) {
  return useUpdateSettingsTarget(environmentId);
}

export function useUpdatePrimarySettings() {
  return useUpdateSettingsTarget(usePrimaryEnvironment()?.environmentId ?? null);
}

export function useUpdateClientSettings() {
  return useCallback(updateClientSettings, []);
}

export function updateClientSettings(patch: ClientSettingsPatch): void {
  persistClientSettings({
    ...getClientSettingsSnapshot(),
    ...patch,
  });
}

export function __resetClientSettingsPersistenceForTests(): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  clientSettingsHydrated = false;
  clientSettingsPersistenceReady = false;
  clientSettingsHydrationPromise = null;
  clientSettingsHydrationBaseline = null;
  clientSettingsWriteQueue = Promise.resolve();
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
}

export function __setClientSettingsForTests(settings: ClientSettings): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = settings;
  clientSettingsHydrated = true;
  clientSettingsPersistenceReady = true;
  clientSettingsHydrationPromise = null;
  clientSettingsHydrationBaseline = null;
  clientSettingsWriteQueue = Promise.resolve();
}
