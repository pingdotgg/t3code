import { assert, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EnvironmentUsageMcpResult,
  ProviderInstanceId,
  ThreadId,
  UsageDay,
  UsageReadError,
  type UsageSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { UsageService } from "../usage/UsageService.ts";
import {
  EnvironmentUsageMcpService,
  layer as environmentUsageMcpLayer,
} from "./EnvironmentUsageMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const encodeEnvironmentUsageResult = Schema.encodeUnknownEffect(EnvironmentUsageMcpResult);
const environmentId = EnvironmentId.make("environment-usage-test");
const scope: McpInvocationScope = {
  environmentId,
  threadId: ThreadId.make("thread:environment-usage-test"),
  providerSessionId: "provider-session:environment-usage-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const input = {
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-31"),
  timeZone: "America/Los_Angeles",
  bucketLimit: 1,
} as const;

const summary = {
  contractVersion: 5,
  readAt: "2026-09-01T00:00:00.000Z",
  timeZone: input.timeZone,
  sinceDay: input.sinceDay,
  untilDay: input.untilDay,
  buckets: [
    {
      day: UsageDay.make("2026-08-02"),
      provider: "codex",
      model: "z-model",
      totals: {
        uncachedInputTokens: 4,
        cachedInputTokens: 3,
        cacheCreationTokens: 0,
        outputTokens: 2,
        reasoningTokens: 1,
      },
      costUsd: 0.2,
      cacheSavingsUsd: 0.1,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    },
    {
      day: UsageDay.make("2026-08-01"),
      provider: "claude",
      model: "😀".repeat(300),
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 0,
        cacheCreationTokens: 2,
        outputTokens: 5,
        reasoningTokens: 0,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      records: 2,
      unpricedRecords: 2,
      sessions: 1,
    },
  ],
  sources: [
    {
      fingerprint: {
        hostId: "secret-host",
        provider: "claude",
        resolvedHomePath: "/Users/secret/.claude/projects",
        volumeId: "16777234:12345",
      },
      status: "partial",
      scannedFiles: 3,
      skippedFiles: 1,
      malformedRecords: 2,
      distinctSessions: 2,
      message: "Raw failure at /Users/secret/.claude/projects/private.jsonl",
    },
    {
      fingerprint: {
        hostId: "secret-host",
        provider: "codex",
        resolvedHomePath: "/Users/secret/.codex/sessions",
        volumeId: "16777234:67890",
      },
      status: "failed",
      scannedFiles: 0,
      skippedFiles: 4,
      malformedRecords: 0,
      distinctSessions: 0,
      message: "Permission denied at /Users/secret/.codex/sessions",
    },
  ],
  pricing: {
    status: "cached",
    source: `https://pricing.example/${"😀".repeat(300)}`,
    fetchedAt: "2026-08-31T00:00:00.000Z",
    knownModels: 7,
  },
  scanDurationMs: 12,
} satisfies UsageSummary;

const environmentLayer = (id = environmentId) =>
  Layer.succeed(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(id),
      getDescriptor: Effect.die("usage must not load the environment descriptor"),
    }),
  );

const serviceLayer = (readSummary: UsageService["Service"]["readSummary"]) =>
  environmentUsageMcpLayer.pipe(
    Layer.provide(environmentLayer()),
    Layer.provide(Layer.succeed(UsageService, UsageService.of({ readSummary }))),
  );

it.effect(
  "returns a deterministic bounded page without source fingerprints or raw diagnostics",
  () =>
    Effect.gen(function* () {
      const observed = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const service = yield* EnvironmentUsageMcpService;
      const result = yield* service.read(scope, input);
      yield* encodeEnvironmentUsageResult(result);
      yield* Ref.update(observed, (values) => [...values, result]);

      expect(result.bucketTotal).toBe(2);
      expect(result.bucketNextCursor).toBe(1);
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0]).toMatchObject({
        day: "2026-08-01",
        provider: "claude",
        model: { characters: 300, maximumCharacters: 256, truncated: true },
        costSource: "unpriced",
        unpricedRecords: 2,
      });
      expect(Array.from(result.buckets[0]!.model.text)).toHaveLength(256);
      expect(result.sources).toEqual([
        {
          provider: "claude",
          status: "partial",
          scannedFiles: 3,
          skippedFiles: 1,
          malformedRecords: 2,
          distinctSessions: 2,
          message: {
            text: "Some provider transcript data could not be read.",
            characters: 48,
            maximumCharacters: 256,
            truncated: false,
          },
        },
        {
          provider: "codex",
          status: "failed",
          scannedFiles: 0,
          skippedFiles: 4,
          malformedRecords: 0,
          distinctSessions: 0,
          message: {
            text: "The provider transcript source could not be read.",
            characters: 49,
            maximumCharacters: 256,
            truncated: false,
          },
        },
      ]);
      expect(result.sources[0]).not.toHaveProperty("fingerprint");
      expect(result.sources[0]?.message?.text).not.toContain("/Users/secret");
      expect(result.pricing.source).toBe("litellm_public_model_prices");
      expect(result.pricing).not.toHaveProperty("url");
      expect(result.costMeaning).toBe("api_equivalent_estimate");
      expect(result.paginationConsistency).toBe("live_summary");
      expect(result.cacheBehavior).toBe("may_refresh_existing_usage_caches");
    }).pipe(Effect.provide(serviceLayer(() => Effect.succeed(summary)))),
);

it.effect("validates the complete bounded window before reading usage", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const service = yield* EnvironmentUsageMcpService;
    const invalidInputs = [
      { ...input, untilDay: UsageDay.make("2026-09-01") },
      { ...input, sinceDay: UsageDay.make("2026-08-31"), untilDay: UsageDay.make("2026-08-01") },
      { ...input, timeZone: "Not/A_Real_Zone" },
      {
        ...input,
        resolution: "hour" as const,
        sinceTime: "2026-08-01T00:00:00Z",
        untilTime: "2026-08-02T00:00:01Z",
      },
    ];

    for (const invalidInput of invalidInputs) {
      const failure = yield* service.read(scope, invalidInput).pipe(Effect.flip);
      assert.equal(failure.code, "invalid_request");
    }
    assert.equal(calls, 0);
  }).pipe(
    Effect.provide(
      serviceLayer(() =>
        Effect.sync(() => {
          calls += 1;
          return summary;
        }),
      ),
    ),
  );
});

it.effect("denies missing capability and environment mismatch before the usage scan", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const usageLayer = Layer.succeed(
      UsageService,
      UsageService.of({
        readSummary: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(summary)),
      }),
    );
    const makeService = (id: typeof environmentId) =>
      environmentUsageMcpLayer.pipe(Layer.provide(environmentLayer(id)), Layer.provide(usageLayer));

    const denied = yield* EnvironmentUsageMcpService.pipe(
      Effect.flatMap((service) =>
        service.read({ ...scope, capabilities: new Set() }, input).pipe(Effect.flip),
      ),
      Effect.provide(makeService(environmentId)),
    );
    assert.equal(denied.code, "capability_denied");

    const mismatch = yield* EnvironmentUsageMcpService.pipe(
      Effect.flatMap((service) => service.read(scope, input).pipe(Effect.flip)),
      Effect.provide(makeService(EnvironmentId.make("different-environment"))),
    );
    assert.equal(mismatch.code, "environment_mismatch");
    assert.equal(yield* Ref.get(calls), 0);
  }),
);

it.effect("maps usage scan failures to a finite public reason", () =>
  Effect.gen(function* () {
    const service = yield* EnvironmentUsageMcpService;
    const failure = yield* service.read(scope, input).pipe(Effect.flip);
    assert.equal(failure.code, "usage_unavailable");
    expect(failure).not.toHaveProperty("cause");
    expect(failure.message).toBe("Environment usage could not be read.");
  }).pipe(
    Effect.provide(
      serviceLayer(() =>
        Effect.fail(
          new UsageReadError({
            reason: "scanFailed",
            detail: "Raw provider error at /Users/secret/.codex/sessions",
            cause: new Error("private stack"),
          }),
        ),
      ),
    ),
  ),
);

it.effect("preserves the usage service invalid-window classification", () =>
  Effect.gen(function* () {
    const service = yield* EnvironmentUsageMcpService;
    const failure = yield* service.read(scope, input).pipe(Effect.flip);
    assert.equal(failure.code, "invalid_request");
  }).pipe(
    Effect.provide(
      serviceLayer(() =>
        Effect.fail(
          new UsageReadError({
            reason: "invalidWindow",
            detail: "The underlying service rejected this window.",
          }),
        ),
      ),
    ),
  ),
);
