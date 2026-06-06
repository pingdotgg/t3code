import type { PluginUiApi, PluginUiBaseContext } from "@t3tools/plugin-api/ui";

import { VOICE_INPUT_COMMANDS, VOICE_INPUT_EVENTS } from "../shared/constants.ts";
import type {
  VoiceInputClientStateGetResult,
  VoiceInputDependenciesStatusResult,
  VoiceInputSettings,
  VoiceInputSettingsGetResult,
} from "../shared/schema.ts";

export interface VoiceInputClientState {
  readonly settings: VoiceInputSettings;
  readonly status: VoiceInputDependenciesStatusResult;
  readonly cachePath: string;
}

interface VoiceInputClientStateSnapshot {
  readonly data: VoiceInputClientState | null;
  readonly loading: boolean;
  readonly error: unknown;
}

interface UseVoiceInputClientStateOptions {
  readonly errorToastTitle?: string | null;
}

type VoiceInputClientContext = Pick<PluginUiBaseContext, "api" | "toast">;
type VoiceInputRetainToken = number;

const initialSnapshot: VoiceInputClientStateSnapshot = {
  data: null,
  loading: true,
  error: null,
};

let snapshot: VoiceInputClientStateSnapshot = initialSnapshot;
let activeApi: PluginUiApi | null = null;
let activeUnsubscribe: (() => void) | null = null;
let inFlightRefresh: Promise<void> | null = null;
let queuedRefresh = false;
let retainTokenSequence = 0;
let storeGeneration = 0;

const listeners = new Set<() => void>();
const activeRetainTokens = new Set<VoiceInputRetainToken>();

async function loadVoiceInputClientState(api: PluginUiApi): Promise<VoiceInputClientState> {
  const result = await api.invoke<VoiceInputClientStateGetResult>(
    VOICE_INPUT_COMMANDS.clientStateGet,
    {},
  );
  return {
    settings: result.settings,
    status: result.status,
    cachePath: result.cachePath,
  };
}

export function voiceInputCommandErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Plugin command failed.";
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function setSnapshot(next: VoiceInputClientStateSnapshot) {
  snapshot = next;
  emit();
}

function updateSnapshot(
  updater: (current: VoiceInputClientStateSnapshot) => VoiceInputClientStateSnapshot,
) {
  setSnapshot(updater(snapshot));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

function resetForApi(api: PluginUiApi) {
  activeUnsubscribe?.();
  storeGeneration += 1;
  const generation = storeGeneration;
  activeApi = api;
  activeUnsubscribe = api.subscribe(
    (event) => {
      if (event.type === VOICE_INPUT_EVENTS.changed) {
        void refreshVoiceInputApi({
          api,
          generation,
          toastTarget: null,
          errorToastTitle: null,
          showToast: false,
        });
      }
    },
    {
      onResubscribe: () => {
        void refreshVoiceInputApi({
          api,
          generation,
          toastTarget: null,
          errorToastTitle: null,
          showToast: false,
        });
      },
    },
  );
  activeRetainTokens.clear();
  inFlightRefresh = null;
  queuedRefresh = false;
  setSnapshot(initialSnapshot);
}

function releaseApi(api: PluginUiApi, token: VoiceInputRetainToken) {
  if (!activeRetainTokens.delete(token)) {
    return;
  }
  if (activeRetainTokens.size > 0 || activeApi !== api) {
    return;
  }
  activeUnsubscribe?.();
  storeGeneration += 1;
  activeApi = null;
  activeUnsubscribe = null;
  activeRetainTokens.clear();
  inFlightRefresh = null;
  queuedRefresh = false;
  setSnapshot(initialSnapshot);
}

async function refreshVoiceInputApi(input: {
  readonly api: PluginUiApi;
  readonly generation?: number;
  readonly toastTarget: VoiceInputClientContext["toast"] | null;
  readonly errorToastTitle: string | null;
  readonly showToast: boolean;
}): Promise<void> {
  const generation = input.generation ?? storeGeneration;
  if (activeApi !== input.api || generation !== storeGeneration) {
    return;
  }
  if (inFlightRefresh !== null) {
    queuedRefresh = true;
    return inFlightRefresh;
  }

  updateSnapshot((current) => ({ ...current, loading: true, error: null }));
  const refresh = loadVoiceInputClientState(input.api)
    .then((data) => {
      if (activeApi === input.api && generation === storeGeneration) {
        setSnapshot({ data, loading: false, error: null });
      }
    })
    .catch((error: unknown) => {
      if (activeApi !== input.api || generation !== storeGeneration) {
        return;
      }
      updateSnapshot((current) => ({ ...current, loading: false, error }));
      if (input.showToast && input.errorToastTitle !== null && input.toastTarget !== null) {
        input.toastTarget.error(input.errorToastTitle, voiceInputCommandErrorMessage(error));
      }
    })
    .finally(() => {
      if (inFlightRefresh === refresh) {
        inFlightRefresh = null;
      }
      if (activeApi === input.api && generation === storeGeneration && queuedRefresh) {
        queuedRefresh = false;
        void refreshVoiceInputApi({
          api: input.api,
          generation,
          toastTarget: null,
          errorToastTitle: null,
          showToast: false,
        });
      }
    });

  inFlightRefresh = refresh;
  return refresh;
}

function retainVoiceInputClientState(ctx: VoiceInputClientContext, errorToastTitle: string | null) {
  if (activeApi !== ctx.api) {
    resetForApi(ctx.api);
  }
  const wasInactive = activeRetainTokens.size === 0;
  retainTokenSequence += 1;
  const token = retainTokenSequence;
  activeRetainTokens.add(token);
  const needsInitialLoad =
    wasInactive || (snapshot.data === null && !snapshot.loading && inFlightRefresh === null);
  if (needsInitialLoad) {
    void refreshVoiceInputApi({
      api: ctx.api,
      generation: storeGeneration,
      toastTarget: ctx.toast,
      errorToastTitle,
      showToast: errorToastTitle !== null,
    });
  }
  return () => {
    releaseApi(ctx.api, token);
  };
}

function applyVoiceInputSettingsResult(result: VoiceInputSettingsGetResult) {
  updateSnapshot((current) =>
    current.data === null
      ? current
      : {
          ...current,
          data: {
            ...current.data,
            settings: result.settings,
            cachePath: result.cachePath,
          },
        },
  );
}

export function useVoiceInputClientState(
  ctx: Pick<PluginUiBaseContext, "api" | "react" | "toast">,
  options: UseVoiceInputClientStateOptions = {},
) {
  const React = ctx.react;
  const errorToastTitle = options.errorToastTitle ?? null;
  const clientContext = React.useMemo(
    () => ({ api: ctx.api, toast: ctx.toast }),
    [ctx.api, ctx.toast],
  );
  const currentSnapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  React.useEffect(
    () => retainVoiceInputClientState(clientContext, errorToastTitle),
    [clientContext, errorToastTitle],
  );

  const refresh = React.useCallback(
    (input: { readonly toast: boolean } = { toast: false }) =>
      refreshVoiceInputApi({
        api: clientContext.api,
        generation: storeGeneration,
        toastTarget: clientContext.toast,
        errorToastTitle,
        showToast: input.toast,
      }),
    [clientContext, errorToastTitle],
  );

  const refreshWithToast = React.useCallback(() => refresh({ toast: true }), [refresh]);

  const applySettingsResult = React.useCallback((result: VoiceInputSettingsGetResult) => {
    applyVoiceInputSettingsResult(result);
  }, []);

  return {
    settings: currentSnapshot.data?.settings ?? null,
    status: currentSnapshot.data?.status ?? null,
    cachePath: currentSnapshot.data?.cachePath ?? "",
    loading: currentSnapshot.loading,
    error: currentSnapshot.error,
    refresh,
    refreshWithToast,
    applySettingsResult,
  };
}
