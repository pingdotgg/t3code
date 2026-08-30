import {
  ENVIRONMENT_USAGE_MCP_DEFAULT_BUCKET_LIMIT,
  ENVIRONMENT_USAGE_MCP_MAX_DAYS,
  ENVIRONMENT_USAGE_MCP_MAX_TEXT_CHARACTERS,
  EnvironmentUsageMcpFailure,
  type EnvironmentUsageMcpInput,
  type EnvironmentUsageMcpResult,
  type EnvironmentUsageMcpSource,
  type EnvironmentUsageMcpTextWindow,
  type UsageBucket,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { UsageService } from "../usage/UsageService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_HOURLY_WINDOW_MS = DAY_MS;
const MAX_TIME_ZONE_CHARACTERS = 128;

export class EnvironmentUsageMcpService extends Context.Service<
  EnvironmentUsageMcpService,
  {
    readonly read: (
      scope: McpInvocationScope,
      input: EnvironmentUsageMcpInput,
    ) => Effect.Effect<EnvironmentUsageMcpResult, EnvironmentUsageMcpFailure>;
  }
>()("t3/mcp/EnvironmentUsageMcpService") {}

const textWindow = (
  value: string,
  maximumCharacters = ENVIRONMENT_USAGE_MCP_MAX_TEXT_CHARACTERS,
): EnvironmentUsageMcpTextWindow => {
  const characters = Array.from(value);
  return {
    text: characters.slice(0, maximumCharacters).join(""),
    characters: characters.length,
    maximumCharacters,
    truncated: characters.length > maximumCharacters,
  };
};

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const compareBuckets = (left: UsageBucket, right: UsageBucket) =>
  compareText(left.day, right.day) ||
  compareText(left.hourStart ?? "", right.hourStart ?? "") ||
  compareText(left.provider, right.provider) ||
  compareText(left.model, right.model);

const safeSourceMessage = (
  status: EnvironmentUsageMcpSource["status"],
): EnvironmentUsageMcpTextWindow | null => {
  switch (status) {
    case "ok":
      return null;
    case "missing":
      return textWindow("The provider transcript source is not present on this environment.");
    case "partial":
      return textWindow("Some provider transcript data could not be read.");
    case "failed":
      return textWindow("The provider transcript source could not be read.");
  }
};

const validDay = (day: string) =>
  DateTime.make(`${day}T00:00:00Z`).pipe(
    Option.filter((dateTime) => DateTime.formatIsoDateUtc(dateTime) === day),
  );

const validateTimeZone = (timeZone: string) =>
  Effect.try({
    try: () => {
      if (Array.from(timeZone).length > MAX_TIME_ZONE_CHARACTERS) throw new Error();
      void new Intl.DateTimeFormat("en-US", { timeZone });
    },
    catch: () => new EnvironmentUsageMcpFailure({ code: "invalid_request" }),
  });

const validateInput = Effect.fn("EnvironmentUsageMcpService.validateInput")(function* (
  input: EnvironmentUsageMcpInput,
): Effect.fn.Return<UsageSummaryInput, EnvironmentUsageMcpFailure> {
  const sinceDay = validDay(input.sinceDay);
  const untilDay = validDay(input.untilDay);
  if (Option.isNone(sinceDay) || Option.isNone(untilDay)) {
    return yield* new EnvironmentUsageMcpFailure({ code: "invalid_request" });
  }

  const daySpan =
    (DateTime.toEpochMillis(untilDay.value) - DateTime.toEpochMillis(sinceDay.value)) / DAY_MS + 1;
  if (daySpan < 1 || daySpan > ENVIRONMENT_USAGE_MCP_MAX_DAYS) {
    return yield* new EnvironmentUsageMcpFailure({ code: "invalid_request" });
  }
  yield* validateTimeZone(input.timeZone);

  const resolution = input.resolution ?? "day";
  if (resolution === "hour") {
    if (input.sinceTime === undefined || input.untilTime === undefined) {
      return yield* new EnvironmentUsageMcpFailure({ code: "invalid_request" });
    }
    const sinceTime = DateTime.make(input.sinceTime);
    const untilTime = DateTime.make(input.untilTime);
    if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
      return yield* new EnvironmentUsageMcpFailure({ code: "invalid_request" });
    }
    const durationMs =
      DateTime.toEpochMillis(untilTime.value) - DateTime.toEpochMillis(sinceTime.value);
    if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
      return yield* new EnvironmentUsageMcpFailure({ code: "invalid_request" });
    }
  }

  return {
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution,
    ...(resolution === "hour" ? { sinceTime: input.sinceTime, untilTime: input.untilTime } : {}),
  };
});

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const usage = yield* UsageService;

  const requireScope = Effect.fn("EnvironmentUsageMcpService.requireScope")(function* (
    scope: McpInvocationScope,
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* new EnvironmentUsageMcpFailure({ code: "capability_denied" });
    }
    const environmentId = yield* environment.getEnvironmentId.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause).pipe(Effect.orDie)
          : Effect.fail(new EnvironmentUsageMcpFailure({ code: "environment_unavailable" })),
      ),
    );
    if (environmentId !== scope.environmentId) {
      return yield* new EnvironmentUsageMcpFailure({ code: "environment_mismatch" });
    }
  });

  const read: EnvironmentUsageMcpService["Service"]["read"] = Effect.fn(
    "EnvironmentUsageMcpService.read",
  )(function* (scope, input) {
    yield* requireScope(scope);
    const summaryInput = yield* validateInput(input);
    const summary = yield* usage.readSummary(summaryInput).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterrupts(cause)) {
            return yield* Effect.failCause(cause).pipe(Effect.orDie);
          }
          const usageError = Option.getOrUndefined(Cause.findErrorOption(cause));
          if (usageError?.reason === "invalidWindow") {
            return yield* new EnvironmentUsageMcpFailure({ code: "invalid_request" });
          }
          yield* Effect.logWarning("environment usage service failed", { cause });
          return yield* new EnvironmentUsageMcpFailure({ code: "usage_unavailable" });
        }),
      ),
    );

    const cursor = input.bucketCursor ?? 0;
    const limit = input.bucketLimit ?? ENVIRONMENT_USAGE_MCP_DEFAULT_BUCKET_LIMIT;
    const buckets = [...summary.buckets].sort(compareBuckets);
    const page = buckets.slice(cursor, cursor + limit).map((bucket) => ({
      day: bucket.day,
      hourStart: bucket.hourStart ?? null,
      provider: bucket.provider,
      model: textWindow(bucket.model),
      totals: bucket.totals,
      costUsd: bucket.costUsd,
      cacheSavingsUsd: bucket.cacheSavingsUsd,
      costSource: bucket.costSource,
      records: bucket.records,
      unpricedRecords: bucket.unpricedRecords,
      sessions: bucket.sessions,
    }));
    const nextCursor = cursor + page.length < buckets.length ? cursor + page.length : null;

    const sources = summary.sources
      .map((source) => ({
        provider: source.fingerprint.provider,
        status: source.status,
        scannedFiles: source.scannedFiles,
        skippedFiles: source.skippedFiles,
        malformedRecords: source.malformedRecords,
        distinctSessions: source.distinctSessions,
        message: safeSourceMessage(source.status),
      }))
      .sort((left, right) => compareText(left.provider, right.provider))
      .slice(0, 3);

    return {
      readAt: summary.readAt,
      timeZone: summary.timeZone,
      sinceDay: summary.sinceDay,
      untilDay: summary.untilDay,
      resolution: summaryInput.resolution ?? "day",
      buckets: page,
      bucketCursor: cursor,
      bucketNextCursor: nextCursor,
      bucketTotal: buckets.length,
      sources,
      pricing: {
        status: summary.pricing.status,
        source: "litellm_public_model_prices",
        fetchedAt: summary.pricing.fetchedAt,
        knownModels: summary.pricing.knownModels,
      },
      scanDurationMs: summary.scanDurationMs,
      costMeaning: "api_equivalent_estimate",
      paginationConsistency: "live_summary",
      cacheBehavior: "may_refresh_existing_usage_caches",
    };
  });

  return { read } as const;
});

export const layer = Layer.effect(EnvironmentUsageMcpService, make);
