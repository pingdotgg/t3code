/**
 * Pure Tempo capacity math (see t3work-tempo.ts for the formula and the
 * route entry point). Unit-tested in t3work-tempo.test.ts.
 */

export type TempoScheduleDay = {
  readonly date: string;
  readonly requiredSeconds: number;
  readonly type?: string;
};

export type TempoPlan = {
  readonly startDate: string;
  readonly endDate: string;
  readonly plannedSecondsPerDay: number;
  readonly totalPlannedSecondsInScope?: number;
  readonly planItem?: { readonly id?: string; readonly type?: string };
};

export type T3workTempoUserCapacity = {
  readonly accountId: string;
  /** Σ user-schedule requiredSeconds over the range. */
  readonly requiredSeconds: number;
  /** Σ non-issue plan seconds overlapping the range (vacations, allocations). */
  readonly plannedSeconds: number;
  /** max(0, required − planned). */
  readonly capacitySeconds: number;
  readonly workingDays: number;
  readonly error?: string;
};

function clampDate(value: string, low: string, high: string): string {
  return value < low ? low : value > high ? high : value;
}

function dayCountInclusive(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * Seconds a plan blocks inside [from, to]. Tempo reports
 * `totalPlannedSecondsInScope` when the query range clips the plan; the
 * fallback distributes plannedSecondsPerDay over the overlapping working days
 * known from the schedule.
 */
export function planSecondsInRange(
  plan: TempoPlan,
  from: string,
  to: string,
  workingDates: ReadonlySet<string>,
): number {
  if (plan.endDate < from || plan.startDate > to) return 0;
  if (typeof plan.totalPlannedSecondsInScope === "number") {
    return Math.max(0, plan.totalPlannedSecondsInScope);
  }
  const overlapFrom = clampDate(plan.startDate, from, to);
  const overlapTo = clampDate(plan.endDate, from, to);
  let overlapWorkingDays = 0;
  const days = dayCountInclusive(overlapFrom, overlapTo);
  const start = Date.parse(`${overlapFrom}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    // @effect-diagnostics-next-line globalDate:off
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    if (workingDates.has(date)) overlapWorkingDays += 1;
  }
  return Math.max(0, plan.plannedSecondsPerDay) * overlapWorkingDays;
}

/**
 * Splits plans into unavailability (subtract from capacity) vs work plans
 * (keep). Non-issue plans always subtract. Issue plans subtract only when the
 * issue's project key is known AND differs from the planned project — unknown
 * keys stay conservative (treated as work, the pre-fix behavior).
 */
export function selectUnavailabilityPlans(
  plans: ReadonlyArray<TempoPlan>,
  options: {
    readonly projectKey?: string | undefined;
    readonly issueKeyById?: ReadonlyMap<string, string | null> | undefined;
  } = {},
): TempoPlan[] {
  return plans.filter((plan) => {
    if ((plan.planItem?.type ?? "").toUpperCase() !== "ISSUE") return true;
    const projectKey = options.projectKey?.trim().toUpperCase();
    const issueId = plan.planItem?.id;
    if (!projectKey || !issueId) return false;
    const issueKey = options.issueKeyById?.get(issueId);
    if (!issueKey) return false;
    const issueProjectKey = issueKey.split("-")[0]?.toUpperCase();
    return issueProjectKey !== undefined && issueProjectKey !== projectKey;
  });
}

export function computeTempoUserCapacity(input: {
  readonly accountId: string;
  readonly scheduleDays: ReadonlyArray<TempoScheduleDay>;
  /** Pre-selected unavailability plans (see selectUnavailabilityPlans). */
  readonly unavailabilityPlans: ReadonlyArray<TempoPlan>;
  readonly from: string;
  readonly to: string;
}): T3workTempoUserCapacity {
  const inRange = input.scheduleDays.filter(
    (day) => day.date >= input.from && day.date <= input.to,
  );
  const requiredSeconds = inRange.reduce(
    (sum, day) => sum + Math.max(0, day.requiredSeconds),
    0,
  );
  const workingDates = new Set(
    inRange.filter((day) => day.requiredSeconds > 0).map((day) => day.date),
  );
  const plannedSeconds = input.unavailabilityPlans.reduce(
    (sum, plan) => sum + planSecondsInRange(plan, input.from, input.to, workingDates),
    0,
  );
  return {
    accountId: input.accountId,
    requiredSeconds,
    plannedSeconds,
    capacitySeconds: Math.max(0, requiredSeconds - plannedSeconds),
    workingDays: workingDates.size,
  };
}
