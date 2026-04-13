import type { BrowserPerfMetrics } from "./artifact.ts";

export const PERF_BROWSER_GLOBAL = "__t3PerfCollector";
const DEFAULT_TIMELINE_ROW_SELECTOR = "[data-timeline-row-kind]";

export interface BrowserPerfCollector {
  readonly startAction: (name: string) => void;
  readonly endAction: (name: string) => number | null;
  readonly sampleMountedRows: (label: string) => number;
  readonly snapshot: () => BrowserPerfMetrics;
  readonly reset: () => void;
}

declare global {
  interface Window {
    __t3PerfCollector?: BrowserPerfCollector;
  }
}

export function installBrowserPerfCollector(
  timelineRowSelector = DEFAULT_TIMELINE_ROW_SELECTOR,
): void {
  if (typeof window === "undefined" || window.__t3PerfCollector) {
    return;
  }

  const actionStarts = new Map<string, number>();
  const actions: Array<BrowserPerfMetrics["actions"][number]> = [];
  const longTasks: Array<BrowserPerfMetrics["longTasks"][number]> = [];
  const rafGapsMs: number[] = [];
  const mountedRowSamples: Array<BrowserPerfMetrics["mountedRowSamples"][number]> = [];
  let previousAnimationFrameTs = 0;
  let rafHandle = 0;

  const animationFrameLoop = (timestampMs: number) => {
    if (previousAnimationFrameTs > 0) {
      rafGapsMs.push(timestampMs - previousAnimationFrameTs);
    }
    previousAnimationFrameTs = timestampMs;
    rafHandle = window.requestAnimationFrame(animationFrameLoop);
  };
  rafHandle = window.requestAnimationFrame(animationFrameLoop);

  if (typeof PerformanceObserver !== "undefined") {
    try {
      const longTaskObserver = new PerformanceObserver((list: PerformanceObserverEntryList) => {
        for (const entry of list.getEntries()) {
          longTasks.push({
            name: entry.name,
            startTimeMs: entry.startTime,
            durationMs: entry.duration,
          });
        }
      });
      longTaskObserver.observe({ entryTypes: ["longtask"] } as PerformanceObserverInit);
    } catch {
      // Ignore browsers or runtimes that do not expose long-task observation.
    }
  }

  const readMountedRows = () => document.querySelectorAll(timelineRowSelector).length;

  window.__t3PerfCollector = {
    startAction(name: string) {
      actionStarts.set(name, performance.now());
    },
    endAction(name: string) {
      const startedAtMs = actionStarts.get(name);
      if (startedAtMs === undefined) {
        return null;
      }
      const endedAtMs = performance.now();
      const durationMs = endedAtMs - startedAtMs;
      actions.push({
        name,
        durationMs,
        startedAtMs,
        endedAtMs,
      });
      actionStarts.delete(name);
      return durationMs;
    },
    sampleMountedRows(label: string) {
      const count = readMountedRows();
      mountedRowSamples.push({
        label,
        count,
        capturedAtMs: performance.now(),
      });
      return count;
    },
    snapshot() {
      return {
        actions: [...actions],
        longTasks: [...longTasks],
        rafGapsMs: [...rafGapsMs],
        mountedRowSamples: [...mountedRowSamples],
      };
    },
    reset() {
      actionStarts.clear();
      actions.length = 0;
      longTasks.length = 0;
      rafGapsMs.length = 0;
      mountedRowSamples.length = 0;
      previousAnimationFrameTs = 0;
      window.cancelAnimationFrame(rafHandle);
      rafHandle = window.requestAnimationFrame(animationFrameLoop);
    },
  };
}
