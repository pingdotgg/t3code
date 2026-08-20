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
  AuthOrchestrationOperateScope,
  DEFAULT_SERVER_SETTINGS,
  getSyncedClientPreferenceUpdatedAt,
  type EnvironmentId,
  ServerSettings,
  type ServerSettingsPatch,
  type SyncedClientPreferences,
  type SyncedClientPreferencesPatch,
} from "@t3tools/contracts";
import {
  type ClientSettingsPatch,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type EnvironmentIdentificationMode,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { ensureLocalApi } from "~/localApi";
import {
  canonicalThemePreference,
  getThemePreferenceMode,
  getThemeDefinition,
  getThemePreviewSidebarArtwork,
  isKnownThemePreference,
  resolveThemeHalf,
  subscribeToThemePreview,
  themeAllowsSidebarArtwork,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
  type ThemePreferenceMode,
} from "~/themePalette";
import * as Struct from "effect/Struct";
import { Atom } from "effect/unstable/reactivity";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";
import { usePrimaryEnvironment } from "~/state/environments";
import { environmentSession } from "~/state/session";
import { environmentShell } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  SHELL_NOT_LIVE,
  createSyncedClientPreferenceHydrationController,
  createSyncedClientPreferencesSliceAtom,
  useSyncedClientPreferenceHydrationEffect,
} from "./synced-client-preferences";
import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "./useTheme";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";

type UnifiedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();
let clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let clientSettingsHydrated = false;
let clientSettingsHydrationPromise: Promise<void> | null = null;
let clientSettingsHydrationGeneration = 0;
let clientSettingsPersistenceQueue = Promise.resolve();
const EMPTY_SYNCED_CLIENT_PREFERENCES_ATOM = Atom.make(SHELL_NOT_LIVE);
const EMPTY_AUTH_SESSION_ATOM = Atom.make(null);

const syncedClientPreferencesSliceAtom = Atom.family((environmentId: EnvironmentId) =>
  createSyncedClientPreferencesSliceAtom(environmentShell.stateValueAtom(environmentId)).pipe(
    Atom.withLabel(`web:synced-client-preferences:${environmentId}`),
  ),
);

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
  clientSettingsPersistenceQueue = clientSettingsPersistenceQueue
    .then(() => ensureLocalApi().persistence.setClientSettings(settings))
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
  syncedClientPreferences?: SyncedClientPreferences,
  syncedPlanModeCanOverrideClient = true,
  pendingPlanModeWrite?: { readonly value: boolean; readonly updatedAt: string },
): UnifiedSettings {
  const syncedPlanModeUpdatedAt = getSyncedClientPreferenceUpdatedAt(
    syncedClientPreferences,
    "planModeEnabled",
  );
  const pendingPlanModeIsNewer =
    pendingPlanModeWrite !== undefined &&
    (syncedPlanModeUpdatedAt === undefined ||
      pendingPlanModeWrite.updatedAt > syncedPlanModeUpdatedAt);
  let merged: UnifiedSettings = {
    ...serverSettings,
    ...clientSettings,
  };
  if (syncedPlanModeCanOverrideClient) {
    if (pendingPlanModeIsNewer) {
      merged = { ...merged, planModeEnabled: pendingPlanModeWrite.value };
    } else if (syncedClientPreferences?.planModeEnabled !== undefined) {
      merged = { ...merged, planModeEnabled: syncedClientPreferences.planModeEnabled };
    }
  }
  return merged;
}

function useMergedSettings<T>(
  serverSettings: ServerSettings,
  syncedClientPreferences: SyncedClientPreferences | undefined,
  syncedPlanModeCanOverrideClient: boolean,
  pendingPlanModeWrite: { readonly value: boolean; readonly updatedAt: string } | undefined,
  selector: ((settings: UnifiedSettings) => T) | undefined,
): T {
  const clientSettings = useClientSettingsValue();

  const merged = useMemo<UnifiedSettings>(
    () =>
      mergeEnvironmentSettings(
        serverSettings,
        clientSettings,
        syncedClientPreferences,
        syncedPlanModeCanOverrideClient,
        pendingPlanModeWrite,
      ),
    [
      clientSettings,
      pendingPlanModeWrite,
      serverSettings,
      syncedClientPreferences,
      syncedPlanModeCanOverrideClient,
    ],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

export const DEFAULT_SYNCED_THEME_ID = "t3-code";

export function syncedThemeIdFromPreference(theme: ThemePreference): string | undefined {
  if (theme === "system" || theme === "light" || theme === "dark") {
    return DEFAULT_SYNCED_THEME_ID;
  }
  return isKnownThemePreference(theme) ? canonicalThemePreference(theme) : undefined;
}

export function themePreferenceFromSyncedThemeId(themeId: string): ThemePreference {
  if (
    themeId === DEFAULT_SYNCED_THEME_ID ||
    themeId === "system" ||
    themeId === "light" ||
    themeId === "dark"
  ) {
    return "system";
  }
  return isKnownThemePreference(themeId) ? canonicalThemePreference(themeId) : "system";
}

type SyncedThemeHalfMutation =
  | Readonly<{ type: "none" }>
  | Readonly<{
      type: "set-half";
      appearance: ThemeAppearance;
      theme: ThemePreference | null;
    }>
  | Readonly<{
      type: "reset-base";
      baseTheme: ThemePreference;
      preservedAppearance: ThemeAppearance;
      preservedTheme: ThemePreference | null;
    }>;

export function resolveSyncedThemeHalfMutation(
  baseTheme: ThemePreference,
  themeHalves: ThemeHalves | null,
  appearanceMode: ThemePreferenceMode,
  appearance: ThemeAppearance,
  theme: ThemePreference,
): SyncedThemeHalfMutation {
  if (resolveThemeHalf(baseTheme, themeHalves, appearance) === theme) return { type: "none" };
  if (theme !== "system") return { type: "set-half", appearance, theme };
  if (syncedThemeIdFromPreference(baseTheme) === DEFAULT_SYNCED_THEME_ID) {
    return { type: "set-half", appearance, theme: null };
  }

  const preservedAppearance = appearance === "light" ? "dark" : "light";
  const preservedTheme = resolveThemeHalf(baseTheme, themeHalves, preservedAppearance);
  return {
    type: "reset-base",
    baseTheme: appearanceMode === "system" ? "system" : appearanceMode,
    preservedAppearance,
    preservedTheme:
      syncedThemeIdFromPreference(preservedTheme) === DEFAULT_SYNCED_THEME_ID
        ? null
        : preservedTheme,
  };
}

const syncedPlanModeHydrationController =
  createSyncedClientPreferenceHydrationController("planModeEnabled");
const syncedAppearanceModeHydrationController =
  createSyncedClientPreferenceHydrationController("appearanceMode");
const syncedLightThemeIdHydrationController =
  createSyncedClientPreferenceHydrationController("lightThemeId");
const syncedDarkThemeIdHydrationController =
  createSyncedClientPreferenceHydrationController("darkThemeId");

function useEnvironmentSyncedClientPreferences(environmentId: EnvironmentId | null) {
  const preferences = useAtomValue(
    environmentId === null
      ? EMPTY_SYNCED_CLIENT_PREFERENCES_ATOM
      : syncedClientPreferencesSliceAtom(environmentId),
  );
  return {
    live: preferences !== SHELL_NOT_LIVE,
    preferences: preferences === SHELL_NOT_LIVE ? undefined : preferences,
  } as const;
}

function useCanPatchSyncedClientPreferences(environmentId: EnvironmentId | null): boolean {
  const session = useAtomValue(
    environmentId === null
      ? EMPTY_AUTH_SESSION_ATOM
      : environmentSession.sessionStateValueAtom(environmentId),
  );
  return (
    session?.authenticated === true &&
    session.scopes?.includes(AuthOrchestrationOperateScope) === true
  );
}

function useSyncedClientPreferenceState() {
  const clientSettings = useClientSettingsValue();
  const themeState = useTheme();
  const persistPlanMode = useCallback((value: boolean, updatedAt: string) => {
    const snapshot = getClientSettingsSnapshot();
    if (snapshot.planModeEnabled === value && snapshot.planModeUpdatedAt === updatedAt) return;
    persistClientSettings({
      ...snapshot,
      planModeEnabled: value,
      planModeUpdatedAt: updatedAt,
    });
  }, []);
  const persistAppearanceMode = useCallback(
    (value: ThemePreferenceMode, updatedAt: string) => {
      if (themeState.appearanceMode !== value) themeState.setAppearanceMode(value);
      const snapshot = getClientSettingsSnapshot();
      if (snapshot.appearanceModeUpdatedAt !== updatedAt) {
        persistClientSettings({ ...snapshot, appearanceModeUpdatedAt: updatedAt });
      }
    },
    [themeState.appearanceMode, themeState.setAppearanceMode],
  );
  const persistThemeId = useCallback(
    (appearance: "light" | "dark", value: string, updatedAt: string) => {
      const theme = themePreferenceFromSyncedThemeId(value);
      const liveBaseTheme = readThemePreference();
      const liveThemeHalves = readThemeHalves();
      const mutation = resolveSyncedThemeHalfMutation(
        liveBaseTheme,
        liveThemeHalves,
        readAppearanceModePreference(liveBaseTheme),
        appearance,
        theme,
      );
      if (mutation.type === "set-half") {
        themeState.setThemeHalf(mutation.appearance, mutation.theme);
      } else if (mutation.type === "reset-base") {
        // Read storage live because both field hydration effects can run in one
        // commit before React produces a fresh theme snapshot.
        if (themeState.setTheme(mutation.baseTheme) && mutation.preservedTheme !== null) {
          themeState.setThemeHalf(mutation.preservedAppearance, mutation.preservedTheme);
        }
      }

      const snapshot = getClientSettingsSnapshot();
      const updatedAtKey =
        appearance === "light" ? "lightThemeIdUpdatedAt" : "darkThemeIdUpdatedAt";
      if (snapshot[updatedAtKey] !== updatedAt) {
        persistClientSettings({ ...snapshot, [updatedAtKey]: updatedAt });
      }
    },
    [themeState.setTheme, themeState.setThemeHalf],
  );

  const lightThemeId = syncedThemeIdFromPreference(
    resolveThemeHalf(themeState.theme, themeState.themeHalves, "light"),
  );
  const darkThemeId = syncedThemeIdFromPreference(
    resolveThemeHalf(themeState.theme, themeState.themeHalves, "dark"),
  );
  const persistLightThemeId = useCallback(
    (value: string, updatedAt: string) => persistThemeId("light", value, updatedAt),
    [persistThemeId],
  );
  const persistDarkThemeId = useCallback(
    (value: string, updatedAt: string) => persistThemeId("dark", value, updatedAt),
    [persistThemeId],
  );

  return {
    appearanceMode: themeState.appearanceMode,
    appearanceModeUpdatedAt: clientSettings.appearanceModeUpdatedAt,
    darkThemeIdUpdatedAt: clientSettings.darkThemeIdUpdatedAt,
    lightThemeIdUpdatedAt: clientSettings.lightThemeIdUpdatedAt,
    planModeUpdatedAt: clientSettings.planModeUpdatedAt,
    persistAppearanceMode,
    persistPlanMode,
    persistDarkThemeId,
    persistLightThemeId,
    planModeEnabled: clientSettings.planModeEnabled,
    darkThemeId,
    lightThemeId,
    themeState,
  } as const;
}

function useSynchronizeSyncedClientPreferences(
  environmentId: EnvironmentId | null,
  state: ReturnType<typeof useSyncedClientPreferenceState>,
  onHydrated?: (() => void) | undefined,
) {
  const clientHydrated = useClientSettingsHydrated();
  const primaryEnvironmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const synced = useEnvironmentSyncedClientPreferences(environmentId);
  const canPatch = useCanPatchSyncedClientPreferences(environmentId);
  const patchPreferences = useAtomCommand(serverEnvironment.patchSyncedClientPreferences, {
    label: "synced client preferences seed",
    reportFailure: false,
  });
  const common = {
    environmentId,
    primaryEnvironmentId,
    clientHydrated,
    live: synced.live,
    serverPreferences: synced.preferences,
    canPatch,
    now: new Date().toISOString(),
    patch: patchPreferences,
  } as const;

  useSyncedClientPreferenceHydrationEffect(syncedPlanModeHydrationController, {
    ...common,
    clientValue: state.planModeEnabled,
    ...(state.planModeUpdatedAt === undefined
      ? undefined
      : { clientUpdatedAt: state.planModeUpdatedAt }),
    persist: state.persistPlanMode,
    onHydrated,
  });
  useSyncedClientPreferenceHydrationEffect(syncedAppearanceModeHydrationController, {
    ...common,
    clientValue: state.appearanceMode,
    ...(state.appearanceModeUpdatedAt === undefined
      ? undefined
      : { clientUpdatedAt: state.appearanceModeUpdatedAt }),
    persist: state.persistAppearanceMode,
  });
  useSyncedClientPreferenceHydrationEffect(syncedLightThemeIdHydrationController, {
    ...common,
    clientValue: state.lightThemeId,
    ...(state.lightThemeIdUpdatedAt === undefined
      ? undefined
      : { clientUpdatedAt: state.lightThemeIdUpdatedAt }),
    persist: state.persistLightThemeId,
  });
  useSyncedClientPreferenceHydrationEffect(syncedDarkThemeIdHydrationController, {
    ...common,
    clientValue: state.darkThemeId,
    ...(state.darkThemeIdUpdatedAt === undefined
      ? undefined
      : { clientUpdatedAt: state.darkThemeIdUpdatedAt }),
    persist: state.persistDarkThemeId,
  });

  return {
    ...synced,
    canPatch,
    pendingWrite: syncedPlanModeHydrationController.getPendingWrite(environmentId),
  } as const;
}

function useSyncedClientPreferencesHydration(
  environmentId: EnvironmentId | null,
  onHydrated?: (() => void) | undefined,
) {
  const state = useSyncedClientPreferenceState();
  return useSynchronizeSyncedClientPreferences(environmentId, state, onHydrated);
}

function useSyncedClientPreferencesState(environmentId: EnvironmentId | null) {
  const synced = useEnvironmentSyncedClientPreferences(environmentId);
  const canPatch = useCanPatchSyncedClientPreferences(environmentId);
  return {
    ...synced,
    canPatch,
    pendingWrite: syncedPlanModeHydrationController.getPendingWrite(environmentId),
  } as const;
}

export function SyncedPlanModeEnvironmentSync(props: {
  readonly environmentId: EnvironmentId;
  readonly onHydrated?: (() => void) | undefined;
}): null {
  useSyncedClientPreferencesHydration(props.environmentId, props.onHydrated);
  return null;
}

function useWriteSyncedClientPreferences(
  environmentId: EnvironmentId | null,
  state: ReturnType<typeof useSyncedClientPreferenceState>,
) {
  const synced = useEnvironmentSyncedClientPreferences(environmentId);
  const canPatch = useCanPatchSyncedClientPreferences(environmentId);
  const patchPreferences = useAtomCommand(serverEnvironment.patchSyncedClientPreferences, {
    label: "synced client preferences update",
    reportFailure: false,
  });
  return useCallback(
    (valuePatch: SyncedClientPreferencesPatch) => {
      const common = {
        environmentId,
        serverPreferences: synced.preferences,
        canPatch,
        now: new Date().toISOString(),
        patch: patchPreferences,
      } as const;
      if (valuePatch.planModeEnabled !== undefined) {
        syncedPlanModeHydrationController.write({
          ...common,
          value: valuePatch.planModeEnabled,
          persist: state.persistPlanMode,
        });
      }
      if (valuePatch.appearanceMode !== undefined) {
        syncedAppearanceModeHydrationController.write({
          ...common,
          value: valuePatch.appearanceMode,
          persist: state.persistAppearanceMode,
        });
      }
      if (valuePatch.lightThemeId !== undefined) {
        syncedLightThemeIdHydrationController.write({
          ...common,
          value: valuePatch.lightThemeId,
          persist: state.persistLightThemeId,
        });
      }
      if (valuePatch.darkThemeId !== undefined) {
        syncedDarkThemeIdHydrationController.write({
          ...common,
          value: valuePatch.darkThemeId,
          persist: state.persistDarkThemeId,
        });
      }
    },
    [
      canPatch,
      environmentId,
      patchPreferences,
      state.persistAppearanceMode,
      state.persistPlanMode,
      state.persistDarkThemeId,
      state.persistLightThemeId,
      synced.preferences,
    ],
  );
}

export function useSyncedTheme() {
  const state = useSyncedClientPreferenceState();
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  useSynchronizeSyncedClientPreferences(environmentId, state);
  const write = useWriteSyncedClientPreferences(environmentId, state);
  const setTheme = useCallback(
    (theme: ThemePreference): boolean => {
      if (!state.themeState.setTheme(theme)) return false;
      const themeId = syncedThemeIdFromPreference(theme);
      if (themeId !== undefined) write({ lightThemeId: themeId, darkThemeId: themeId });
      return true;
    },
    [state.themeState, write],
  );
  const setThemeHalf = useCallback(
    (appearance: "light" | "dark", themeId: string | null): boolean => {
      if (!state.themeState.setThemeHalf(appearance, themeId)) return false;
      const syncedThemeId = syncedThemeIdFromPreference(themeId ?? state.themeState.theme);
      if (syncedThemeId !== undefined) {
        write(syncedThemePatchForHalf(appearance, syncedThemeId));
      }
      return true;
    },
    [state.themeState, write],
  );
  const setAppearanceMode = useCallback(
    (appearanceMode: ThemePreferenceMode): boolean => {
      if (!state.themeState.setAppearanceMode(appearanceMode)) return false;
      write({ appearanceMode });
      return true;
    },
    [state.themeState, write],
  );
  const setFollowSystem = useCallback(
    (followSystem: boolean): boolean => {
      if (!state.themeState.setFollowSystem(followSystem)) return false;
      const appearanceMode = followSystem
        ? "system"
        : state.themeState.appearanceMode === "system"
          ? (getThemePreferenceMode(state.themeState.theme) ?? "light")
          : state.themeState.appearanceMode;
      write({ appearanceMode });
      return true;
    },
    [state.themeState, write],
  );

  return {
    ...state.themeState,
    setAppearanceMode,
    setFollowSystem,
    setTheme,
    setThemeHalf,
  } as const;
}

export function syncedThemePatchForHalf(
  appearance: "light" | "dark",
  themeId: string,
): SyncedClientPreferencesPatch {
  return appearance === "light" ? { lightThemeId: themeId } : { darkThemeId: themeId };
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
  const synced = useSyncedClientPreferencesState(environmentId);
  return useMergedSettings(
    serverSettings ?? DEFAULT_SERVER_SETTINGS,
    synced.preferences,
    synced.canPatch,
    synced.pendingWrite,
    selector,
  );
}

/** Primary-only settings access for the settings UI and other explicitly global surfaces. */
export function usePrimarySettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const synced = useSyncedClientPreferencesState(environmentId);
  return useMergedSettings(
    useAtomValue(primaryServerSettingsAtom),
    synced.preferences,
    synced.canPatch,
    synced.pendingWrite,
    selector,
  );
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
  const synced = useEnvironmentSyncedClientPreferences(environmentId);
  const canPatchSyncedPreferences = useCanPatchSyncedClientPreferences(environmentId);
  const patchSyncedClientPreferences = useAtomCommand(
    serverEnvironment.patchSyncedClientPreferences,
    {
      label: "synced client preferences update",
      reportFailure: false,
    },
  );
  const updateSettings = useCallback(
    (patch: UnifiedSettingsPatch) => {
      const { serverPatch, clientPatch } = splitPatch(patch);

      if (Object.keys(serverPatch).length > 0) {
        if (environmentId) {
          void persistServerSettings({
            environmentId,
            input: { patch: serverPatch },
          });
        }
      }
      const clientPatchWithoutPlanMode = Struct.omit(clientPatch, ["planModeEnabled"]);
      if (Struct.keys(clientPatchWithoutPlanMode).length > 0) {
        persistClientSettings({
          ...getClientSettingsSnapshot(),
          ...clientPatchWithoutPlanMode,
        });
      }
      if (clientPatch.planModeEnabled !== undefined) {
        syncedPlanModeHydrationController.write({
          environmentId,
          value: clientPatch.planModeEnabled,
          serverPreferences: synced.preferences,
          canPatch: canPatchSyncedPreferences,
          now: new Date().toISOString(),
          patch: patchSyncedClientPreferences,
          persist: (value, updatedAt) => {
            const snapshot = getClientSettingsSnapshot();
            if (snapshot.planModeEnabled === value && snapshot.planModeUpdatedAt === updatedAt) {
              return;
            }
            persistClientSettings({
              ...snapshot,
              planModeEnabled: value,
              planModeUpdatedAt: updatedAt,
            });
          },
        });
      }
    },
    [
      canPatchSyncedPreferences,
      environmentId,
      patchSyncedClientPreferences,
      persistServerSettings,
      synced.preferences,
    ],
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
  return useCallback((patch: ClientSettingsPatch) => {
    persistClientSettings({
      ...getClientSettingsSnapshot(),
      ...patch,
    });
  }, []);
}

export function __resetClientSettingsPersistenceForTests(): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  clientSettingsHydrated = false;
  clientSettingsHydrationPromise = null;
  clientSettingsPersistenceQueue = Promise.resolve();
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
  syncedPlanModeHydrationController.reset();
  syncedAppearanceModeHydrationController.reset();
  syncedLightThemeIdHydrationController.reset();
  syncedDarkThemeIdHydrationController.reset();
}

export function __setClientSettingsForTests(settings: ClientSettings): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = settings;
  clientSettingsHydrated = true;
  clientSettingsHydrationPromise = null;
}
