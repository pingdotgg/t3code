import { minuteTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};
const noSnapshot = () => "";

export function useNowMinute(enabled = true): string {
  return useSyncExternalStore(
    enabled ? minuteTick.subscribe : noSubscribe,
    enabled ? minuteTick.getSnapshot : noSnapshot,
    enabled ? minuteTick.getSnapshot : noSnapshot,
  );
}
