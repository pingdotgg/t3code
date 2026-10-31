import { useIsFocused } from "@react-navigation/native";
import { secondTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

import { useAppActive } from "../../lib/appState";

const subscribeNever = () => () => undefined;

/**
 * Retained routes stay mounted when hidden, so an ungated tick would keep
 * re-rendering them. Every visible label shares one module-level tick.
 */
export function useVisibleSecondClock(enabled: boolean): number {
  const focused = useIsFocused();
  const appActive = useAppActive();
  const ticking = enabled && focused && appActive;
  // While paused the snapshot still reads the shared tick, so resuming shows
  // the current second rather than the one the clock stopped on.
  return useSyncExternalStore(
    ticking ? secondTick.subscribe : subscribeNever,
    secondTick.getSnapshot,
    secondTick.getSnapshot,
  );
}
