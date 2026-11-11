import { secondTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

const subscribeNever = (): (() => void) => () => {};

/** Wall-clock second. Pass `false` to read once without subscribing (idle Insights). */
export function useNowSecond(active = true): number {
  return useSyncExternalStore(
    active ? secondTick.subscribe : subscribeNever,
    secondTick.getSnapshot,
    secondTick.getSnapshot,
  );
}
