import { AppState } from "react-native";

import { flushThreadOutbox } from "./thread-outbox";
import { flushComposerDrafts } from "./use-composer-drafts";

export function installComposerDraftsForegroundFlush(): () => void {
  // "inactive" is the iOS app switcher, where users kill the app before it ever backgrounds.
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") return;
    // A send clears its draft before the outbox write lands, so this flush must not save the clear first.
    flushThreadOutbox()
      .then(flushComposerDrafts)
      .catch((error: unknown) => {
        console.warn("[composer-drafts] failed to flush drafts on leaving the foreground", error);
      });
  });
  return () => subscription.remove();
}
