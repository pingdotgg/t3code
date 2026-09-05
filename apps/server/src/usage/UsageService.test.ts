// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { ThreadId, UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

function claudeLine(
  id: number,
  outputTokens: number,
  model = "claude-fable-5",
  cwd?: string,
): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    ...(cwd === undefined ? {} : { cwd }),
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

function codexRollout(sessionId: string, cwd: string, outputTokens: number): string {
  return [
    {
      type: "session_meta",
      timestamp: "2026-08-01T10:00:00Z",
      payload: { type: "session_meta", id: sessionId, cwd },
    },
    {
      type: "turn_context",
      timestamp: "2026-08-01T10:00:01Z",
      payload: { type: "turn_context", model: "gpt-5.2-codex" },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-01T10:00:05Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 100, output_tokens: outputTokens } },
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
}

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const NARROW_WINDOW: UsageSummaryInput = {
  ...WINDOW,
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-01"),
};

const setup = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const transcriptDir = NodePath.join(home, "claude", "projects", "proj");
  yield* Effect.promise(() => NodeFSP.mkdir(transcriptDir, { recursive: true }));
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    settings: {
      providers: {
        claudeAgent: { homePath: NodePath.join(home, "claude") },
        codex: { homePath: NodePath.join(home, "codex") },
      },
    },
  };
});

const serviceLayers = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: () => void;
  /** Defaults to an unparsable document so every scan retries the fetch. */
  readonly ratesDocument?: unknown;
  readonly projectRepository?: ProjectionProjectRepository["Service"];
  readonly runtimeRepository?: ProviderSessionRuntime.ProviderSessionRuntimeRepository["Service"];
}) =>
  ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            input.onRatesFetch?.();
            // Unparsable rates: every scan retries the fetch, which makes the
            // fetch count a boundary-level observation of how many scans ran.
            return HttpClientResponse.fromWeb(request, Response.json(input.ratesDocument ?? {}));
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcessEnvironment, { GROK_HOME: NodePath.join(input.home, "grok") }),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        input.projectRepository === undefined
          ? ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))
          : Layer.succeed(ProjectionProjectRepository, input.projectRepository),
        ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
        input.runtimeRepository === undefined
          ? ProviderSessionRuntime.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory))
          : Layer.succeed(
              ProviderSessionRuntime.ProviderSessionRuntimeRepository,
              input.runtimeRepository,
            ),
        SqlitePersistenceMemory,
      ),
    ),
  );

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService", () => {
  it.live("does not parse unrelated Codex token content for a targeted thread read", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const sessionsDir = NodePath.join(home, "codex", "sessions", "2026", "08", "01");
      yield* Effect.promise(() => NodeFSP.mkdir(sessionsDir, { recursive: true }));
      const targetPath = NodePath.join(
        sessionsDir,
        "rollout-2026-08-01T10-00-00-target-session.jsonl",
      );
      const unrelatedPath = NodePath.join(
        sessionsDir,
        "rollout-2026-08-01T10-00-00-unrelated-session.jsonl",
      );
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.writeFile(targetPath, codexRollout("target-session", "/work/target", 7)),
          NodeFSP.writeFile(unrelatedPath, codexRollout("unrelated-session", "/work/other", 999)),
        ]),
      );

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        yield* runtimeRepository.upsert({
          threadId: ThreadId.make("target-thread"),
          providerName: "codex",
          providerInstanceId: null,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: "2026-08-01T10:00:00.000Z",
          resumeCursor: { threadId: "target-session" },
          runtimePayload: null,
        });
        const service = yield* UsageService.make;
        const breakdown = yield* service.readThreadBreakdown({
          ...WINDOW,
          threadId: ThreadId.make("target-thread"),
        });
        assert.strictEqual(breakdown.rows.length, 1);
        assert.strictEqual(breakdown.rows[0]?.totals.outputTokens, 7);

        const persisted = (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(config.stateDir, "usage-scan-cache.json"), "utf8"),
          ),
        )) as { files: Record<string, unknown>; identities: Record<string, unknown> };
        assert.deepStrictEqual(Object.keys(persisted.files), [targetPath]);
        assert.deepStrictEqual(
          Object.keys(persisted.identities).sort(),
          [targetPath, unrelatedPath].sort(),
        );
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-target-prefilter-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("filters a targeted thread from the summary's cached source snapshot", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const sessionsDir = NodePath.join(home, "codex", "sessions", "2026", "08", "01");
      yield* Effect.promise(() => NodeFSP.mkdir(sessionsDir, { recursive: true }));
      const targetPath = NodePath.join(sessionsDir, "rollout-opaque-target.jsonl");
      const unrelatedPath = NodePath.join(sessionsDir, "rollout-opaque-unrelated.jsonl");
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.writeFile(targetPath, codexRollout("target-session", "/work/target", 7)),
          NodeFSP.writeFile(unrelatedPath, codexRollout("unrelated-session", "/work/other", 999)),
        ]),
      );

      yield* Effect.gen(function* () {
        const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        yield* runtimeRepository.upsert({
          threadId: ThreadId.make("target-thread"),
          providerName: "codex",
          providerInstanceId: null,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: "2026-08-01T10:00:00.000Z",
          resumeCursor: { threadId: "target-session" },
          runtimePayload: null,
        });
        const service = yield* UsageService.make;
        const summary = yield* service.readSummary(WINDOW);
        yield* Effect.promise(() =>
          Promise.all([
            NodeFSP.appendFile(
              targetPath,
              `\n${codexRollout("target-session", "/work/target", 70)}`,
            ),
            NodeFSP.appendFile(
              unrelatedPath,
              `\n${codexRollout("unrelated-session", "/work/other", 9_999)}`,
            ),
          ]),
        );
        const breakdown = yield* service.readThreadBreakdown({
          ...WINDOW,
          threadId: ThreadId.make("target-thread"),
        });

        assert.strictEqual(breakdown.rows.length, 1);
        assert.strictEqual(breakdown.rows[0]?.totals.outputTokens, 7);
        assert.strictEqual(breakdown.readAt, summary.readAt);
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-target-cached-snapshot-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reprices unchanged transcripts when custom prices are added, edited, or removed", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make;

        const original = yield* service.readSummary(WINDOW);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.strictEqual(original.buckets[0]?.unpricedRecords, 1);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const overridden = yield* service.readSummary(WINDOW);
        assert.closeTo(overridden.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
        assert.strictEqual(overridden.buckets[0]?.costSource, "modelPriced");
        assert.strictEqual(overridden.buckets[0]?.unpricedRecords, 0);
        assert.deepStrictEqual(overridden.buckets[0]?.totals, original.buckets[0]?.totals);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 16 },
          },
        });
        const edited = yield* service.readSummary(WINDOW);
        assert.closeTo(edited.buckets[0]?.costUsd ?? -1, 0.00012, 1e-12);

        yield* settingsService.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, original.buckets);
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-price-overrides-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("counts appended usage on a rescan of a grown transcript", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-grow-test", home, settings })),
      );

      const first = yield* service.readSummary(NARROW_WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      // Expanding beyond the cached coverage requires a source update. The
      // grown transcript resumes at its cached byte position.
      const second = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(second), 12);
    }).pipe(Effect.scoped),
  );

  it.live("replaces a cached progressive snapshot when a transcript grows", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-progressive-test", home, settings })),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(1, 12)));
      const second = yield* service.readSummary({ ...WINDOW, refreshToken: "progressive-final" });
      assert.strictEqual(totalOutputTokens(second), 12);
    }).pipe(Effect.scoped),
  );

  it.live("keeps project attribution unknown when the project repository cannot be read", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(transcript, claudeLine(1, 5, "claude-fable-5", "/work/app")),
      );
      const repositoryFailure = Effect.fail(
        new PersistenceSqlError({ operation: "ProjectionProjectRepository.listAll:test" }),
      );
      const projectRepository: ProjectionProjectRepository["Service"] = {
        upsert: () => repositoryFailure,
        getById: () => repositoryFailure,
        listAll: () => repositoryFailure,
        deleteById: () => repositoryFailure,
      };
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-project-failure-test",
            home,
            settings,
            projectRepository,
          }),
        ),
      );

      const summary = yield* service.readSummary(WINDOW);
      assert.strictEqual(summary.buckets[0]?.projectAttribution, "unknown");
    }).pipe(Effect.scoped),
  );

  it.live("does not hide a project repository defect as unknown attribution", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const defect = new Error("project repository defect");
      const repositoryDefect = Effect.die(defect);
      const projectRepository: ProjectionProjectRepository["Service"] = {
        upsert: () => repositoryDefect,
        getById: () => repositoryDefect,
        listAll: () => repositoryDefect,
        deleteById: () => repositoryDefect,
      };

      const exit = yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        return yield* Effect.exit(service.readSummary(WINDOW));
      }).pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-project-defect-test",
            home,
            settings,
            projectRepository,
          }),
        ),
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.strictEqual(Cause.squash(exit.cause), defect);
    }).pipe(Effect.scoped),
  );

  it.live("returns a usage read error when provider runtime state cannot be read", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const repositoryFailure = Effect.die(new Error("runtime repository unavailable"));
      const runtimeRepository: ProviderSessionRuntime.ProviderSessionRuntimeRepository["Service"] =
        {
          upsert: () => repositoryFailure,
          getByThreadId: () => repositoryFailure,
          list: () => repositoryFailure,
          deleteByThreadId: () => repositoryFailure,
        };
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-runtime-failure-test",
            home,
            settings,
            runtimeRepository,
          }),
        ),
      );

      const error = yield* service.readThreadBreakdown(WINDOW).pipe(Effect.flip);
      assert.strictEqual(error.reason, "scanFailed");
      assert.strictEqual(error.detail, "Provider runtime state could not be read");
    }).pipe(Effect.scoped),
  );

  it.live("does not share an in-flight scan after custom prices change", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const firstScanStarted = yield* Deferred.make<void>();
        const releaseRates = yield* Deferred.make<void>();
        const service = yield* UsageService.make.pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Deferred.succeed(firstScanStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRates)),
                Effect.as(HttpClientResponse.fromWeb(request, Response.json({}))),
              ),
            ),
          ),
        );

        const first = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(firstScanStarted);
        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const second = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseRates, undefined);

        const original = yield* Fiber.join(first);
        const updated = yield* Fiber.join(second);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.closeTo(updated.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
      }).pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-price-race-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("shares one scan between concurrent identical requests", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-flight-test",
            home,
            settings,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const [first, second] = yield* Effect.all(
        [service.readSummary(WINDOW), service.readSummary(WINDOW)],
        { concurrency: 2 },
      );
      assert.deepStrictEqual(first, second);
      assert.strictEqual(ratesFetches, 1);

      // A later request within the freshness window reuses the source snapshot.
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);
    }).pipe(Effect.scoped),
  );

  it.live("reuses a recent scan when only the date range changes", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-window-cache-test",
            home,
            settings,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      yield* service.readSummary(WINDOW);
      const narrower = yield* service.readSummary(NARROW_WINDOW);

      assert.strictEqual(totalOutputTokens(narrower), 5);
      assert.strictEqual(ratesFetches, 1);
    }).pipe(Effect.scoped),
  );

  it.live("folds thread rows from the same source snapshot as the summary", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const summary = yield* service.readSummary(WINDOW);
        yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
        const breakdown = yield* service.readThreadBreakdown(WINDOW);

        assert.strictEqual(totalOutputTokens(summary), 5);
        assert.strictEqual(
          breakdown.rows.reduce((total, row) => total + row.totals.outputTokens, 0),
          5,
        );
        assert.strictEqual(breakdown.readAt, summary.readAt);
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-thread-source-cache-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("updates fresh source data for a new manual refresh token", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-manual-refresh-test",
            home,
            settings,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      const refreshedInput = { ...WINDOW, refreshToken: "manual-refresh-1" };
      const refreshed = yield* service.readSummary(refreshedInput);

      assert.strictEqual(totalOutputTokens(refreshed), 12);
      assert.strictEqual(ratesFetches, 2);

      yield* service.readSummary(refreshedInput);
      assert.strictEqual(ratesFetches, 2);
    }).pipe(Effect.scoped),
  );

  it.live("refetches a rate table inside its TTL only when the client asks", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-rates-refresh-test",
            home,
            settings,
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);
      assert.strictEqual(first.pricing.status, "fresh");

      // Inside the daily TTL a plain rescan keeps the cached table.
      yield* TestClock.adjust(Duration.minutes(2));
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);

      // An explicit refresh fetches again so a newly listed model gets priced.
      // A burst of refreshes shares that one fetch.
      const [refreshed] = yield* Effect.all([service.refreshRates, service.refreshRates], {
        concurrency: 2,
      });
      assert.strictEqual(ratesFetches, 2);
      assert.strictEqual(refreshed.status, "fresh");
      assert.strictEqual(refreshed.knownModels, 1);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not orphan an in-flight scan when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-interruption-test", home, settings }),
        ),
      );

      let orphanedAt: number | undefined;
      for (let interruptAt = 1; interruptAt <= 31; interruptAt += 1) {
        const tasks: Array<() => void> = [];
        const dispatcher: Scheduler.SchedulerDispatcher = {
          scheduleTask: (task) => tasks.push(task),
          flush: () => {
            let task: (() => void) | undefined;
            while ((task = tasks.shift()) !== undefined) task();
          },
        };

        let requestFiber: Fiber.Fiber<unknown, unknown> | undefined;
        let requestChecks = 0;
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => dispatcher,
          shouldYield: (fiber) => {
            if (fiber !== requestFiber) return false;
            requestChecks += 1;
            if (requestChecks !== interruptAt) return false;
            fiber.interruptUnsafe();
            return true;
          },
        };

        // Each candidate needs a distinct key because the broken case leaves
        // its entry in the service's private in-flight map. The invalid window
        // keeps the real scan synchronous once its detached fiber starts.
        const input: UsageSummaryInput = {
          ...WINDOW,
          sinceDay: UsageDay.make("2026-09-01"),
          untilDay: UsageDay.make(`2026-08-${String(interruptAt).padStart(2, "0")}`),
        };
        const first = yield* service
          .readSummary(input)
          .pipe(
            Effect.exit,
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild,
          );
        requestFiber = first;
        yield* Effect.yieldNow;
        dispatcher.flush();

        const second = yield* service.readSummary(input).pipe(
          Effect.match({
            onFailure: (error) => error.reason,
            onSuccess: () => "success" as const,
          }),
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        dispatcher.flush();
        const secondExit = second.pollUnsafe();
        if (secondExit === undefined) {
          second.interruptUnsafe();
          orphanedAt = interruptAt;
          break;
        }
        if (Exit.isFailure(secondExit)) {
          assert.fail("the matching request fiber was interrupted");
        }
        assert.strictEqual(secondExit.value, "invalidWindow");
      }

      assert.isUndefined(
        orphanedAt,
        `interruption left the next matching request pending at scheduler check ${orphanedAt}`,
      );
    }).pipe(Effect.scoped),
  );

  it.live("rejects exact thread windows longer than 24 hours", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-thread-window-test", home, settings }),
        ),
      );
      const reason = yield* service
        .readThreadBreakdown({
          timeZone: "UTC",
          sinceDay: UsageDay.make("2026-08-01"),
          untilDay: UsageDay.make("2026-08-02"),
          sinceTime: "2026-08-01T00:00:00.000Z",
          untilTime: "2026-08-02T01:00:00.000Z",
        })
        .pipe(
          Effect.match({
            onFailure: (error) => error.reason,
            onSuccess: () => "success" as const,
          }),
        );

      assert.strictEqual(reason, "invalidWindow");
    }).pipe(Effect.scoped),
  );
});

describe("isValidUsageDay", () => {
  it("rejects impossible start and end dates instead of normalising them", () => {
    assert.isTrue(UsageService.isValidUsageDay("2026-02-28"));
    assert.isFalse(UsageService.isValidUsageDay("2026-02-29"));
    assert.isFalse(UsageService.isValidUsageDay("2026-13-01"));
  });
});

describe("shortSessionLabel", () => {
  it("never exposes a file-derived path", () => {
    assert.strictEqual(
      UsageService.shortSessionLabel("claude:file:session-dir:updates"),
      "Untitled session",
    );
  });
});

describe("runtimeUsageSessionKey", () => {
  it("maps every provider with usage transcripts to its persisted session cursor", () => {
    assert.strictEqual(
      UsageService.runtimeUsageSessionKey("claudeAgent", { resume: "claude-session" }),
      "claude:claude-session",
    );
    assert.strictEqual(
      UsageService.runtimeUsageSessionKey("codex", { threadId: "codex-session" }),
      "codex:codex-session",
    );
    assert.strictEqual(
      UsageService.runtimeUsageSessionKey("grok", { schemaVersion: 1, sessionId: "grok-session" }),
      "grok:grok-session",
    );
  });

  it("includes provider sessions replaced by later model switches", () => {
    assert.deepEqual(
      UsageService.runtimeUsageSessionKeys(
        "codex",
        { threadId: "current-session" },
        {
          _t3PreviousResumeCursors: [
            { providerName: "codex", resumeCursor: { threadId: "previous-session" } },
          ],
        },
      ),
      ["codex:current-session", "codex:previous-session"],
    );
  });

  it("ignores providers and cursors without a usage transcript session", () => {
    assert.isNull(UsageService.runtimeUsageSessionKey("opencode", { sessionId: "session" }));
    assert.isNull(UsageService.runtimeUsageSessionKey("grok", { sessionId: "" }));
    assert.isNull(UsageService.runtimeUsageSessionKey("grok", null));
  });
});

describe("transcriptFileMayMatchThread", () => {
  const target: UsageService.ThreadTranscriptTarget = {
    sessionIds: new Map([
      ["claude", new Set(["claude-session"])],
      ["codex", new Set(["codex-session"])],
      ["grok", new Set(["grok-session"])],
    ]),
    worktrees: new Set(["/work/app/.wt/thread-1"]),
  };

  const matches = (
    provider: "claude" | "codex" | "grok",
    filePath: string,
    root: string,
    options?: {
      readonly cached?: { readonly size: number; readonly mtimeMs: number };
      readonly identity?: { readonly sessionId: string; readonly cwd: string };
    },
  ) =>
    UsageService.transcriptFileMayMatchThread({
      path: NodePath,
      provider,
      filePath,
      root,
      target,
      ...(options?.cached === undefined
        ? {}
        : { cached: { ...options.cached, records: [], tailRecords: [] } }),
      ...(options?.identity === undefined ? {} : { identity: options.identity }),
    });

  it("selects provider files from current and historic session ids", () => {
    assert.isTrue(matches("claude", "/claude/project/claude-session.jsonl", "/claude"));
    assert.isTrue(
      matches("claude", "/claude/project/claude-session/subagents/agent-a.jsonl", "/claude"),
    );
    assert.isTrue(
      matches("codex", "/codex/2026/09/rollout-2026-09-05T12-00-00-codex-session.jsonl", "/codex"),
    );
    assert.isTrue(matches("grok", "/grok/cwd/grok-session/updates.jsonl", "/grok"));
    assert.isFalse(matches("claude", "/claude/project/other-session.jsonl", "/claude"));
  });

  it("selects Claude and Grok files by their encoded dedicated worktree", () => {
    assert.isTrue(
      matches("claude", "/claude/-work-app--wt-thread-1/legacy-session.jsonl", "/claude"),
    );
    assert.isTrue(
      matches("grok", "/grok/%2Fwork%2Fapp%2F.wt%2Fthread-1/legacy-session/updates.jsonl", "/grok"),
    );
  });

  it("matches encoded Claude worktrees case-insensitively only for Windows paths", () => {
    const windowsTarget: UsageService.ThreadTranscriptTarget = {
      sessionIds: new Map(),
      worktrees: new Set(["C:/Users/Alex/App/.wt/Thread-1"]),
    };
    const matchesTarget = (filePath: string, target: UsageService.ThreadTranscriptTarget) =>
      UsageService.transcriptFileMayMatchThread({
        path: NodePath,
        provider: "claude",
        filePath,
        root: "/claude",
        target,
      });

    assert.isTrue(
      matchesTarget("/claude/C--Users-Alex-App--wt-Thread-1/legacy-session.jsonl", windowsTarget),
    );
    assert.isTrue(
      matchesTarget("/claude/c--users-alex-app--wt-thread-1/legacy-session.jsonl", windowsTarget),
    );
    assert.isTrue(
      matchesTarget("/claude/C--Users-Alex-App--wt-Thread-1/legacy-session.jsonl", {
        ...windowsTarget,
        worktrees: new Set(["c:/users/alex/app/.wt/thread-1"]),
      }),
    );
    assert.isFalse(matchesTarget("/claude/-Work-App--wt-thread-1/legacy-session.jsonl", target));
  });

  it("selects Codex rollouts from their bounded session metadata", () => {
    const path = "/codex/2026/09/rollout-2026-09-05T12-00-00-other-session.jsonl";
    assert.isFalse(matches("codex", path, "/codex"));
    assert.isTrue(
      matches("codex", path, "/codex", {
        identity: { sessionId: "other-session", cwd: "/work/app/.wt/thread-1" },
      }),
    );
    assert.isFalse(
      matches("codex", path, "/codex", {
        identity: { sessionId: "other-session", cwd: "/work/app/.wt/thread-2" },
      }),
    );
  });
});
