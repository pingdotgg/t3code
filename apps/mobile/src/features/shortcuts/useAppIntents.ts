import { requireOptionalNativeModule } from "expo";
import { useEffect, useEffectEvent } from "react";

import { whenRootNavigationReady } from "../../lib/rootNavigation";

// iOS-only: Android has no Action button and uses the "New task" launcher shortcut instead.
const AppIntents = requireOptionalNativeModule<{
  takePendingIntent(): string | null;
  addListener(event: "onIntent", listener: () => void): { remove(): void };
}>("T3AppIntents");

export type NewTaskAppIntent = "newTask" | "voiceTask";

/** Runs when a new-task App Shortcut fires from the Action button, Siri, or Spotlight. */
export function useNewTaskAppIntent(onNewTask: (intent: NewTaskAppIntent) => void): void {
  const handlePendingIntent = useEffectEvent(() => {
    const intent = AppIntents?.takePendingIntent();
    if (intent === "newTask" || intent === "voiceTask") {
      onNewTask(intent);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Drains intents queued natively before JS mounted, then listens for new ones.
  useEffect(() => {
    if (!AppIntents) return;
    let mounted = true;
    const drain = () =>
      whenRootNavigationReady(() => {
        if (mounted) handlePendingIntent();
      });
    // Subscribe before the first drain so an intent delivered in between still fires an event.
    const subscription = AppIntents.addListener("onIntent", drain);
    drain();
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
}
