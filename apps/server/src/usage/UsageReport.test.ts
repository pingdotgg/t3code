import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  UsageLimitSourceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageBucket,
  type UsageLimitSourceSnapshot,
  type UsageSource,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageReport from "./UsageReport.ts";
import * as UsageService from "./UsageService.ts";

const checkedAt = "2026-10-21T10:00:00.000Z";

const limits: ServerProviderUsageLimits = {
  checkedAt,
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "5h",
      usedPercent: 27.6,
      resetsAt: "2026-10-21T12:00:00.000Z",
      windowDurationMins: 300,
    },
    { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 60 },
  ],
};

const provider = (id: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(id),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const bucket: UsageBucket = {
  day: UsageDay.make("2026-10-20"),
  provider: "codex",
  model: "gpt-5.5",
  totals: {
    uncachedInputTokens: 1_000,
    cachedInputTokens: 9_000,
    cacheCreationTokens: 0,
    outputTokens: 500,
    reasoningTokens: 200,
  },
  costUsd: 1.005,
  cacheSavingsUsd: 0.5,
  costSource: "modelPriced",
  records: 4,
  unpricedRecords: 0,
  sessions: 1,
};

const source = (usageProvider: UsageSource["fingerprint"]["provider"]): UsageSource => ({
  fingerprint: {
    hostId: "host",
    provider: usageProvider,
    resolvedHomePath: `/home/dev/.${usageProvider}`,
    volumeId: "1:1",
  },
  status: "ok",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 2,
  message: null,
});

const layerUsage = (requests: Array<UsageSummaryInput>): Layer.Layer<UsageService.UsageService> =>
  Layer.mock(UsageService.UsageService)({
    readSummary: (input) =>
      Effect.sync(() => {
        requests.push(input);
        return {
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: checkedAt,
          timeZone: input.timeZone,
          sinceDay: input.sinceDay,
          untilDay: input.untilDay,
          buckets: [bucket],
          sources: [source("codex")],
          pricing: { status: "fresh", source: "test", fetchedAt: checkedAt, knownModels: 1 },
          scanDurationMs: 0,
        };
      }),
  });

interface Dependencies {
  readonly registry?: Layer.Layer<ProviderRegistry.ProviderRegistry>;
  readonly sources?: ReadonlyArray<UsageLimitSourceSnapshot>;
  readonly usage?: Layer.Layer<UsageService.UsageService>;
}

const layerReport = (dependencies: Dependencies) =>
  UsageReport.layer.pipe(
    Layer.provide(dependencies.registry ?? ProviderRegistryMock.layer([])),
    Layer.provide(
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        current: Effect.succeed(dependencies.sources ?? []),
        refresh: Effect.void,
      }),
    ),
    Layer.provide(dependencies.usage ?? layerUsage([])),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("usage-report-test"),
          label: "Test environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      }),
    ),
  );

const readLimits = (dependencies: Dependencies) =>
  Effect.flatMap(UsageReport.UsageReport, (report) => report.readLimits({ refresh: false })).pipe(
    Effect.provide(layerReport(dependencies)),
  );

const readSpend = (dependencies: Dependencies, days: 1 | 7 | 30 | 90) =>
  Effect.flatMap(UsageReport.UsageReport, (report) =>
    report.readSpend({ days, refresh: false }),
  ).pipe(Effect.provide(layerReport(dependencies)));

it.effect("reads limits from the provider registry and limit hubs", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-21T12:00:00Z"));
    const report = yield* readLimits({
      registry: ProviderRegistryMock.layer([provider("claudeAgent", { usageLimits: limits })]),
      sources: [
        {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy",
          label: "Team hub",
          checkedAt,
          accounts: [
            {
              id: "codex-1.json",
              driver: ProviderDriverKind.make("codex"),
              usageLimits: limits,
            },
          ],
        },
      ],
    });

    assert.deepStrictEqual(report.providers, [
      {
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        driverKind: ProviderDriverKind.make("claudeAgent"),
        ageMins: 120,
        windows: [
          { kind: "session", label: "5h", remainingPercent: 72, resetsInMins: 0 },
          { kind: "weekly", label: "Weekly", remainingPercent: 40, resetsInMins: null },
        ],
        unavailable: null,
      },
    ]);
    assert.deepStrictEqual(
      report.pooledAccounts.map((account) => [account.source, account.accountId]),
      [["Team hub", "codex-1.json"]],
    );
  }),
);

it.effect("reads spend from the Usage tab's summary for the requested window", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-21T12:00:00Z"));
    const requests: Array<UsageSummaryInput> = [];
    const spend = yield* readSpend({ usage: layerUsage(requests) }, 7);

    assert.deepStrictEqual(
      [requests[0]?.sinceDay, requests[0]?.untilDay, requests[0]?.resolution],
      ["2026-10-15", "2026-10-21", "day"],
    );
    assert.deepStrictEqual(
      spend.providers.map((entry) => [entry.provider, entry.costUsd, entry.totalTokens]),
      [["codex", 1.01, 10_500]],
    );
  }),
);
