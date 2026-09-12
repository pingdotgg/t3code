interface ReviewPerformanceLike {
  readonly now?: () => number;
  readonly mark?: (name: string) => void;
  readonly measure?: (name: string, startMark: string, endMark: string) => void;
  readonly clearMarks?: (name?: string) => void;
  readonly clearMeasures?: (name?: string) => void;
}

const REVIEW_PERF_PREFIX = "t3.review";
let reviewPerfSequence = 0;

function getPerformance(): ReviewPerformanceLike | null {
  const candidate = (globalThis as { readonly performance?: ReviewPerformanceLike }).performance;
  return candidate ?? null;
}

export function isReviewPerfEnabled(): boolean {
  return typeof __DEV__ !== "undefined" ? __DEV__ : false;
}

interface ReviewMeasureStarted {
  readonly startMark: string;
  readonly endMark: string;
  readonly startedAt: number;
}

/** Opens a sequenced perf interval for a review task and returns its marks. */
function startReviewMeasure(
  name: string,
  perf: ReviewPerformanceLike | null,
): ReviewMeasureStarted {
  const marker = `${REVIEW_PERF_PREFIX}.${name}.${reviewPerfSequence++}`;
  const startMark = `${marker}.start`;
  const endMark = `${marker}.end`;
  const startedAt = perf?.now?.() ?? Date.now();

  perf?.mark?.(startMark);
  return { startMark, endMark, startedAt };
}

/** Closes the interval from startReviewMeasure, records it, and logs the duration. */
function finishReviewMeasure(
  name: string,
  perf: ReviewPerformanceLike | null,
  started: ReviewMeasureStarted,
): void {
  const durationMs = (perf?.now?.() ?? Date.now()) - started.startedAt;
  perf?.mark?.(started.endMark);
  perf?.measure?.(`${REVIEW_PERF_PREFIX}.${name}`, started.startMark, started.endMark);
  perf?.clearMarks?.(started.startMark);
  perf?.clearMarks?.(started.endMark);
  console.log(`[review-perf] ${name}`, { durationMs: Number(durationMs.toFixed(2)) });
}

export function measureReviewWork<T>(name: string, callback: () => T): T {
  if (!isReviewPerfEnabled()) {
    return callback();
  }

  const perf = getPerformance();
  const started = startReviewMeasure(name, perf);
  try {
    return callback();
  } finally {
    finishReviewMeasure(name, perf, started);
  }
}

export async function measureReviewAsyncWork<T>(
  name: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (!isReviewPerfEnabled()) {
    return callback();
  }

  const perf = getPerformance();
  const started = startReviewMeasure(name, perf);
  try {
    return await callback();
  } finally {
    finishReviewMeasure(name, perf, started);
  }
}

export function markReviewEvent(name: string, details?: Record<string, unknown>): void {
  if (!isReviewPerfEnabled()) {
    return;
  }

  getPerformance()?.mark?.(`${REVIEW_PERF_PREFIX}.${name}`);
  if (details) {
    console.log(`[review-perf] ${name}`, details);
    return;
  }
  console.log(`[review-perf] ${name}`);
}
