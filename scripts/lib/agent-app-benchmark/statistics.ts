export interface ConfidenceInterval {
  readonly low: number;
  readonly high: number;
  readonly confidence: number;
  readonly iterations: number;
  readonly seed: number;
}

export interface BootstrapOptions {
  readonly seed: number;
  readonly iterations?: number;
  readonly confidence?: number;
}

export type ComparisonDecision =
  | "candidate-lower"
  | "baseline-lower"
  | "no-clear-difference"
  | "not-rankable";

export interface PairedComparison {
  readonly baselineMedian: number;
  readonly candidateMedian: number;
  readonly medianDifference: number;
  readonly percentageDifference: number | null;
  readonly differenceInterval: ConfidenceInterval;
  readonly decision: ComparisonDecision;
}

function requireFiniteSamples(samples: ReadonlyArray<number>, label: string): void {
  if (samples.length === 0) throw new Error(`${label} requires at least one sample.`);
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error(`${label} accepts only finite samples.`);
  }
}

function sortedCopy(samples: ReadonlyArray<number>): Array<number> {
  return [...samples].sort((left, right) => left - right);
}

/** R-7 linear interpolation, matching the common spreadsheet percentile definition. */
export function percentile(samples: ReadonlyArray<number>, probability: number): number {
  requireFiniteSamples(samples, "percentile");
  if (probability < 0 || probability > 1 || !Number.isFinite(probability)) {
    throw new Error(`percentile probability must be between 0 and 1; received ${probability}.`);
  }
  const ordered = sortedCopy(samples);
  const index = (ordered.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower]!;
  const weight = index - lower;
  return ordered[lower]! * (1 - weight) + ordered[upper]! * weight;
}

export function median(samples: ReadonlyArray<number>): number {
  return percentile(samples, 0.5);
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function seededShuffle<T>(values: ReadonlyArray<T>, seed: number): ReadonlyArray<T> {
  const output = [...values];
  const random = createRandom(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [output[index], output[swapIndex]] = [output[swapIndex]!, output[index]!];
  }
  return output;
}

function normalizeBootstrapOptions(options: BootstrapOptions): {
  readonly seed: number;
  readonly iterations: number;
  readonly confidence: number;
} {
  const iterations = options.iterations ?? 10_000;
  const confidence = options.confidence ?? 0.95;
  if (!Number.isInteger(iterations) || iterations < 100) {
    throw new Error(
      `bootstrap iterations must be an integer of at least 100; received ${iterations}.`,
    );
  }
  if (!(confidence > 0 && confidence < 1)) {
    throw new Error(`bootstrap confidence must be between 0 and 1; received ${confidence}.`);
  }
  return { seed: options.seed, iterations, confidence };
}

function bootstrapInterval(
  sampleCount: number,
  statistic: (indexes: ReadonlyArray<number>) => number,
  options: BootstrapOptions,
): ConfidenceInterval {
  const normalized = normalizeBootstrapOptions(options);
  const random = createRandom(normalized.seed);
  const estimates: Array<number> = [];
  for (let iteration = 0; iteration < normalized.iterations; iteration += 1) {
    const indexes = Array.from({ length: sampleCount }, () => Math.floor(random() * sampleCount));
    estimates.push(statistic(indexes));
  }
  const tail = (1 - normalized.confidence) / 2;
  return {
    low: percentile(estimates, tail),
    high: percentile(estimates, 1 - tail),
    ...normalized,
  };
}

export function bootstrapMedianInterval(
  samples: ReadonlyArray<number>,
  options: BootstrapOptions,
): ConfidenceInterval {
  requireFiniteSamples(samples, "bootstrapMedianInterval");
  return bootstrapInterval(
    samples.length,
    (indexes) => median(indexes.map((index) => samples[index]!)),
    options,
  );
}

export function pairedBootstrapDifferenceInterval(
  baseline: ReadonlyArray<number>,
  candidate: ReadonlyArray<number>,
  options: BootstrapOptions,
): ConfidenceInterval {
  requireFiniteSamples(baseline, "pairedBootstrapDifferenceInterval baseline");
  requireFiniteSamples(candidate, "pairedBootstrapDifferenceInterval candidate");
  if (baseline.length !== candidate.length) {
    throw new Error(
      `paired samples must have equal lengths; received ${baseline.length} and ${candidate.length}.`,
    );
  }
  const differences = baseline.map((value, index) => candidate[index]! - value);
  return bootstrapInterval(
    differences.length,
    (indexes) => median(indexes.map((index) => differences[index]!)),
    options,
  );
}

export function percentageDifference(baseline: number, candidate: number): number | null {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) {
    throw new Error("percentageDifference accepts only finite values.");
  }
  return baseline === 0 ? null : ((candidate - baseline) / Math.abs(baseline)) * 100;
}

export function comparePairedSamples(input: {
  readonly baseline: ReadonlyArray<number>;
  readonly candidate: ReadonlyArray<number>;
  readonly seed: number;
  readonly iterations?: number;
  readonly confidence?: number;
  readonly resolution: number;
  readonly invalidAttempts: number;
}): PairedComparison {
  if (!Number.isFinite(input.resolution) || input.resolution < 0) {
    throw new Error(
      `resolution must be a non-negative finite number; received ${input.resolution}.`,
    );
  }
  const baselineMedian = median(input.baseline);
  const candidateMedian = median(input.candidate);
  const differenceInterval = pairedBootstrapDifferenceInterval(input.baseline, input.candidate, {
    seed: input.seed,
    ...(input.iterations === undefined ? {} : { iterations: input.iterations }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
  });
  const medianDifference = median(
    input.baseline.map((value, index) => input.candidate[index]! - value),
  );
  // Differences are candidate minus baseline, so a wholly negative interval
  // means the candidate is lower. A directional claim needs the entire
  // interval to clear the disclosed resolution band on one side; anything
  // overlapping [-resolution, +resolution] stays a tie.
  let decision: ComparisonDecision;
  if (input.invalidAttempts > 0) {
    decision = "not-rankable";
  } else if (differenceInterval.high < -input.resolution) {
    decision = "candidate-lower";
  } else if (differenceInterval.low > input.resolution) {
    decision = "baseline-lower";
  } else {
    decision = "no-clear-difference";
  }
  return {
    baselineMedian,
    candidateMedian,
    medianDifference,
    percentageDifference: percentageDifference(baselineMedian, candidateMedian),
    differenceInterval,
    decision,
  };
}
