import { secondTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

const idleSubscribe = () => () => {};

/** Epoch ms floored to the second. Pass `false` to read once without ticking. */
export function useNowSecond(enabled = true): number {
  return useSyncExternalStore(
    enabled ? secondTick.subscribe : idleSubscribe,
    secondTick.getSnapshot,
    secondTick.getSnapshot,
  );
}
