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

export function measureReviewWork<T>(name: string, callback: () => T): T {
  if (!isReviewPerfEnabled()) {
    return callback();
  }

  const perf = getPerformance();
  const marker = `${REVIEW_PERF_PREFIX}.${name}.${reviewPerfSequence++}`;
  const startMark = `${marker}.start`;
  const endMark = `${marker}.end`;
  const startedAt = perf?.now?.() ?? Date.now();

  perf?.mark?.(startMark);
  try {
    return callback();
  } finally {
    const durationMs = (perf?.now?.() ?? Date.now()) - startedAt;
    perf?.mark?.(endMark);
    perf?.measure?.(`${REVIEW_PERF_PREFIX}.${name}`, startMark, endMark);
    perf?.clearMarks?.(startMark);
    perf?.clearMarks?.(endMark);
    console.log(`[review-perf] ${name}`, { durationMs: Number(durationMs.toFixed(2)) });
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
  const marker = `${REVIEW_PERF_PREFIX}.${name}.${reviewPerfSequence++}`;
  const startMark = `${marker}.start`;
  const endMark = `${marker}.end`;
  const startedAt = perf?.now?.() ?? Date.now();

  perf?.mark?.(startMark);
  try {
    return await callback();
  } finally {
    const durationMs = (perf?.now?.() ?? Date.now()) - startedAt;
    perf?.mark?.(endMark);
    perf?.measure?.(`${REVIEW_PERF_PREFIX}.${name}`, startMark, endMark);
    perf?.clearMarks?.(startMark);
    perf?.clearMarks?.(endMark);
    console.log(`[review-perf] ${name}`, { durationMs: Number(durationMs.toFixed(2)) });
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
