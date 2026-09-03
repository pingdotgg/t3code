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
  type EnvironmentIdentificationMode,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  findSharedSettingsMismatches,
  pickSharedServerSettings,
  splitSharedServerPatch,
} from "@t3tools/client-runtime/state/shared-settings";
import { ensureLocalApi } from "~/localApi";
import {
  getThemeDefinition,
  getThemePreviewSidebarArtwork,
  resolveThemeHalf,
  subscribeToThemePreview,
  themeAllowsSidebarArtwork,
} from "~/themePalette";
import * as Struct from "effect/Struct";
import { toastManager } from "~/components/ui/toast";
import { isHostedStaticApp } from "~/hostedPairing";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { useTheme } from "./useTheme";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";

type UnifiedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();
let clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let clientSettingsHydrated = false;
let clientSettingsHydrationPromise: Promise<void> | null = null;
let clientSettingsHydrationGeneration = 0;

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

async function hydrateClientSettings(): Promise<void> {
  if (clientSettingsHydrated) {
    return;
  }
  if (clientSettingsHydrationPromise) {
    return clientSettingsHydrationPromise;
  }

  const hydrationGeneration = clientSettingsHydrationGeneration;
  const nextHydration = (async () => {
    try {
      const persistedSettings = await ensureLocalApi().persistence.getClientSettings();
      if (hydrationGeneration !== clientSettingsHydrationGeneration) {
        return;
      }
      if (persistedSettings) {
        replaceClientSettingsSnapshot({ ...DEFAULT_CLIENT_SETTINGS, ...persistedSettings });
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

function persistClientSettings(settings: ClientSettings): void {
  replaceClientSettingsSnapshot(settings);
  void ensureLocalApi()
    .persistence.setClientSettings(settings)
    .catch((error) => {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, {
        operation: "persist",
        ...safeErrorLogAttributes(error),
      });
    });
}

// ── Key sets for routing patches ─────────────────────────────────────

const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function splitPatch(patch: UnifiedSettingsPatch): {
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

/**
 * Resolves once client settings have been read from disk.
 *
 * The pre-hydration snapshot is just the schema defaults, so imperative paths
 * that open a preview must await this or they bake the built-in viewport, zoom
 * and appearance into a tab that never picks up the user's saved values.
 */
export function ensureClientSettingsHydrated(): Promise<void> {
  return hydrateClientSettings();
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
  // Decode drops retired client keys, but older untyped persistence adapters
  // can still return them. Server-owned values must always win.
  return { ...clientSettings, ...serverSettings };
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

export function resolveEnvironmentIdentificationMode(input: {
  mode: EnvironmentIdentificationMode;
  settingsHydrated: boolean;
  paletteThemeActive?: boolean;
  paletteThemeAllowsArtwork?: boolean;
}): EnvironmentIdentificationMode {
  // Avoid briefly rendering the default artwork before a persisted pill/none choice loads.
  if (!input.settingsHydrated) return "none";
  // Artwork palettes are maintained for built-ins only. Keep an explicit
  // "none", but use the theme-aware pill for user-controlled palettes.
  return input.paletteThemeActive && !input.paletteThemeAllowsArtwork && input.mode === "artwork"
    ? "pill"
    : input.mode;
}

export function useEnvironmentIdentificationMode(): EnvironmentIdentificationMode {
  const settingsHydrated = useClientSettingsHydrated();
  const mode = useClientSettingsValue().environmentIdentificationMode;
  const { resolvedTheme, theme, themeHalves } = useTheme();
  const previewSidebarArtwork = useSyncExternalStore(
    subscribeToThemePreview,
    getThemePreviewSidebarArtwork,
    () => null,
  );
  const activeTheme = resolveThemeHalf(theme, themeHalves, resolvedTheme);
  const activeThemeDefinition = getThemeDefinition(activeTheme);
  return resolveEnvironmentIdentificationMode({
    mode,
    settingsHydrated,
    paletteThemeActive: previewSidebarArtwork !== null || activeThemeDefinition !== null,
    paletteThemeAllowsArtwork: previewSidebarArtwork ?? themeAllowsSidebarArtwork(activeTheme),
  });
}

/**
 * Whether the legacy sidebar (Settings → General → Legacy features) replaces
 * the default one.
 *
 * Held at the default sidebar until client settings hydrate: the pre-hydration
 * snapshot is just the schema defaults, so resolving against it could mount one
 * sidebar and then swap it out once persisted settings land — remounting the
 * whole tree for everyone instead of only for legacy opt-ins.
 */
export function useLegacySidebarEnabled(): boolean {
  const settingsHydrated = useClientSettingsHydrated();
  const legacySidebarEnabled = useClientSettingsValue().legacySidebarEnabled;
  return settingsHydrated && legacySidebarEnabled;
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

export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE =
  "This setting is saved on a server, and the hosted app is not anchored to one. Change it from the desktop app or from the server's own address.";

/**
 * Whether primary-scoped server settings have a server to live on. The
 * hosted app connects to every environment as a remote, so it has no primary:
 * `usePrimarySettings` reads schema defaults there and writes have nowhere
 * to go. Desktop and server-served web always have one.
 */
export function usePrimarySettingsAvailable(): boolean {
  const primaryEnvironment = usePrimaryEnvironment();
  return primaryEnvironment !== null || !isHostedStaticApp();
}

/**
 * Whether an environment can hold every shared key right now. Gated on the
 * auto-settlement capability because it is the newest of the shared keys: a
 * server that has it has all of them. Older servers drop unknown keys on
 * write, so a mismatch against them could never clear, and their decoded
 * defaults must not be treated as real values.
 */
function supportsSharedSettings(environment: EnvironmentPresentation): boolean {
  return (
    environment.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.threadAutoSettlement === true
  );
}

/** Environments that can receive a shared settings write right now. */
function useConnectedEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      environments.filter(supportsSharedSettings).map((environment) => environment.environmentId),
    [environments],
  );
}

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys are optimistically patched in atom-backed server state, then
 * persisted via RPC. Shared server keys (see `SHARED_SERVER_SETTING_KEYS`)
 * are written to every connected environment, not only the target, so a user
 * preference does not silently drift between machines. Client keys go through
 * client persistence.
 */
function useUpdateSettingsTarget(environmentId: EnvironmentId | null) {
  const persistServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "server settings update",
  );
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const updateSettings = useCallback(
    (patch: UnifiedSettingsPatch) => {
      const { serverPatch, clientPatch } = splitPatch(patch);

      if (Object.keys(serverPatch).length > 0) {
        const { sharedPatch, localPatch } = splitSharedServerPatch(serverPatch);
        // Dropping the write silently leaves the control looking saved.
        const warnUnsaved = () =>
          toastManager.add({
            type: "warning",
            title: "Setting not saved",
            description: PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE,
          });
        if (Object.keys(localPatch).length > 0) {
          if (environmentId) {
            void persistServerSettings({
              environmentId,
              input: { patch: localPatch },
            });
          } else {
            warnUnsaved();
          }
        }
        if (Object.keys(sharedPatch).length > 0) {
          const targets = new Set(connectedEnvironmentIds);
          if (environmentId) {
            targets.add(environmentId);
          }
          if (targets.size === 0) {
            warnUnsaved();
          }
          for (const targetId of targets) {
            void persistServerSettings({
              environmentId: targetId,
              input: { patch: sharedPatch },
            });
          }
        }
      }
      if (Object.keys(clientPatch).length > 0) {
        persistClientSettings({
          ...getClientSettingsSnapshot(),
          ...clientPatch,
        });
      }
    },
    [connectedEnvironmentIds, environmentId, persistServerSettings],
  );

  return updateSettings;
}

/**
 * Connected environments whose shared settings differ from the primary's,
 * plus an action that writes the primary's values to all of them. Drift
 * happens when an environment was offline during an edit or was changed by
 * an older client.
 */
export function useSharedSettingsSync() {
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  // Read the loaded config, not `primaryServerSettingsAtom`: that atom falls
  // back to defaults while the primary is disconnected, and "apply to all"
  // must never push defaults over real values. Same for a primary too old to
  // hold the shared keys: its decoded defaults are not a source of truth.
  const primarySettings =
    primaryEnvironment !== null && supportsSharedSettings(primaryEnvironment)
      ? (primaryEnvironment.serverConfig?.settings ?? null)
      : null;
  const { environments } = useEnvironments();
  const persistServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "server settings update",
  );

  const mismatches = useMemo(
    () =>
      findSharedSettingsMismatches({
        primaryEnvironmentId,
        primarySettings,
        environments: environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          connected: supportsSharedSettings(environment),
          settings: environment.serverConfig?.settings ?? null,
        })),
      }),
    [environments, primaryEnvironmentId, primarySettings],
  );

  const applyToAll = useCallback(() => {
    if (primarySettings === null) {
      return;
    }
    const patch = pickSharedServerSettings(primarySettings);
    for (const mismatch of mismatches) {
      void persistServerSettings({
        environmentId: mismatch.environmentId,
        input: { patch },
      });
    }
  }, [mismatches, persistServerSettings, primarySettings]);

  return { mismatches, applyToAll };
}

export function useUpdateEnvironmentSettings(environmentId: EnvironmentId) {
  return useUpdateSettingsTarget(environmentId);
}

export function useUpdatePrimarySettings() {
  return useUpdateSettingsTarget(usePrimaryEnvironment()?.environmentId ?? null);
}

export function useUpdateClientSettings() {
  return useCallback((patch: ClientSettingsPatch) => {
    persistClientSettings({
      ...getClientSettingsSnapshot(),
      ...patch,
    });
  }, []);
}
