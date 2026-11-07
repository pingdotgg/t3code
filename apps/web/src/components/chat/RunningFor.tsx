import { tickTextContent } from "~/lib/tickTextContent";
import { formatRunningFor } from "@t3tools/client-runtime/work-log/presentation";

/** " for 1m 5s" after a running command's label, ticking without re-rendering the row. */
export function RunningFor({ startedAt }: { startedAt: string }) {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;
  return (
    <span
      className="text-muted-foreground tabular-nums"
      ref={tickTextContent((nowMs) => ` ${formatRunningFor(nowMs - startMs)}`, true)}
    />
  );
}
