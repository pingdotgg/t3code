import { downloadPlanAsTextFile } from "../../proposedPlan";

// Scroll-jank diagnostics for the virtualized timeline. Legend List can only
// *react* to an item's size change (it corrects scroll position to keep the
// visible anchor stable), so rows that settle to a height different from their
// first measurement are what jump the viewport while scrolling up. We record every
// post-mount resize into a bounded in-memory ring buffer — always on, including
// production, so it works in the installed PWA where there's no dev console — and
// expose an export that prefers the native share sheet (best for iOS PWA), then a
// file download, then the clipboard. Remove once the offending rows are fixed.

export interface TimelineResizeSample {
  /** Milliseconds since the first recorded sample (reveals bursts during a scroll). */
  readonly tMs: number;
  /** 1 = first measurement (estimate → real); 2+ = post-mount settle (the jank). */
  readonly occurrence: number;
  readonly kind: string;
  readonly key: string;
  readonly index: number;
  readonly previous: number;
  readonly size: number;
}

const MAX_SAMPLES = 4000;
const samples: TimelineResizeSample[] = [];
const occurrenceByKey = new Map<string, number>();
let firstSampleAt = 0;

export function recordTimelineResize(input: {
  readonly kind: string;
  readonly key: string;
  readonly index: number;
  readonly previous: number;
  readonly size: number;
}): number {
  const occurrence = (occurrenceByKey.get(input.key) ?? 0) + 1;
  occurrenceByKey.set(input.key, occurrence);

  const now = Date.now();
  if (firstSampleAt === 0) {
    firstSampleAt = now;
  }

  samples.push({
    tMs: now - firstSampleAt,
    occurrence,
    kind: input.kind,
    key: input.key,
    index: input.index,
    previous: Math.round(input.previous),
    size: Math.round(input.size),
  });

  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }

  return occurrence;
}

export function getTimelineResizeSampleCount(): number {
  return samples.length;
}

export function clearTimelineResizeDiagnostics(): void {
  samples.length = 0;
  occurrenceByKey.clear();
  firstSampleAt = 0;
}

interface KindAggregate {
  samples: number;
  /** Resizes that happened AFTER the first measurement — the repeated corrections. */
  resettles: number;
  maxAbsDelta: number;
  sumAbsDelta: number;
}

export function buildTimelineResizeDiagnosticsReport(): string {
  const lines: string[] = [
    "# Timeline resize diagnostics",
    `generatedAt: ${new Date().toISOString()}`,
  ];
  if (typeof navigator !== "undefined") {
    lines.push(`userAgent: ${navigator.userAgent}`);
  }
  if (typeof window !== "undefined") {
    lines.push(
      `viewport: ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio ?? 1}`,
    );
  }
  lines.push(
    `samples: ${samples.length}${samples.length >= MAX_SAMPLES ? ` (capped at ${MAX_SAMPLES})` : ""}`,
    "",
  );

  const byKind = new Map<string, KindAggregate>();
  for (const sample of samples) {
    const absDelta = Math.abs(sample.size - sample.previous);
    const aggregate = byKind.get(sample.kind) ?? {
      samples: 0,
      resettles: 0,
      maxAbsDelta: 0,
      sumAbsDelta: 0,
    };
    aggregate.samples += 1;
    if (sample.occurrence >= 2) {
      aggregate.resettles += 1;
    }
    aggregate.maxAbsDelta = Math.max(aggregate.maxAbsDelta, absDelta);
    aggregate.sumAbsDelta += absDelta;
    byKind.set(sample.kind, aggregate);
  }

  lines.push(
    "## Summary by kind (resettles = resized again AFTER first measure = the jank)",
    "kind\tsamples\tresettles\tmaxAbsDelta\tavgAbsDelta",
  );
  for (const [kind, aggregate] of [...byKind.entries()].sort(
    (a, b) => b[1].resettles - a[1].resettles || b[1].maxAbsDelta - a[1].maxAbsDelta,
  )) {
    const avg = aggregate.samples > 0 ? Math.round(aggregate.sumAbsDelta / aggregate.samples) : 0;
    lines.push(
      `${kind}\t${aggregate.samples}\t${aggregate.resettles}\t${aggregate.maxAbsDelta}\t${avg}`,
    );
  }

  lines.push("", "## Raw samples (tMs, occurrence, kind, prev→size, delta, index, key)");
  for (const sample of samples) {
    const delta = sample.size - sample.previous;
    lines.push(
      `${sample.tMs}\t#${sample.occurrence}\t${sample.kind}\t${sample.previous}→${sample.size}\t` +
        `Δ${delta >= 0 ? "+" : ""}${delta}\tidx=${sample.index}\t${sample.key}`,
    );
  }

  return lines.join("\n");
}

export type TimelineResizeExportResult = "empty" | "shared" | "downloaded" | "copied";

export async function exportTimelineResizeDiagnostics(): Promise<TimelineResizeExportResult> {
  if (samples.length === 0) {
    return "empty";
  }

  const report = buildTimelineResizeDiagnosticsReport();
  const filename = `timeline-resize-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;

  // Native share sheet first — the reliable path for an installed iOS PWA.
  if (typeof navigator !== "undefined" && typeof File !== "undefined" && navigator.canShare) {
    const file = new File([report], filename, { type: "text/plain" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Timeline resize diagnostics" });
        return "shared";
      } catch (error) {
        // User dismissing the share sheet is not a failure; don't double-export.
        if (error instanceof DOMException && error.name === "AbortError") {
          return "shared";
        }
        // Any other error: fall through to the download path.
      }
    }
  }

  try {
    downloadPlanAsTextFile(filename, report);
    return "downloaded";
  } catch {
    // Last resort: clipboard.
  }

  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(report);
    return "copied";
  }

  throw new Error("No available export method on this device");
}
