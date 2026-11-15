import { requireOptionalNativeModule } from "expo";
import { useEffect, useEffectEvent } from "react";

import { whenRootNavigationReady } from "../../lib/rootNavigation";

const AppIntents = requireOptionalNativeModule<{
  takePendingDictation(): boolean;
  addListener(event: "onStartDictation", listener: () => void): { remove(): void };
}>("T3AppIntents");

export function useStartDictationIntent(onStartDictation: () => void): void {
  const handlePending = useEffectEvent(() => {
    if (AppIntents?.takePendingDictation()) onStartDictation();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drains a Start Dictation shortcut delivered natively before JS mounted, then listens for the next one
  useEffect(() => {
    if (!AppIntents) return;
    let mounted = true;
    const drain = () =>
      whenRootNavigationReady(() => {
        if (mounted) handlePending();
      });
    const subscription = AppIntents.addListener("onStartDictation", drain);
    drain();
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
}
