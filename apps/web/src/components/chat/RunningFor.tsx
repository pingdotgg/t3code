import { tickTextContent } from "~/lib/tickTextContent";
import { formatRunningFor } from "@t3tools/client-runtime/work-log/presentation";
import { toServerClock } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";
import { m } from "~/i18n/messages";

/** " for 1m 5s" after a running command's label, ticking without re-rendering the row. */
export function RunningFor({
  startedAt,
  environmentId,
}: {
  startedAt: string;
  environmentId: EnvironmentId;
}) {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;
  return (
    <span
      className="text-muted-foreground tabular-nums"
      ref={tickTextContent(
        (nowMs) => ` ${formatRunningFor(toServerClock(environmentId, nowMs) - startMs, m)}`,
        true,
      )}
    />
  );
}
