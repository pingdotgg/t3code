import { AppState } from "react-native";

import { flushComposerDrafts } from "./use-composer-drafts";

/**
 * Typing persists on a debounce. Opening the app switcher is the last chance
 * to commit that write before a swipe-away kills the process.
 */
export function installComposerDraftForegroundFlush(): () => void {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") return;
    void flushComposerDrafts().catch((error: unknown) => {
      console.warn("[composer-drafts] failed to persist drafts", error);
    });
  });
  return () => subscription.remove();
}
