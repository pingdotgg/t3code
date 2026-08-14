/**
 * Interaction-event schema for Computer History segments.
 * Closely mirrors Codex Skysight EventStreamRecord kinds.
 */

export type ComputerHistoryEventKind =
  | "session.started"
  | "session.ended"
  | "appWindowChanged"
  | "mouse.click"
  | "keyboard.text_input"
  | "keyboard.shortcut"
  | "selection.changed"
  | "ax.focus_changed"
  | "sample.frontmost"
  | "debug.error";

export type ComputerHistoryAppRef = {
  readonly bundleIdentifier?: string;
  readonly processIdentifier?: number;
  readonly name?: string;
  readonly path?: string;
};

export type ComputerHistoryWindowRef = {
  readonly windowID?: number | string;
  readonly title?: string;
};

export type ComputerHistoryAxRef = {
  readonly role?: string;
  readonly subrole?: string;
  readonly description?: string;
  readonly value?: string;
  readonly identifier?: string;
};

export type ComputerHistoryEvent = {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: ComputerHistoryEventKind;
  readonly app?: ComputerHistoryAppRef;
  readonly window?: ComputerHistoryWindowRef;
  readonly ax?: ComputerHistoryAxRef;
  readonly text?: string;
  readonly url?: string;
  readonly detail?: string;
};

export type ComputerHistorySegmentMetadata = {
  readonly sessionID: string;
  readonly segmentID: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly endReason?: string;
  readonly eventCount: number;
  readonly suppressedEventCount: number;
  readonly platform: string;
};

export type ComputerHistoryControlFile = {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly appFilterMode: "exclude" | "includeOnly";
  readonly apps: ReadonlyArray<string>;
  readonly websiteFilterMode: "exclude" | "includeOnly";
  readonly websites: ReadonlyArray<string>;
};

export type ComputerHistoryDaemonStatusFile = {
  readonly phase: "stopped" | "starting" | "running" | "paused" | "error" | "unavailable";
  readonly accessibilityGranted: boolean;
  readonly activeSegmentId?: string;
  readonly eventCount: number;
  readonly lastError?: string;
  readonly platform: string;
  readonly updatedAt: string;
  readonly pid?: number;
};

export function parseEventLine(line: string): ComputerHistoryEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const value = JSON.parse(trimmed) as ComputerHistoryEvent;
    if (typeof value?.id !== "string" || typeof value?.kind !== "string") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function appMatchesFilter(
  app: ComputerHistoryAppRef | undefined,
  mode: "exclude" | "includeOnly",
  filters: ReadonlyArray<string>,
): boolean {
  if (filters.length === 0) {
    return mode === "exclude";
  }
  const haystacks = [app?.bundleIdentifier, app?.name, app?.path]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase());
  const hit = filters.some((filter) => {
    const needle = filter.toLowerCase();
    return haystacks.some((hay) => hay.includes(needle) || needle.includes(hay));
  });
  return mode === "exclude" ? !hit : hit;
}

export function websiteMatchesFilter(
  url: string | undefined,
  mode: "exclude" | "includeOnly",
  filters: ReadonlyArray<string>,
): boolean {
  if (!url) {
    return true;
  }
  // Private-mode browsing is never included (heuristic: common private markers).
  const lowered = url.toLowerCase();
  if (
    lowered.includes("chrome://newtab") ||
    lowered.startsWith("about:privatebrowsing") ||
    lowered.includes("edge://newtab")
  ) {
    return false;
  }
  if (filters.length === 0) {
    return mode === "exclude";
  }
  const hit = filters.some((filter) => lowered.includes(filter.toLowerCase()));
  return mode === "exclude" ? !hit : hit;
}
