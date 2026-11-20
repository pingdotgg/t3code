import { useSyncExternalStore } from "react";

import { CopyButton } from "./CopyButton";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const FULL_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

const NO_UNSUBSCRIBE = () => undefined;
const subscribeToClock = (onTick: () => void) => {
  const timer = setInterval(onTick, 1_000);
  return () => clearInterval(timer);
};
const clockSecond = () => Math.floor(Date.now() / 1_000) * 1_000;

/** Seconds since `since`, ticking once a second while a turn runs. */
function useElapsedSeconds(since: number | null): number | null {
  const now = useSyncExternalStore(
    since === null ? () => NO_UNSUBSCRIBE : subscribeToClock,
    clockSecond,
  );
  return since === null ? null : Math.max(0, Math.floor((now - since) / 1_000));
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Under a message: its copy button, the time the thread recorded it, and, while its turn runs, how
 * long the turn has gone. The copy button and the time appear on hover or focus.
 */
export function MessageActions({
  text,
  at,
  runningSince,
}: {
  text: string;
  at: number | null;
  /** When the running turn began. Null for a message whose turn is over. */
  runningSince: number | null;
}) {
  const elapsed = useElapsedSeconds(runningSince);
  if (text === "" && at === null && elapsed === null) return null;
  return (
    <div className="flex h-6 items-center gap-1.5 text-[11px] text-faint">
      <span className="flex items-center gap-1.5 opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100">
        {text !== "" && <CopyButton read={() => text} label="Copy message" />}
        {at !== null && (
          <time dateTime={new Date(at).toISOString()} aria-label={FULL_TIME.format(at)}>
            {TIME.format(at)}
          </time>
        )}
      </span>
      {elapsed !== null && (
        <span role="timer" aria-label="Turn elapsed time" className="tabular-nums">
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  );
}
