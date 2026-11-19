import type {
  GameDevWorkspace,
  GameEngineStatus,
  GameInstallEvent,
  GameTimelineEntry,
} from "@t3tools/contracts";

export type ForgeTab = "project" | "engines" | "assets" | "settings";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** One line for an installer event, or null for events that do not change the label. */
export function installProgressLabel(event: GameInstallEvent): string | null {
  switch (event.type) {
    case "plan":
      return `Preparing ${event.plan.title}…`;
    case "progress": {
      const stage =
        event.stage === "downloading"
          ? event.resumed
            ? "Resuming download"
            : "Downloading"
          : event.stage === "verifying"
            ? "Verifying checksum"
            : event.stage === "extracting"
              ? "Extracting"
              : "Starting installer";
      if (event.totalBytes && event.completedBytes !== null) {
        const percent = Math.round((event.completedBytes / event.totalBytes) * 100);
        return `${stage} ${percent}% (${formatBytes(event.completedBytes)} of ${formatBytes(event.totalBytes)})`;
      }
      return `${stage}…`;
    }
    case "handoff":
      return event.message;
    case "complete":
      return event.message;
  }
}

/** Engines with a usable install first, then installable ones, then the rest. */
export function sortEngines(engines: ReadonlyArray<GameEngineStatus>): GameEngineStatus[] {
  const rank = (engine: GameEngineStatus) =>
    engine.sessions.length > 0
      ? 0
      : engine.installs.length > 0
        ? 1
        : engine.availability === "local"
          ? 2
          : 3;
  return [...engines].toSorted((left, right) => rank(left) - rank(right));
}

export function timelineTone(entry: GameTimelineEntry): "error" | "warning" | "success" | "muted" {
  if (entry.kind === "error" || entry.kind === "build-error" || entry.ok === false) return "error";
  if (entry.kind === "warning") return "warning";
  if (entry.ok === true || entry.kind === "test-result") return "success";
  return "muted";
}

/** Newest first, capped so a long playtest does not render thousands of rows. */
export function visibleTimeline(
  workspace: GameDevWorkspace,
  filter: "all" | "problems" | "agent",
  limit = 200,
): GameTimelineEntry[] {
  const entries = workspace.timeline.filter((entry) =>
    filter === "all"
      ? true
      : filter === "problems"
        ? timelineTone(entry) === "error" || timelineTone(entry) === "warning"
        : entry.kind === "agent-action",
  );
  return entries.slice(-limit).toReversed();
}
