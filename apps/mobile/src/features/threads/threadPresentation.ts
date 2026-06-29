import type { StatusTone } from "../../components/StatusPill";
import { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export function threadSortValue(thread: EnvironmentThreadShell): number {
  const candidate = Date.parse(thread.updatedAt ?? thread.createdAt);
  return Number.isNaN(candidate) ? 0 : candidate;
}

export function threadStatusTone(thread: EnvironmentThreadShell): StatusTone {
  const status = thread.runtime?.status;
  if (status === "running" || status === "waiting") {
    return {
      label: "Running",
      pillClassName: "bg-orange-500/12 dark:bg-orange-500/16",
      textClassName: "text-orange-700 dark:text-orange-300",
    };
  }
  if (status === "completed") {
    return {
      label: "Ready",
      pillClassName: "bg-emerald-500/12 dark:bg-emerald-500/16",
      textClassName: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (status === "preparing" || status === "queued" || status === "starting") {
    return {
      label: "Starting",
      pillClassName: "bg-sky-500/12 dark:bg-sky-500/16",
      textClassName: "text-sky-700 dark:text-sky-300",
    };
  }
  if (status === "failed") {
    return {
      label: "Error",
      pillClassName: "bg-rose-500/12 dark:bg-rose-500/16",
      textClassName: "text-rose-700 dark:text-rose-300",
    };
  }
  return {
    label: "Idle",
    pillClassName: "bg-neutral-500/10 dark:bg-neutral-500/16",
    textClassName: "text-neutral-600 dark:text-neutral-300",
  };
}
