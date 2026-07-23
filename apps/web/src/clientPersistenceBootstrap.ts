import { hydrateComposerPreferences } from "./composerDraftStore";
import { hydrateClientSettings } from "./hooks/useSettings";
import { hydrateUiStateStore } from "./uiStateStore";

export const CLIENT_PERSISTENCE_HYDRATION_TIMEOUT_MS = 3_000;

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
  const result = await waitForClientPersistenceHydration([
    hydrateClientSettings(),
    hydrateUiStateStore(),
    hydrateComposerPreferences(),
  ]);
  if (result === "timed-out") {
    console.error(
      `[CLIENT_PERSISTENCE] Initial hydration exceeded ${CLIENT_PERSISTENCE_HYDRATION_TIMEOUT_MS}ms; rendering with durable renderer writes guarded.`,
    );
  }
}
