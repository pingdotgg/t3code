import type { UsageAggregate, UsageSummaryResponse } from "@t3tools/contracts";
import { USAGE_PRICING_VERSION, estimateCostMicroUsd } from "@t3tools/shared/usagePricing";

import type { ProjectionUsageFact } from "../persistence/Services/ProjectionUsage.ts";

/**
 * Pure aggregation of usage facts into the dashboard-shaped summary. Calendar
 * bucketing happens in the requested IANA timezone via Intl (DST folds into
 * the local calendar naturally). `turn-total` facts are reconciliation-only
 * and excluded from all sums; stale facts count (tokens were consumed).
 */

interface MutableAggregate {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  turns: number;
  exactCostMicroUsd: number;
  estimatedCostMicroUsd: number;
}

function newAggregate(): MutableAggregate {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    turns: 0,
    exactCostMicroUsd: 0,
    estimatedCostMicroUsd: 0,
  };
}

function addFact(
  aggregate: MutableAggregate,
  fact: ProjectionUsageFact,
  estimatedMicroUsd: number | undefined,
): void {
  aggregate.inputTokens += fact.inputTokens;
  aggregate.cachedInputTokens += fact.cachedInputTokens;
  aggregate.cacheCreationTokens += fact.cacheCreationTokens;
  aggregate.outputTokens += fact.outputTokens;
  aggregate.reasoningOutputTokens += fact.reasoningOutputTokens;
  aggregate.totalTokens +=
    fact.inputTokens + fact.cachedInputTokens + fact.cacheCreationTokens + fact.outputTokens;
  if (fact.costMicroUsd !== null) {
    aggregate.exactCostMicroUsd += fact.costMicroUsd;
  } else if (estimatedMicroUsd !== undefined) {
    aggregate.estimatedCostMicroUsd += estimatedMicroUsd;
  }
}

function toAggregate(mutable: MutableAggregate): UsageAggregate {
  return { ...mutable };
}

function makeCalendarFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface CalendarParts {
  readonly day: string;
  readonly hour: number;
  readonly dayOfWeek: number;
}

function calendarParts(formatter: Intl.DateTimeFormat, iso: string): CalendarParts {
  const parts = formatter.formatToParts(Date.parse(iso));
  let year = "",
    month = "",
    day = "",
    hour = 0,
    dayOfWeek = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = part.value;
        break;
      case "month":
        month = part.value;
        break;
      case "day":
        day = part.value;
        break;
      case "hour":
        hour = Number(part.value) % 24;
        break;
      case "weekday":
        dayOfWeek = WEEKDAY_INDEX[part.value] ?? 0;
        break;
    }
  }
  return { day: `${year}-${month}-${day}`, hour, dayOfWeek };
}

export type UsageProjectTitleLookup = (projectId: string) => string | null;

export function summarizeUsageFacts(input: {
  readonly facts: ReadonlyArray<ProjectionUsageFact>;
  readonly timeZone: string;
  readonly earliestFactAt: string | null;
  readonly projectTitle: UsageProjectTitleLookup;
}): UsageSummaryResponse {
  const formatter = makeCalendarFormatter(input.timeZone);

  const totals = newAggregate();
  const byModel = new Map<
    string,
    MutableAggregate & { provider: ProjectionUsageFact["provider"]; hasEstimate: boolean }
  >();
  const daily = new Map<
    string,
    MutableAggregate & {
      day: string;
      provider: ProjectionUsageFact["provider"];
      model: string;
    }
  >();
  const hourOfWeek = new Map<
    string,
    { dayOfWeek: number; hour: number; turns: number; totalTokens: number }
  >();
  const byProject = new Map<
    string,
    MutableAggregate & { projectId: ProjectionUsageFact["projectId"] }
  >();
  const unpricedModels = new Set<string>();
  const turnKeys = new Set<string>();
  const turnKeysByScope = new Map<string, Set<string>>();

  const scopedTurnCount = (scope: string, turnKey: string): number => {
    let keys = turnKeysByScope.get(scope);
    if (!keys) {
      keys = new Set();
      turnKeysByScope.set(scope, keys);
    }
    const before = keys.size;
    keys.add(turnKey);
    return keys.size - before;
  };

  for (const fact of input.facts) {
    if (fact.kind === "turn-total") {
      continue;
    }
    const estimated =
      fact.costMicroUsd === null
        ? estimateCostMicroUsd(fact.model, fact.observedAt, {
            inputTokens: fact.inputTokens,
            cachedInputTokens: fact.cachedInputTokens,
            cacheCreationTokens: fact.cacheCreationTokens,
            outputTokens: fact.outputTokens,
          })
        : undefined;
    if (fact.costMicroUsd === null && estimated === undefined) {
      unpricedModels.add(fact.model);
    }

    const cal = calendarParts(formatter, fact.observedAt);
    const turnKey = `${fact.threadId}|${fact.turnId ?? fact.factId}`;
    const factTokens =
      fact.inputTokens + fact.cachedInputTokens + fact.cacheCreationTokens + fact.outputTokens;

    addFact(totals, fact, estimated);
    if (!turnKeys.has(turnKey)) {
      turnKeys.add(turnKey);
      totals.turns += 1;
    }

    const modelKey = `${fact.provider}|${fact.model}`;
    let model = byModel.get(modelKey);
    if (!model) {
      model = { ...newAggregate(), provider: fact.provider, hasEstimate: false };
      byModel.set(modelKey, model);
    }
    addFact(model, fact, estimated);
    if (estimated !== undefined) model.hasEstimate = true;
    model.turns += scopedTurnCount(`model:${modelKey}`, turnKey);

    const dayKey = `${cal.day}|${fact.provider}|${fact.model}`;
    let dayBucket = daily.get(dayKey);
    if (!dayBucket) {
      dayBucket = { ...newAggregate(), day: cal.day, provider: fact.provider, model: fact.model };
      daily.set(dayKey, dayBucket);
    }
    addFact(dayBucket, fact, estimated);
    dayBucket.turns += scopedTurnCount(`day:${dayKey}`, turnKey);

    const howKey = `${cal.dayOfWeek}|${cal.hour}`;
    let how = hourOfWeek.get(howKey);
    if (!how) {
      how = { dayOfWeek: cal.dayOfWeek, hour: cal.hour, turns: 0, totalTokens: 0 };
      hourOfWeek.set(howKey, how);
    }
    how.totalTokens += factTokens;
    how.turns += scopedTurnCount(`how:${howKey}`, turnKey);

    const projectKey = fact.projectId ?? "__none__";
    let project = byProject.get(projectKey);
    if (!project) {
      project = { ...newAggregate(), projectId: fact.projectId };
      byProject.set(projectKey, project);
    }
    addFact(project, fact, estimated);
    project.turns += scopedTurnCount(`project:${projectKey}`, turnKey);
  }

  const modelBuckets = [...byModel.entries()]
    .map(([key, aggregate]) => ({
      ...toAggregate(aggregate),
      provider: aggregate.provider,
      model: key.slice(key.indexOf("|") + 1),
      costSource:
        aggregate.exactCostMicroUsd > 0
          ? ("exact" as const)
          : aggregate.hasEstimate
            ? ("estimated" as const)
            : ("none" as const),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const dailyBuckets = [...daily.values()]
    .map((bucket) => ({
      ...toAggregate(bucket),
      day: bucket.day,
      provider: bucket.provider,
      model: bucket.model,
    }))
    .sort((a, b) => (a.day === b.day ? b.totalTokens - a.totalTokens : a.day.localeCompare(b.day)));

  const hourBuckets = [...hourOfWeek.values()].sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour,
  );

  const projectBuckets = [...byProject.values()]
    .map((bucket) => ({
      ...toAggregate(bucket),
      projectId: bucket.projectId,
      projectTitle: bucket.projectId ? input.projectTitle(bucket.projectId) : null,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    totals: toAggregate(totals),
    byModel: modelBuckets,
    daily: dailyBuckets,
    hourOfWeek: hourBuckets,
    byProject: projectBuckets,
    unpricedModels: [...unpricedModels].sort(),
    pricingVersion: USAGE_PRICING_VERSION,
    earliestFactAt: input.earliestFactAt,
  } as UsageSummaryResponse;
}
