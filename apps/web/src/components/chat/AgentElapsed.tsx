import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import { msg, useMessages } from "gt-react";
import type { MessageResolver } from "~/i18n/messages";
import { tickTextContent } from "~/lib/tickTextContent";

function formatElapsedSeconds(totalSeconds: number, resolve: MessageResolver): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return resolve(msg("{seconds}s", { seconds, $context: "elapsed time, seconds" }));
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return resolve(
      msg("{minutes}m {seconds}s", {
        minutes,
        seconds: String(seconds % 60).padStart(2, "0"),
        $context: "elapsed time, minutes and seconds",
      }),
    );
  }
  return resolve(
    msg("{hours}h {minutes}m", {
      hours,
      minutes: String(minutes % 60).padStart(2, "0"),
      $context: "elapsed time, hours and minutes",
    }),
  );
}

function formatCompactElapsedSeconds(totalSeconds: number, resolve: MessageResolver): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60)
    return resolve(msg("{seconds}s", { seconds, $context: "elapsed time, seconds" }));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return resolve(msg("{minutes}m", { minutes, $context: "elapsed time, minutes" }));
  if (minutes >= 600) {
    return resolve(
      msg("{hours}h", { hours: Math.floor(minutes / 60), $context: "elapsed time, hours" }),
    );
  }
  return resolve(
    msg("{hours}h", { hours: Math.floor(minutes / 6) / 10, $context: "elapsed time, hours" }),
  );
}

export function AgentElapsed({
  agent,
  compact = false,
}: {
  agent: Pick<RuntimeSubagent, "status" | "startedAt" | "completedAt">;
  compact?: boolean;
}) {
  const m = useMessages();
  const format = compact ? formatCompactElapsedSeconds : formatElapsedSeconds;
  const live = isOrchestrationV2WorkActive(agent.status);
  const { status, startedAt, completedAt } = agent;
  if (deriveSubagentElapsedMs(agent, 0) === null) {
    return null;
  }
  return (
    <span
      ref={tickTextContent((nowMs) => {
        const elapsedMs = deriveSubagentElapsedMs({ status, startedAt, completedAt }, nowMs);
        return elapsedMs === null ? "" : format(elapsedMs / 1000, m);
      }, live)}
      className="tabular-nums"
    />
  );
}
