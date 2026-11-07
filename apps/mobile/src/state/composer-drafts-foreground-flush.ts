import { AppState } from "react-native";

import { flushComposerDrafts } from "./use-composer-drafts";

export function installComposerDraftsForegroundFlush(): () => void {
  // "inactive" is the iOS app switcher, where users kill the app before it ever backgrounds.
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") return;
    flushComposerDrafts().catch((error) => {
      console.warn("[composer-drafts] failed to flush drafts on leaving the foreground", error);
    });
  });
  return () => subscription.remove();
}
