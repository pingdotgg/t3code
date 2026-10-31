const MIN_TASKS = 50;
const FULL_EVIDENCE_TASKS = 100;
const MPID = 0.1;

const DEFAULT_Z = 1.959963984540054;
const BETA_EPSILON = 3e-14;
const BETA_MAX_ITERATIONS = 200;
const BETA_FLOOR = Number.MIN_VALUE / BETA_EPSILON;

export type ConfidenceInterval = {
  readonly low: number;
  readonly high: number;
};

export type WilsonInterval = ConfidenceInterval & {
  readonly estimate: number;
};

export type JudgmentObservation = {
  readonly taskId: string;
  readonly repeatIndex: number;
  readonly orderLabel: "treatment-first" | "control-first";
  readonly sampleIndex: number;
  readonly preferred: "treatment" | "control" | "tie" | "unknown";
  readonly treatmentScore: number | null;
  readonly controlScore: number | null;
};

export type MeanSummary = {
  readonly mean: number | null;
  readonly sd: number | null;
  readonly n: number;
  readonly ci: ConfidenceInterval | null;
};

export type PairedTaskEffect = MeanSummary & {
  readonly pValue: number | null;
  readonly rubricDiff: MeanSummary;
  readonly positionConsistency: number | null;
  readonly positionPairCount: number;
};

export type TrialStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type ArmOutcomeTrial = {
  readonly status: TrialStatus;
  readonly tokens: number | null;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
};

export type MedianSummary = {
  readonly median: number | null;
  readonly count: number;
};

export type ArmOutcomeSummary = {
  readonly trialCount: number;
  readonly completedCount: number;
  readonly completion: WilsonInterval | null;
  readonly tokens: MedianSummary;
  readonly durationMs: MedianSummary;
  readonly costUsd: MedianSummary;
};

export type SkillVerdictReason =
  | "too-few-tasks"
  | "too-few-repeats"
  | "wide-interval"
  | "likely-negligible"
  | "no-evaluations";

export type SkillVerdict =
  | { readonly verdict: "helps" | "hurts"; readonly reason: null }
  | { readonly verdict: "not-enough-data"; readonly reason: SkillVerdictReason };

export type ObservationalMode = "variant" | "off" | "base-available";

export type ObservationalTurn = {
  readonly skillName: string;
  readonly driver: string;
  readonly model: string;
  readonly mode: ObservationalMode;
  readonly activated: boolean;
  readonly status: "completed" | "interrupted" | "failed" | "cancelled";
  readonly reverted: boolean | null;
  readonly toolCalls: number;
  readonly toolFailures: number;
  readonly tokens: number | null;
  readonly durationMs: number | null;
};

export type ObservationalGroupSummary = {
  readonly kind: "observational";
  readonly confounded: true;
  readonly skillName: string;
  readonly driver: string;
  readonly model: string;
  readonly mode: ObservationalMode;
  readonly turns: number;
  readonly activations: number;
  readonly activationRate: number | null;
  readonly completions: number;
  readonly completion: WilsonInterval | null;
  readonly reverted: number;
  readonly revert: WilsonInterval | null;
  readonly toolCalls: number;
  readonly toolFailures: number;
  readonly toolFailureRate: number | null;
  readonly tokens: MedianSummary;
  readonly durationMs: MedianSummary;
};

const logGamma = (value: number): number => {
  const coefficients = [
    0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6,
    1.5056327351493116e-7,
  ];

  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }

  const shifted = value - 1;
  let series = coefficients[0] ?? 0;
  for (let index = 1; index < coefficients.length; index += 1) {
    series += (coefficients[index] ?? 0) / (shifted + index);
  }
  const base = shifted + coefficients.length - 1.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(base) - base + Math.log(series);
};

const betaContinuedFraction = (a: number, b: number, x: number): number => {
  const sum = a + b;
  const aPlusOne = a + 1;
  const aMinusOne = a - 1;
  let c = 1;
  let d = 1 - (sum * x) / aPlusOne;
  d = 1 / (Math.abs(d) < BETA_FLOOR ? BETA_FLOOR : d);
  let result = d;

  for (let iteration = 1; iteration <= BETA_MAX_ITERATIONS; iteration += 1) {
    const doubled = iteration * 2;
    let coefficient = (iteration * (b - iteration) * x) / ((aMinusOne + doubled) * (a + doubled));
    d = 1 + coefficient * d;
    d = Math.abs(d) < BETA_FLOOR ? BETA_FLOOR : d;
    c = 1 + coefficient / c;
    c = Math.abs(c) < BETA_FLOOR ? BETA_FLOOR : c;
    d = 1 / d;
    result *= d * c;

    coefficient =
      (-(a + iteration) * (sum + iteration) * x) / ((a + doubled) * (aPlusOne + doubled));
    d = 1 + coefficient * d;
    d = Math.abs(d) < BETA_FLOOR ? BETA_FLOOR : d;
    c = 1 + coefficient / c;
    c = Math.abs(c) < BETA_FLOOR ? BETA_FLOOR : c;
    d = 1 / d;
    const delta = d * c;
    result *= delta;

    if (Math.abs(delta - 1) <= BETA_EPSILON) return result;
  }

  return result;
};

const regularizedIncompleteBeta = (x: number, a: number, b: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const scale = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x),
  );
  const value =
    x < (a + 1) / (a + b + 2)
      ? (scale * betaContinuedFraction(a, b, x)) / a
      : 1 - (scale * betaContinuedFraction(b, a, 1 - x)) / b;
  return Math.min(1, Math.max(0, value));
};

const assertDegreesOfFreedom = (df: number): void => {
  if (!Number.isFinite(df) || df <= 0) {
    throw new RangeError("Degrees of freedom must be a positive finite number");
  }
};

export const studentTCdf = (t: number, df: number): number => {
  assertDegreesOfFreedom(df);
  if (t === Number.NEGATIVE_INFINITY) return 0;
  if (t === Number.POSITIVE_INFINITY) return 1;
  if (Number.isNaN(t)) return Number.NaN;
  if (t === 0) return 0.5;

  const beta = regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t < 0 ? beta / 2 : 1 - beta / 2;
};

const studentTDensity = (t: number, df: number): number =>
  Math.exp(
    logGamma((df + 1) / 2) -
      logGamma(df / 2) -
      0.5 * Math.log(df * Math.PI) -
      ((df + 1) / 2) * Math.log1p((t * t) / df),
  );

export const studentTQuantile = (p: number, df: number): number => {
  assertDegreesOfFreedom(df);
  if (p < 0 || p > 1 || Number.isNaN(p)) {
    throw new RangeError("Probability must be between zero and one");
  }
  if (p === 0) return Number.NEGATIVE_INFINITY;
  if (p === 1) return Number.POSITIVE_INFINITY;
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTQuantile(1 - p, df);

  let low = 0;
  let high = 1;
  while (studentTCdf(high, df) < p) high *= 2;

  let estimate = (low + high) / 2;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const error = studentTCdf(estimate, df) - p;
    if (Math.abs(error) < 1e-13) return estimate;

    if (error < 0) low = estimate;
    else high = estimate;

    const density = studentTDensity(estimate, df);
    const next = estimate - error / density;
    estimate = Number.isFinite(next) && next > low && next < high ? next : (low + high) / 2;

    if (high - low <= 1e-12 * Math.max(1, estimate)) return (low + high) / 2;
  }

  return estimate;
};

export const wilsonInterval = (
  successes: number,
  n: number,
  z = DEFAULT_Z,
): WilsonInterval | null => {
  if (
    !Number.isInteger(n) ||
    n < 0 ||
    !Number.isInteger(successes) ||
    successes < 0 ||
    successes > n
  ) {
    throw new RangeError(
      "Successes and trials must be non-negative integers with successes <= trials",
    );
  }
  if (!Number.isFinite(z) || z <= 0) throw new RangeError("z must be a positive finite number");
  if (n === 0) return null;

  const estimate = successes / n;
  const zSquared = z * z;
  const denominator = 1 + zSquared / n;
  const center = (estimate + zSquared / (2 * n)) / denominator;
  const radius =
    (z / denominator) * Math.sqrt((estimate * (1 - estimate)) / n + zSquared / (4 * n * n));
  return {
    estimate,
    low: successes === 0 ? 0 : Math.max(0, center - radius),
    high: successes === n ? 1 : Math.min(1, center + radius),
  };
};

export const holmAdjust = (pValues: readonly number[]): number[] => {
  for (const value of pValues) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError("p-values must be finite numbers between zero and one");
    }
  }

  const ranked = pValues
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const adjusted = Array.from<number>({ length: pValues.length }).fill(0);
  let previous = 0;

  for (let rank = 0; rank < ranked.length; rank += 1) {
    const entry = ranked[rank];
    if (entry === undefined) continue;
    previous = Math.max(previous, Math.min(1, (ranked.length - rank) * entry.value));
    adjusted[entry.index] = previous;
  }

  return adjusted;
};

const sampleSd = (values: readonly number[], mean: number): number | null => {
  if (values.length < 2) return null;
  const squaredDeviations = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(squaredDeviations / (values.length - 1));
};

const summarizeMeans = (values: readonly number[]): MeanSummary => {
  if (values.length === 0) return { mean: null, sd: null, n: 0, ci: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = sampleSd(values, mean);
  // With no spread across tasks a t-interval collapses to a point; report it as not estimable.
  if (sd === null || sd === 0) return { mean, sd, n: values.length, ci: null };
  const margin = studentTQuantile(0.975, values.length - 1) * (sd / Math.sqrt(values.length));
  return { mean, sd, n: values.length, ci: { low: mean - margin, high: mean + margin } };
};

const preferenceValue = (preferred: JudgmentObservation["preferred"]): number => {
  if (preferred === "treatment") return 1;
  if (preferred === "control") return 0;
  return 0.5;
};

const positionPairKey = (row: JudgmentObservation): string =>
  JSON.stringify([row.taskId, row.repeatIndex, row.sampleIndex]);

export const pairedTaskEffect = (rows: readonly JudgmentObservation[]): PairedTaskEffect => {
  const positionPairs = new Map<
    string,
    Partial<Record<JudgmentObservation["orderLabel"], JudgmentObservation["preferred"]>>
  >();
  for (const row of rows) {
    const key = positionPairKey(row);
    const pair = positionPairs.get(key) ?? {};
    pair[row.orderLabel] = row.preferred;
    positionPairs.set(key, pair);
  }

  const flippedPairs = new Set<string>();
  let agreeingPairs = 0;
  let completePairCount = 0;
  for (const [key, pair] of positionPairs) {
    const treatmentFirst = pair["treatment-first"];
    const controlFirst = pair["control-first"];
    if (treatmentFirst === undefined || controlFirst === undefined) continue;
    completePairCount += 1;
    if (treatmentFirst === controlFirst) agreeingPairs += 1;
    else flippedPairs.add(key);
  }

  const tasks = new Map<string, { preferences: number[]; rubricDiffs: number[] }>();
  for (const row of rows) {
    const task = tasks.get(row.taskId) ?? { preferences: [], rubricDiffs: [] };
    task.preferences.push(
      flippedPairs.has(positionPairKey(row)) ? 0.5 : preferenceValue(row.preferred),
    );
    if (row.treatmentScore !== null && row.controlScore !== null) {
      task.rubricDiffs.push(
        flippedPairs.has(positionPairKey(row)) ? 0 : row.treatmentScore - row.controlScore,
      );
    }
    tasks.set(row.taskId, task);
  }

  const taskEffects: number[] = [];
  const taskRubricDiffs: number[] = [];
  for (const task of tasks.values()) {
    if (task.preferences.length > 0) {
      const preference =
        task.preferences.reduce((sum, value) => sum + value, 0) / task.preferences.length;
      taskEffects.push(2 * preference - 1);
    }
    if (task.rubricDiffs.length > 0) {
      taskRubricDiffs.push(
        task.rubricDiffs.reduce((sum, value) => sum + value, 0) / task.rubricDiffs.length,
      );
    }
  }

  const effect = summarizeMeans(taskEffects);
  let pValue: number | null = null;
  if (effect.mean !== null && effect.sd !== null) {
    // Identical paired differences: exact two-sided sign test instead of an infinite t statistic.
    if (effect.sd === 0) pValue = effect.mean === 0 ? 1 : Math.min(1, 2 * 0.5 ** effect.n);
    else {
      const statistic = effect.mean / (effect.sd / Math.sqrt(effect.n));
      pValue = Math.min(1, 2 * (1 - studentTCdf(Math.abs(statistic), effect.n - 1)));
    }
  }

  return {
    ...effect,
    pValue,
    rubricDiff: summarizeMeans(taskRubricDiffs),
    positionConsistency: completePairCount === 0 ? null : agreeingPairs / completePairCount,
    positionPairCount: completePairCount,
  };
};

const medianSummary = (values: readonly (number | null)[]): MedianSummary => {
  const known = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (known.length === 0) return { median: null, count: 0 };
  const middle = Math.floor(known.length / 2);
  const median =
    known.length % 2 === 1
      ? (known[middle] ?? null)
      : ((known[middle - 1] ?? 0) + (known[middle] ?? 0)) / 2;
  return { median, count: known.length };
};

export const armOutcomeSummary = (trials: readonly ArmOutcomeTrial[]): ArmOutcomeSummary => {
  const completedCount = trials.reduce(
    (count, trial) => count + (trial.status === "completed" ? 1 : 0),
    0,
  );
  // Pending, running, and cancelled trials have no outcome yet; they must not count as failures.
  const settledCount = trials.filter(
    (trial) => trial.status === "completed" || trial.status === "failed",
  ).length;
  return {
    trialCount: trials.length,
    completedCount,
    completion: wilsonInterval(completedCount, settledCount),
    tokens: medianSummary(trials.map((trial) => trial.tokens)),
    durationMs: medianSummary(trials.map((trial) => trial.durationMs)),
    costUsd: medianSummary(trials.map((trial) => trial.costUsd)),
  };
};

export const skillVerdict = (input: {
  readonly effect: PairedTaskEffect;
  readonly adjustedP: number | null;
  readonly treatmentCompletion: WilsonInterval | null;
  readonly controlCompletion: WilsonInterval | null;
  readonly repeats: number;
  readonly judgeSamples: number;
}): SkillVerdict => {
  const { effect, adjustedP, treatmentCompletion, controlCompletion } = input;
  const completionDrop =
    treatmentCompletion !== null && controlCompletion !== null
      ? controlCompletion.estimate - treatmentCompletion.estimate
      : null;
  const completionHarm =
    completionDrop !== null &&
    completionDrop >= 0.2 &&
    treatmentCompletion !== null &&
    controlCompletion !== null &&
    treatmentCompletion.high < controlCompletion.low;

  if (effect.n === 0 || effect.mean === null) {
    return { verdict: "not-enough-data", reason: "no-evaluations" };
  }
  if (effect.n < MIN_TASKS) {
    return { verdict: "not-enough-data", reason: "too-few-tasks" };
  }
  if (input.repeats < 3 || input.judgeSamples < 3) {
    return { verdict: "not-enough-data", reason: "too-few-repeats" };
  }

  const practicalThreshold = effect.n < FULL_EVIDENCE_TASKS ? 2 * MPID : MPID;
  // No spread means every task agrees; decide on the point and the sign-test p, never display it as an interval.
  const interval = effect.ci ?? (effect.sd === 0 ? { low: effect.mean, high: effect.mean } : null);
  const statisticallySeparated = adjustedP !== null && adjustedP < 0.05 && interval !== null;

  if (effect.n >= FULL_EVIDENCE_TASKS && completionHarm) {
    return { verdict: "hurts", reason: null };
  }
  if (
    statisticallySeparated &&
    effect.mean <= -practicalThreshold &&
    interval !== null &&
    interval.high < 0
  ) {
    return { verdict: "hurts", reason: null };
  }

  const completionGuardPassed = completionDrop !== null && completionDrop <= 0.1;
  if (
    statisticallySeparated &&
    effect.mean >= practicalThreshold &&
    interval !== null &&
    interval.low > 0 &&
    completionGuardPassed
  ) {
    return { verdict: "helps", reason: null };
  }

  if (interval !== null && interval.low >= -MPID && interval.high <= MPID) {
    return { verdict: "not-enough-data", reason: "likely-negligible" };
  }
  return { verdict: "not-enough-data", reason: "wide-interval" };
};

export const observationalSummary = (
  turns: readonly ObservationalTurn[],
): ObservationalGroupSummary[] => {
  const groups = new Map<string, ObservationalTurn[]>();
  for (const turn of turns) {
    const key = JSON.stringify([turn.skillName, turn.driver, turn.model, turn.mode]);
    const group = groups.get(key) ?? [];
    group.push(turn);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const first = group[0];
    if (first === undefined) throw new Error("Observational groups cannot be empty");
    const activations = group.reduce((count, turn) => count + (turn.activated ? 1 : 0), 0);
    const completions = group.reduce(
      (count, turn) => count + (turn.status === "completed" ? 1 : 0),
      0,
    );
    const knownReverts = group.filter((turn) => turn.reverted !== null);
    const reverted = knownReverts.reduce(
      (count, turn) => count + (turn.reverted === true ? 1 : 0),
      0,
    );
    const toolCalls = group.reduce((sum, turn) => sum + turn.toolCalls, 0);
    const toolFailures = group.reduce((sum, turn) => sum + turn.toolFailures, 0);

    return {
      kind: "observational",
      confounded: true,
      skillName: first.skillName,
      driver: first.driver,
      model: first.model,
      mode: first.mode,
      turns: group.length,
      activations,
      activationRate: group.length === 0 ? null : activations / group.length,
      completions,
      completion: wilsonInterval(completions, group.length),
      reverted,
      revert: wilsonInterval(reverted, knownReverts.length),
      toolCalls,
      toolFailures,
      toolFailureRate: toolCalls === 0 ? null : toolFailures / toolCalls,
      tokens: medianSummary(group.map((turn) => turn.tokens)),
      durationMs: medianSummary(group.map((turn) => turn.durationMs)),
    };
  });
};
