import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

import { formatReset } from "./usage";

const NOTICE_PERCENTS = [50, 80, 95];

export interface UsageReading {
  readonly id: string;
  /** Whole percent, as the usage bar shows it. */
  readonly percent: number;
  readonly line: string;
}

/** `Claude weekly 82%, resets in 5d 22h`. */
function usageLine(provider: string, window: ServerProviderUsageWindow, nowMs: number): string {
  const percent = Math.round(window.usedPercent);
  const reset =
    window.resetsAt === undefined ? "" : `, resets in ${formatReset(window.resetsAt, nowMs)}`;
  return `${provider} ${window.label.toLowerCase()} ${percent}%${reset}`;
}

/** One reading for each usage window the provider reports. */
export function usageReadings(
  provider: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  nowMs: number,
): ReadonlyArray<UsageReading> {
  return windows.map((window) => ({
    id: window.id,
    percent: Math.round(window.usedPercent),
    line: usageLine(provider, window, nowMs),
  }));
}

/** The readings of one provider instance, or none when the engine does not list it. */
export function readingsFor(
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "displayName" | "driver" | "usageLimits">
  >,
  instanceId: string,
  nowMs: number,
): ReadonlyArray<UsageReading> {
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  return provider === undefined
    ? []
    : usageReadings(
        provider.displayName ?? provider.driver,
        provider.usageLimits?.windows ?? [],
        nowMs,
      );
}

/** One message for each window that rose past 50, 80, or 95 percent between two readings, naming the highest level it passed. */
export function usageCrossings(
  before: ReadonlyArray<UsageReading>,
  after: ReadonlyArray<UsageReading>,
): ReadonlyArray<string> {
  return after.flatMap((reading) => {
    const earlier = before.find((entry) => entry.id === reading.id);
    const passed = NOTICE_PERCENTS.findLast(
      (level) => earlier !== undefined && earlier.percent < level && reading.percent >= level,
    );
    return passed === undefined
      ? []
      : [`Usage notice: ${reading.line}. It passed ${passed} percent.`];
  });
}

export function usageFacts(readings: ReadonlyArray<UsageReading>): string {
  return readings.length === 0
    ? "- Your provider reports no usage windows."
    : [
        "- Usage, one line for each window of your provider:",
        ...readings.map((reading) => `  - ${reading.line}`),
      ].join("\n");
}
