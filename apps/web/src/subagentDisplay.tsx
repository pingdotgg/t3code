import { useEffect, useRef } from "react";

import { formatElapsed } from "./session-logic";
import type { ThreadShell } from "./types";

export type SubagentThreadStatus = Extract<
  NonNullable<ThreadShell["parentRelation"]>,
  { kind: "subagent" }
>["status"];

export function subagentStatusLabel(status: SubagentThreadStatus | null): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "errored":
      return "Errored";
    case "interrupted":
      return "Interrupted";
    case "stopped":
      return "Stopped";
    case null:
      return "Unknown";
  }
}

export function subagentStatusToneClass(status: SubagentThreadStatus | null): string {
  switch (status) {
    case "running":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "completed":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "errored":
      return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "interrupted":
    case "stopped":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case null:
      return "border-muted-foreground/25 bg-muted/40 text-muted-foreground";
  }
}

export function formatSubagentDuration(startIso: string, endIso: string | null): string | null {
  if (!endIso) {
    return null;
  }
  return formatElapsed(startIso, endIso);
}

export function formatRunningSubagentDuration(startedAt: string): string {
  const elapsed = formatElapsed(startedAt, new Date().toISOString());
  return elapsed ? `running for ${elapsed}` : "running";
}

export function LiveSubagentDuration({ startedAt }: { startedAt: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const initialText = formatRunningSubagentDuration(startedAt);

  useEffect(() => {
    const update = () => {
      if (ref.current) {
        ref.current.textContent = formatRunningSubagentDuration(startedAt);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return <span ref={ref}>{initialText}</span>;
}
