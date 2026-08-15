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
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_SERVER_SETTINGS,
  nextSyncedClientPreferencesUpdatedAt,
  type EnvironmentId,
  type PatchSyncedClientPreferencesRequest,
  ServerSettings,
  type ServerSettingsPatch,
  type SyncedClientPreferences,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
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
  getThemeDefinition,
  getThemePreviewSidebarArtwork,
  resolveThemeHalf,
  subscribeToThemePreview,
  themeAllowsSidebarArtwork,
} from "~/themePalette";
import * as Struct from "effect/Struct";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";
import { usePrimaryEnvironment } from "~/state/environments";
import { environmentSession } from "~/state/session";
import { environmentShell } from "~/state/shell";
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
const SHELL_NOT_LIVE = Symbol("shell-not-live");
const EMPTY_SYNCED_CLIENT_PREFERENCES_ATOM = Atom.make(SHELL_NOT_LIVE);
const EMPTY_AUTH_SESSION_ATOM = Atom.make(null);

export function createSyncedClientPreferencesSliceAtom(
  shellStateAtom: Atom.Atom<EnvironmentShellState>,
) {
  return Atom.make((get): SyncedClientPreferences | undefined | typeof SHELL_NOT_LIVE => {
    const shell = get(shellStateAtom);
    if (shell.status !== "live") return SHELL_NOT_LIVE;
    return Option.getOrNull(shell.snapshot)?.syncedClientPreferences;
  });
}

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
): UnifiedSettings {
  return {
    ...serverSettings,
    ...clientSettings,
    ...(!syncedPlanModeCanOverrideClient || syncedClientPreferences?.planModeEnabled === undefined
      ? {}
      : { planModeEnabled: syncedClientPreferences.planModeEnabled }),
  };
}

function useMergedSettings<T>(
  serverSettings: ServerSettings,
  syncedClientPreferences: SyncedClientPreferences | undefined,
  syncedPlanModeCanOverrideClient: boolean,
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
      ),
    [clientSettings, serverSettings, syncedClientPreferences, syncedPlanModeCanOverrideClient],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

export function createSyncedPlanModeWrite(input: {
  readonly value: boolean;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly pendingUpdatedAt?: string;
  readonly now: string;
}) {
  const serverUpdatedAt = input.serverPreferences?.updatedAt;
  const currentUpdatedAt =
    input.pendingUpdatedAt !== undefined &&
    (serverUpdatedAt === undefined || input.pendingUpdatedAt > serverUpdatedAt)
      ? input.pendingUpdatedAt
      : serverUpdatedAt;
  return {
    clientPatch: { planModeEnabled: input.value },
    request: {
      patch: { planModeEnabled: input.value },
      updatedAt: nextSyncedClientPreferencesUpdatedAt([currentUpdatedAt], input.now),
    },
  } as const;
}

type SyncedPlanModePatchTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: PatchSyncedClientPreferencesRequest;
};

type SyncedPlanModePatch<E> = (
  target: SyncedPlanModePatchTarget,
) => Promise<AtomCommandResult<SyncedClientPreferences, E>>;

export interface SyncedPlanModeHydrationInput<E> {
  readonly environmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly clientHydrated: boolean;
  readonly clientValue: boolean;
  readonly live: boolean;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly canPatch: boolean;
  readonly now: string;
  readonly patch: SyncedPlanModePatch<E>;
  readonly persist: (value: boolean) => void;
}

export type SyncedPlanModeHydrationAction =
  | { readonly type: "none" }
  | { readonly type: "adopt"; readonly value: boolean; readonly updatedAt: string }
  | { readonly type: "seed"; readonly value: boolean; readonly updatedAt: string };

export function resolveSyncedPlanModeHydrationAction(input: {
  readonly clientHydrated: boolean;
  readonly clientValue: boolean;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly seedPending: boolean;
  readonly writePending?: { readonly value: boolean; readonly updatedAt: string };
  readonly adoptedUpdatedAt?: string;
  readonly now: string;
}): SyncedPlanModeHydrationAction {
  if (!input.clientHydrated) return { type: "none" };
  if (
    input.writePending !== undefined &&
    (input.serverPreferences === undefined ||
      input.serverPreferences.updatedAt < input.writePending.updatedAt)
  ) {
    return { type: "none" };
  }
  if (input.serverPreferences?.planModeEnabled !== undefined) {
    return input.adoptedUpdatedAt !== undefined &&
      input.serverPreferences.updatedAt <= input.adoptedUpdatedAt
      ? { type: "none" }
      : {
          type: "adopt",
          value: input.serverPreferences.planModeEnabled,
          updatedAt: input.serverPreferences.updatedAt,
        };
  }
  if (input.seedPending) return { type: "none" };
  return {
    type: "seed",
    value: input.clientValue,
    updatedAt: nextSyncedClientPreferencesUpdatedAt(
      [input.serverPreferences?.updatedAt],
      input.now,
    ),
  };
}

const SYNCED_PLAN_MODE_RETRY_DELAY_MS = 1_000;

type SyncedPlanModeRetryScheduler = (retry: () => void) => () => void;

const scheduleSyncedPlanModeRetry: SyncedPlanModeRetryScheduler = (retry) => {
  const timer = setTimeout(retry, SYNCED_PLAN_MODE_RETRY_DELAY_MS);
  return () => clearTimeout(timer);
};

export function createSyncedPlanModeHydrationController(
  scheduleRetry: SyncedPlanModeRetryScheduler = scheduleSyncedPlanModeRetry,
) {
  interface SyncedPlanModeEnvironmentState {
    adoptedUpdatedAt?: string;
    seedPendingUpdatedAt?: string;
    writePending?: { readonly value: boolean; readonly updatedAt: string };
    writeInFlightUpdatedAt?: string;
    readonly synchronizeAgainByOwner: Map<symbol, () => void>;
    cancelRetry?: () => void;
  }

  const imperativeSynchronizationOwner = Symbol();
  const stateByEnvironment = new Map<EnvironmentId, SyncedPlanModeEnvironmentState>();
  const stateFor = (environmentId: EnvironmentId) => {
    const current = stateByEnvironment.get(environmentId);
    if (current !== undefined) return current;
    const state: SyncedPlanModeEnvironmentState = { synchronizeAgainByOwner: new Map() };
    stateByEnvironment.set(environmentId, state);
    return state;
  };
  const cancelRetry = (state: SyncedPlanModeEnvironmentState) => {
    state.cancelRetry?.();
    delete state.cancelRetry;
  };
  const deactivate = (environmentId: EnvironmentId, owner: symbol) => {
    const state = stateByEnvironment.get(environmentId);
    if (state === undefined) return;
    state.synchronizeAgainByOwner.delete(owner);
    if (state.synchronizeAgainByOwner.size > 0) return;
    cancelRetry(state);
  };
  const getSynchronizeAgain = (state: SyncedPlanModeEnvironmentState) => {
    let latest: (() => void) | undefined;
    for (const synchronizeAgain of state.synchronizeAgainByOwner.values()) {
      latest = synchronizeAgain;
    }
    return latest;
  };
  const requestRetry = (state: SyncedPlanModeEnvironmentState) => {
    if (state.cancelRetry !== undefined || getSynchronizeAgain(state) === undefined) return;
    state.cancelRetry = scheduleRetry(() => {
      delete state.cancelRetry;
      getSynchronizeAgain(state)?.();
    });
  };
  const markAdopted = (state: SyncedPlanModeEnvironmentState, updatedAt: string) => {
    if (state.adoptedUpdatedAt === undefined || updatedAt > state.adoptedUpdatedAt) {
      state.adoptedUpdatedAt = updatedAt;
    }
  };

  const settlePatch = <E>(input: {
    readonly environmentId: EnvironmentId;
    readonly requestedUpdatedAt: string;
    readonly result: AtomCommandResult<SyncedClientPreferences, E>;
    readonly persist: (value: boolean) => void;
  }) => {
    const state = stateByEnvironment.get(input.environmentId);
    if (state === undefined) return;
    if (state.writeInFlightUpdatedAt === input.requestedUpdatedAt) {
      delete state.writeInFlightUpdatedAt;
    }
    if (input.result._tag === "Failure") {
      if (state.seedPendingUpdatedAt === input.requestedUpdatedAt) {
        delete state.seedPendingUpdatedAt;
      }
      requestRetry(state);
      return;
    }

    const pendingWrite = state.writePending;
    const matchingWrite = pendingWrite?.updatedAt === input.requestedUpdatedAt;
    const seedMatchesRequest = state.seedPendingUpdatedAt === input.requestedUpdatedAt;
    const matchingSeed =
      seedMatchesRequest &&
      (pendingWrite === undefined || pendingWrite.updatedAt <= input.requestedUpdatedAt);
    if (seedMatchesRequest) delete state.seedPendingUpdatedAt;
    if (!matchingWrite && !matchingSeed) return;

    cancelRetry(state);
    if (matchingWrite) delete state.writePending;
    markAdopted(state, input.result.value.updatedAt);
    if (getSynchronizeAgain(state) === undefined) return;
    if (input.result.value.planModeEnabled !== undefined) {
      input.persist(input.result.value.planModeEnabled);
    }
  };

  const dispatchPatch = <E>(input: {
    readonly target: SyncedPlanModePatchTarget;
    readonly patch: SyncedPlanModePatch<E>;
    readonly persist: (value: boolean) => void;
  }) => {
    const { environmentId } = input.target;
    const requestedUpdatedAt = input.target.input.updatedAt;
    stateFor(environmentId).writeInFlightUpdatedAt = requestedUpdatedAt;
    void input.patch(input.target).then((result) => {
      settlePatch({ environmentId, requestedUpdatedAt, result, persist: input.persist });
    });
  };

  const synchronize = <E>(
    input: SyncedPlanModeHydrationInput<E>,
    owner = imperativeSynchronizationOwner,
  ) => {
    const environmentId = input.environmentId;
    if (environmentId === null) return;
    if (environmentId !== input.primaryEnvironmentId || !input.live) {
      deactivate(environmentId, owner);
      return;
    }
    const state = stateFor(environmentId);
    state.synchronizeAgainByOwner.set(owner, () => synchronize(input, owner));
    const deactivateSynchronization = () => deactivate(environmentId, owner);
    if (input.serverPreferences?.planModeEnabled !== undefined) {
      delete state.seedPendingUpdatedAt;
    }
    const pendingWrite = state.writePending;
    if (
      pendingWrite !== undefined &&
      input.serverPreferences !== undefined &&
      input.serverPreferences.updatedAt >= pendingWrite.updatedAt
    ) {
      delete state.writePending;
      delete state.writeInFlightUpdatedAt;
      cancelRetry(state);
    }
    const activePendingWrite = state.writePending;
    if (
      input.canPatch &&
      activePendingWrite !== undefined &&
      (input.serverPreferences === undefined ||
        input.serverPreferences.updatedAt < activePendingWrite.updatedAt) &&
      state.writeInFlightUpdatedAt !== activePendingWrite.updatedAt
    ) {
      dispatchPatch<E>({
        target: {
          environmentId,
          input: {
            patch: { planModeEnabled: activePendingWrite.value },
            updatedAt: activePendingWrite.updatedAt,
          },
        },
        patch: input.patch,
        persist: input.persist,
      });
    }

    const action = resolveSyncedPlanModeHydrationAction({
      clientHydrated: input.clientHydrated,
      clientValue: input.clientValue,
      serverPreferences: input.serverPreferences,
      seedPending: state.seedPendingUpdatedAt !== undefined,
      ...(activePendingWrite === undefined ? {} : { writePending: activePendingWrite }),
      ...(state.adoptedUpdatedAt === undefined ? {} : { adoptedUpdatedAt: state.adoptedUpdatedAt }),
      now: input.now,
    });
    if (action.type === "adopt") {
      if (!input.canPatch) return deactivateSynchronization;
      markAdopted(state, action.updatedAt);
      if (input.clientValue !== action.value) input.persist(action.value);
      return deactivateSynchronization;
    }
    if (action.type !== "seed" || !input.canPatch) return deactivateSynchronization;

    state.seedPendingUpdatedAt = action.updatedAt;
    dispatchPatch<E>({
      target: {
        environmentId,
        input: {
          patch: { planModeEnabled: action.value },
          updatedAt: action.updatedAt,
        },
      },
      patch: input.patch,
      persist: input.persist,
    });

    return deactivateSynchronization;
  };

  const write = <E>(input: {
    readonly environmentId: EnvironmentId | null;
    readonly value: boolean;
    readonly serverPreferences: SyncedClientPreferences | undefined;
    readonly canPatch: boolean;
    readonly now: string;
    readonly patch: SyncedPlanModePatch<E>;
    readonly persist: (value: boolean) => void;
  }) => {
    if (input.environmentId === null) return;
    const environmentId = input.environmentId;
    const state = stateFor(environmentId);
    const controllerUpdatedAt = [
      state.adoptedUpdatedAt,
      state.seedPendingUpdatedAt,
      state.writePending?.updatedAt,
      state.writeInFlightUpdatedAt,
    ].reduce<string | undefined>(
      (latest, candidate) =>
        candidate !== undefined && (latest === undefined || candidate > latest)
          ? candidate
          : latest,
      undefined,
    );
    const next = createSyncedPlanModeWrite({
      value: input.value,
      serverPreferences: input.serverPreferences,
      ...(controllerUpdatedAt === undefined ? {} : { pendingUpdatedAt: controllerUpdatedAt }),
      now: input.now,
    });
    state.writePending = {
      value: input.value,
      updatedAt: next.request.updatedAt,
    };
    if (!input.canPatch) return;
    dispatchPatch<E>({
      target: { environmentId, input: next.request },
      patch: input.patch,
      persist: input.persist,
    });
  };

  return {
    synchronize,
    write,
    reset() {
      for (const state of stateByEnvironment.values()) {
        cancelRetry(state);
        state.synchronizeAgainByOwner.clear();
      }
      stateByEnvironment.clear();
    },
  };
}

const syncedPlanModeHydrationController = createSyncedPlanModeHydrationController();

export function useSyncedPlanModeHydrationEffect<E>(
  controller: ReturnType<typeof createSyncedPlanModeHydrationController>,
  input: SyncedPlanModeHydrationInput<E>,
): void {
  const synchronizationOwner = useMemo(() => Symbol(), [controller]);
  useEffect(
    () => controller.synchronize(input, synchronizationOwner),
    [
      controller,
      input.canPatch,
      input.clientHydrated,
      input.clientValue,
      input.environmentId,
      input.live,
      input.patch,
      input.persist,
      input.primaryEnvironmentId,
      input.serverPreferences,
      synchronizationOwner,
    ],
  );
}

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

function useSyncedPlanModeHydration(environmentId: EnvironmentId | null) {
  const clientSettings = useClientSettingsValue();
  const clientHydrated = useClientSettingsHydrated();
  const primaryEnvironmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const synced = useEnvironmentSyncedClientPreferences(environmentId);
  const canPatch = useCanPatchSyncedClientPreferences(environmentId);
  const patchPreferences = useAtomCommand(serverEnvironment.patchSyncedClientPreferences, {
    label: "synced client preferences seed",
    reportFailure: false,
  });
  const persistSyncedPlanMode = useCallback((value: boolean) => {
    if (getClientSettingsSnapshot().planModeEnabled !== value) {
      persistClientSettings({ ...getClientSettingsSnapshot(), planModeEnabled: value });
    }
  }, []);

  useSyncedPlanModeHydrationEffect(syncedPlanModeHydrationController, {
    environmentId,
    primaryEnvironmentId,
    clientHydrated,
    clientValue: clientSettings.planModeEnabled,
    live: synced.live,
    serverPreferences: synced.preferences,
    canPatch,
    now: new Date().toISOString(),
    patch: patchPreferences,
    persist: persistSyncedPlanMode,
  });

  return { ...synced, canPatch } as const;
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
  const synced = useSyncedPlanModeHydration(environmentId);
  return useMergedSettings(
    serverSettings ?? DEFAULT_SERVER_SETTINGS,
    synced.preferences,
    synced.canPatch,
    selector,
  );
}

/** Primary-only settings access for the settings UI and other explicitly global surfaces. */
export function usePrimarySettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const synced = useSyncedPlanModeHydration(environmentId);
  return useMergedSettings(
    useAtomValue(primaryServerSettingsAtom),
    synced.preferences,
    synced.canPatch,
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
  const syncedEnvironmentId = environmentId;
  const synced = useEnvironmentSyncedClientPreferences(syncedEnvironmentId);
  const canPatchSyncedPreferences = useCanPatchSyncedClientPreferences(syncedEnvironmentId);
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
      if (Object.keys(clientPatch).length > 0) {
        persistClientSettings({
          ...getClientSettingsSnapshot(),
          ...clientPatch,
        });
      }
      if (clientPatch.planModeEnabled !== undefined) {
        syncedPlanModeHydrationController.write({
          environmentId: syncedEnvironmentId,
          value: clientPatch.planModeEnabled,
          serverPreferences: synced.preferences,
          canPatch: canPatchSyncedPreferences,
          now: new Date().toISOString(),
          patch: patchSyncedClientPreferences,
          persist: (value) => {
            if (getClientSettingsSnapshot().planModeEnabled !== value) {
              persistClientSettings({ ...getClientSettingsSnapshot(), planModeEnabled: value });
            }
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
      syncedEnvironmentId,
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
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
  syncedPlanModeHydrationController.reset();
}

export function __setClientSettingsForTests(settings: ClientSettings): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = settings;
  clientSettingsHydrated = true;
  clientSettingsHydrationPromise = null;
}
