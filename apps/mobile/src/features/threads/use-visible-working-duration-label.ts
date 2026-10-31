import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { secondTick } from "@t3tools/client-runtime/clock";
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useSyncExternalStore } from "react";
import { useAppActive } from "../../lib/appState";

const subscribeNever = () => () => undefined;

export function useVisibleWorkingDurationLabel(startedAt: string | null): string | null {
  const startedAtMs = Date.parse(startedAt ?? "");
  const focused = useIsFocused();
  const appActive = useAppActive();
  const ticking = Number.isFinite(startedAtMs) && focused && appActive;
  const getSnapshot = useCallback(
    () =>
      Number.isFinite(startedAtMs)
        ? ` ${formatWorkingDurationLabel(secondTick.getSnapshot() - startedAtMs)}`
        : null,
    [startedAtMs],
  );
  return useSyncExternalStore(
    ticking ? secondTick.subscribe : subscribeNever,
    getSnapshot,
    getSnapshot,
  );
}
