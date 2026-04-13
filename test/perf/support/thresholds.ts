export interface PerfThresholdProfile {
  readonly maxMountedTimelineRows: number;
  readonly threadSwitchP50Ms: number;
  readonly threadSwitchP95Ms: number;
  readonly maxLongTaskMs: number;
  readonly maxRafGapMs: number;
  readonly burstCompletionMs: number;
  readonly longTasksOver50MsMax: number;
}

export const PERF_THRESHOLDS = {
  local: {
    maxMountedTimelineRows: 140,
    threadSwitchP50Ms: 250,
    threadSwitchP95Ms: 500,
    maxLongTaskMs: 120,
    maxRafGapMs: 120,
    burstCompletionMs: 14_000,
    longTasksOver50MsMax: 2,
  },
} as const satisfies Record<string, PerfThresholdProfile>;

export type PerfThresholdProfileName = keyof typeof PERF_THRESHOLDS;
