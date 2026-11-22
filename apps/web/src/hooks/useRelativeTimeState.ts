import { useMessages } from "gt-react";
import { useSyncExternalStore } from "react";

import {
  formatRelativeElapsed,
  msUntilRelativeTimeChange,
  relativeElapsedLabel,
  relativeTimeElapsedMs,
  type RelativeTimeState,
} from "../timestampFormat";

/** Elapsed time floored to the label's unit, re-read when the label would change. */
function useRelativeElapsedMs(isoDate: string | null): number | null {
  const subscribe = (onChange: () => void) => {
    if (isoDate === null) return () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delayMs = msUntilRelativeTimeChange(isoDate);
      if (delayMs === null) return;
      timer = setTimeout(() => {
        onChange();
        schedule();
      }, delayMs);
    };
    schedule();
    return () => clearTimeout(timer);
  };
  const getSnapshot = () => (isoDate === null ? null : relativeTimeElapsedMs(isoDate));
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useRelativeTimeState(isoDate: string | null): RelativeTimeState {
  const resolve = useMessages();
  const elapsedMs = useRelativeElapsedMs(isoDate);
  if (isoDate === null) return { status: "missing" };
  if (elapsedMs === null) return { status: "invalid" };
  return { status: "relative", ...formatRelativeElapsed(elapsedMs, resolve) };
}

/** The whole phrase ("5m ago") alone, resolving one message instead of the split parts too. */
export function useRelativeTimeLabel(isoDate: string): string | null {
  const resolve = useMessages();
  const elapsedMs = useRelativeElapsedMs(isoDate);
  return elapsedMs === null ? null : relativeElapsedLabel(elapsedMs, resolve);
}
