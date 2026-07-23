import {
  continueComposerPreferencesHydrationInBackground,
  flushComposerPreferencesPersistence,
  hydrateComposerPreferences,
} from "./composerDraftStore";
import {
  continueClientSettingsHydrationInBackground,
  flushClientSettingsPersistence,
  hydrateClientSettings,
} from "./hooks/useSettings";
import {
  continueUiStatePersistenceHydrationInBackground,
  flushUiStatePersistence,
  hydrateUiStateStore,
} from "./uiStateStore";

export const CLIENT_PERSISTENCE_HYDRATION_TIMEOUT_MS = 3_000;
let disposeRendererStateFlushHandler: (() => void) | null = null;

export async function flushClientRendererPersistence(): Promise<void> {
  await Promise.all([
    flushClientSettingsPersistence(),
    flushUiStatePersistence(),
    flushComposerPreferencesPersistence(),
  ]);
}

export function installRendererStateFlushHandler(): void {
  if (
    disposeRendererStateFlushHandler !== null ||
    typeof window === "undefined" ||
    !window.desktopBridge?.onRendererStateFlush
  ) {
    return;
  }
  disposeRendererStateFlushHandler = window.desktopBridge.onRendererStateFlush(
    flushClientRendererPersistence,
  );
}

export async function waitForClientPersistenceHydration(
  hydrations: ReadonlyArray<Promise<unknown>>,
  timeoutMs = CLIENT_PERSISTENCE_HYDRATION_TIMEOUT_MS,
): Promise<"hydrated" | "timed-out"> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed-out">((resolve) => {
    timeoutId = setTimeout(() => resolve("timed-out"), timeoutMs);
  });
  const hydrated = Promise.allSettled(hydrations).then(() => "hydrated" as const);
  const result = await Promise.race([hydrated, timeout]);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }
  return result;
}

export async function hydrateClientPersistence(): Promise<void> {
  installRendererStateFlushHandler();
  const result = await waitForClientPersistenceHydration([
    hydrateClientSettings(),
    hydrateUiStateStore(),
    hydrateComposerPreferences(),
  ]);
  if (result === "timed-out") {
    continueClientSettingsHydrationInBackground();
    continueUiStatePersistenceHydrationInBackground();
    continueComposerPreferencesHydrationInBackground();
    console.error(
      `[CLIENT_PERSISTENCE] Initial hydration exceeded ${CLIENT_PERSISTENCE_HYDRATION_TIMEOUT_MS}ms; stale reads were cancelled and durable renderer writes remain guarded while hydration retries in the background.`,
    );
  }
}

export function __resetClientPersistenceBootstrapForTests(): void {
  disposeRendererStateFlushHandler?.();
  disposeRendererStateFlushHandler = null;
}
