// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
// @effect-diagnostics globalDateInEffect:off - fixed wall-clock test fixtures and
// scan-start assertions intentionally use JavaScript Date boundaries.
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { ProjectId, ThreadId, UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

function claudeLine(
  id: number,
  outputTokens: number,
  timestampOrModel = "2026-08-01T10:00:00Z",
  messageIdOrCwd?: string,
  requestIdOverride?: string,
): string {
  const hasTimestamp = /^\d{4}-\d{2}-\d{2}T/.test(timestampOrModel);
  const timestamp = hasTimestamp ? timestampOrModel : "2026-08-01T10:00:00Z";
  const model = hasTimestamp ? "claude-fable-5" : timestampOrModel;
  const messageId = hasTimestamp ? (messageIdOrCwd ?? `msg_${id}`) : `msg_${id}`;
  const requestId = hasTimestamp ? (requestIdOverride ?? `req_${id}`) : `req_${id}`;
  const cwd = hasTimestamp ? undefined : messageIdOrCwd;
  return `${JSON.stringify({
    type: "assistant",
    timestamp,
    requestId,
    sessionId: "session-1",
    ...(cwd === undefined ? {} : { cwd }),
    message: {
      id: messageId,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

function claudeModelLine(
  id: number,
  outputTokens: number,
  model: string,
  timestamp = "2026-08-01T10:00:00Z",
  reportedCostUsd?: number,
): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp,
    requestId: `req_${id}`,
    sessionId: "session-1",
    ...(reportedCostUsd === undefined ? {} : { costUSD: reportedCostUsd }),
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

function claudeCacheLine(
  id: number,
  timestamp: string,
  cwd: string,
  cacheCreation5mTokens: number,
  cacheCreation1hTokens: number,
): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp,
    requestId: `req_${id}`,
    sessionId: `session-${id}`,
    cwd,
    message: {
      id: `msg_${id}`,
      model: "claude-fable-5",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: cacheCreation5mTokens + cacheCreation1hTokens,
        cache_creation: {
          ephemeral_5m_input_tokens: cacheCreation5mTokens,
          ephemeral_1h_input_tokens: cacheCreation1hTokens,
        },
      },
    },
  })}\n`;
}

function codexRollout(
  sessionId: string,
  cwd: string,
  outputTokens: number,
  timestamp?: string,
): string {
  return [
    {
      type: "session_meta",
      timestamp: timestamp ?? "2026-08-01T10:00:00Z",
      payload: { type: "session_meta", id: sessionId, cwd },
    },
    {
      type: "turn_context",
      timestamp: timestamp ?? "2026-08-01T10:00:01Z",
      payload: { type: "turn_context", model: "gpt-5.2-codex" },
    },
    {
      type: "event_msg",
      timestamp: timestamp ?? "2026-08-01T10:00:05Z",
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
  readonly baseDir?: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: () => void;
  readonly ratesDocument?: unknown;
  readonly ratesGate?: Deferred.Deferred<void, never>;
  readonly ratesStarted?: Deferred.Deferred<void, never>;
  readonly projectRepository?: ProjectionProjectRepository["Service"];
  readonly runtimeRepository?: ProviderSessionRuntime.ProviderSessionRuntimeRepository["Service"];
}) =>
  ServerConfig.layerTest(process.cwd(), input.baseDir ?? { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            input.onRatesFetch?.();
            if (input.ratesStarted !== undefined) {
              yield* Deferred.succeed(input.ratesStarted, undefined);
            }
            if (input.ratesGate !== undefined) {
              yield* Deferred.await(input.ratesGate);
            }
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

function currentCanonicalWindow(timeZone = "UTC"): UsageSummaryInput {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const untilMs = Date.parse(
    new Date(Date.parse(`${today}T00:00:00Z`) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
  return {
    timeZone,
    sinceDay: UsageDay.make(
      new Date(untilMs - 89 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    ),
    untilDay: UsageDay.make(new Date(untilMs).toISOString().slice(0, 10)),
    resolution: "day",
  };
}

describe("UsageService", () => {
  it.live("scans a current common preset on its first read", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const canonical = currentCanonicalWindow();
      yield* Effect.promise(() =>
        NodeFSP.writeFile(transcript, claudeLine(1, 5, `${canonical.sinceDay}T10:00:00Z`)),
      );
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-first-preset-test", home, settings }),
        ),
      );

      const result = yield* service.readSummary(canonical);

      assert.strictEqual(totalOutputTokens(result), 5);
    }).pipe(Effect.scoped),
  );

  for (const refreshToken of [undefined, "turn-refresh"]) {
    it.live(
      `does not parse unrelated Codex token content for a targeted thread read (${refreshToken ?? "initial"})`,
      () =>
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
              NodeFSP.writeFile(
                unrelatedPath,
                codexRollout("unrelated-session", "/work/other", 999),
              ),
            ]),
          );

          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const runtimeRepository =
              yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
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
              ...(refreshToken === undefined ? {} : { refreshToken }),
            });
            assert.strictEqual(breakdown.rows.length, 1);
            assert.strictEqual(breakdown.rows[0]?.totals.outputTokens, 7);

            const persisted = (yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Unknown),
            )(
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
  }

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

        const refreshed = yield* service.readThreadBreakdown({
          ...WINDOW,
          threadId: ThreadId.make("target-thread"),
          refreshToken: "completed-turn",
        });
        assert.strictEqual(refreshed.rows.length, 1);
        assert.strictEqual(refreshed.rows[0]?.totals.outputTokens, 77);
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-target-cached-snapshot-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("refreshes thread rows when the caller changes the refresh token", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        yield* service.readSummary(WINDOW);
        yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));

        const breakdown = yield* service.readThreadBreakdown({
          ...WINDOW,
          refreshToken: "thread-refresh-1",
        });

        assert.strictEqual(
          breakdown.rows.reduce((total, row) => total + row.totals.outputTokens, 0),
          12,
        );
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-thread-refresh-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("does not let an older thread breakdown prune a newer source scan", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const baseDir = NodePath.join(home, "server-state");
      const newerTranscript = NodePath.join(NodePath.dirname(transcript), "newer-thread.jsonl");
      const threadAggregationStarted = yield* Deferred.make<void>();
      const releaseThreadAggregation = yield* Deferred.make<void>();
      let projectReads = 0;
      const unused = Effect.die(new Error("unused project repository operation"));
      const projectRepository: ProjectionProjectRepository["Service"] = {
        upsert: () => unused,
        getById: () => unused,
        listAll: () =>
          Effect.gen(function* () {
            projectReads += 1;
            if (projectReads === 2) {
              yield* Deferred.succeed(threadAggregationStarted, undefined);
              yield* Deferred.await(releaseThreadAggregation);
            }
            return [];
          }),
        deleteById: () => unused,
      };
      const runtimeRepository: ProviderSessionRuntime.ProviderSessionRuntimeRepository["Service"] =
        {
          upsert: () => unused,
          getByThreadId: () => unused,
          list: () => Effect.succeed([]),
          deleteByThreadId: () => unused,
        };
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-thread-prune-race-test",
            baseDir,
            home,
            settings,
            projectRepository,
            runtimeRepository,
          }),
        ),
      );

      const olderThread = yield* service
        .readThreadBreakdown({ ...WINDOW, refreshToken: "older-thread" })
        .pipe(
          Effect.tapCause(() => Deferred.succeed(threadAggregationStarted, undefined)),
          Effect.forkChild,
        );
      yield* Deferred.await(threadAggregationStarted);
      yield* Effect.promise(() => NodeFSP.writeFile(newerTranscript, claudeLine(2, 7)));
      yield* service.refreshSummary({
        ...WINDOW,
        timeZone: "America/Los_Angeles",
      });
      yield* Deferred.succeed(releaseThreadAggregation, undefined);
      yield* Fiber.join(olderThread);

      const persisted = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(baseDir, "userdata", "usage-scan-cache.json"), "utf8"),
        ),
      );
      assert.isTrue(
        typeof persisted === "object" &&
          persisted !== null &&
          "files" in persisted &&
          typeof persisted.files === "object" &&
          persisted.files !== null &&
          Object.hasOwn(persisted.files, newerTranscript),
      );
    }).pipe(Effect.scoped),
  );

  it.live("keeps the summary scan-start cutoff in a cached thread breakdown", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const sessionsDir = NodePath.join(home, "codex", "sessions", "2026", "08", "01");
      yield* Effect.promise(() => NodeFSP.mkdir(sessionsDir, { recursive: true }));
      const targetPath = NodePath.join(sessionsDir, "rollout-upper-bound-target.jsonl");
      const nowMs = Date.now();
      const futureTimestamp = new Date(nowMs + 60_000).toISOString();
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          targetPath,
          codexRollout("target-session", "/work/target", 70, futureTimestamp),
        ),
      );
      const sinceTime = new Date(nowMs - 5 * 60_000).toISOString();
      const untilTime = new Date(nowMs + 5 * 60_000).toISOString();
      const hourlyWindow = {
        timeZone: "UTC",
        sinceDay: UsageDay.make(sinceTime.slice(0, 10)),
        untilDay: UsageDay.make(untilTime.slice(0, 10)),
        sinceTime,
        untilTime,
        resolution: "hour" as const,
      };

      yield* Effect.gen(function* () {
        const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        yield* runtimeRepository.upsert({
          threadId: ThreadId.make("target-thread"),
          providerName: "codex",
          providerInstanceId: null,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: new Date(nowMs).toISOString(),
          resumeCursor: { threadId: "target-session" },
          runtimePayload: null,
        });
        const service = yield* UsageService.make;
        const summary = yield* service.readSummary(hourlyWindow);
        const breakdown = yield* service.readThreadBreakdown({
          ...hourlyWindow,
          threadId: ThreadId.make("target-thread"),
        });

        assert.strictEqual(totalOutputTokens(summary), 0);
        assert.strictEqual(breakdown.rows.length, 0);
        assert.strictEqual(breakdown.readAt, summary.readAt);
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-target-upper-bound-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps daily coverage bounded by the reused source snapshot", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(Date.parse("2026-08-03T23:59:45Z"));
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary({
          timeZone: "UTC",
          sinceDay: UsageDay.make("2026-08-01"),
          untilDay: UsageDay.make("2026-08-03"),
          resolution: "day",
        });
        assert.strictEqual(first.coverage?.availableThroughDay, "2026-08-02");

        yield* TestClock.adjust("30 seconds");
        const second = yield* service.readSummary({
          timeZone: "UTC",
          sinceDay: UsageDay.make("2026-08-01"),
          untilDay: UsageDay.make("2026-08-04"),
          resolution: "day",
        });

        assert.strictEqual(second.readAt, first.readAt);
        assert.strictEqual(second.coverage?.availableThroughDay, "2026-08-02");
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-source-coverage-bound-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("reprices unchanged transcripts when custom prices are added, edited, or removed", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(transcript, claudeModelLine(1, 5, "example-model")),
      );

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

  it.live(
    "reprices mixed canonical ledger costs from current custom prices without rescanning",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const baseDir = NodePath.join(home, "ledger-price-overrides-state");
        const canonical = currentCanonicalWindow();
        const timestamp = `${canonical.sinceDay}T10:00:00Z`;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            transcript,
            claudeModelLine(1, 5, "example-model", timestamp) +
              claudeModelLine(2, 5, "example-model", timestamp, 7),
          ),
        );

        yield* Effect.gen(function* () {
          const settingsService = yield* ServerSettings.ServerSettingsService;
          const service = yield* UsageService.make;

          const original = yield* service.refreshSummary(canonical);
          assert.strictEqual(original.buckets[0]?.costUsd, 7);
          assert.strictEqual(original.buckets[0]?.unpricedRecords, 1);

          yield* settingsService.updateSettings({
            usagePriceOverrides: {
              "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
            },
          });
          const overridden = yield* service.readSummary(canonical);
          assert.closeTo(overridden.buckets[0]?.costUsd ?? -1, 0.00012, 1e-12);
          assert.strictEqual(overridden.buckets[0]?.costSource, "modelPriced");
          assert.strictEqual(overridden.buckets[0]?.unpricedRecords, 0);
          assert.deepStrictEqual(overridden.buckets[0]?.totals, original.buckets[0]?.totals);

          yield* settingsService.updateSettings({
            usagePriceOverrides: {
              "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 16 },
            },
          });
          const edited = yield* service.readSummary(canonical);
          assert.closeTo(edited.buckets[0]?.costUsd ?? -1, 0.00024, 1e-12);

          yield* settingsService.updateSettings({ usagePriceOverrides: { "example-model": null } });
          const restored = yield* service.readSummary(canonical);
          assert.deepStrictEqual(restored.buckets, original.buckets);
        }).pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-service-ledger-price-overrides-test",
              baseDir,
              home,
              settings,
            }),
          ),
        );

        // The v3 on-disk ledger retains the same dynamic provenance after a
        // restart. Remove the transcript so this assertion cannot pass by
        // silently rescanning the source record.
        yield* Effect.promise(() => NodeFSP.rm(transcript));
        const restarted = yield* UsageService.make.pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-service-ledger-price-overrides-restart-test",
              baseDir,
              home,
              settings: {
                ...settings,
                usagePriceOverrides: {
                  "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
                },
              },
            }),
          ),
        );
        const restoredFromDisk = yield* restarted.readSummary(canonical);
        assert.closeTo(restoredFromDisk.buckets[0]?.costUsd ?? -1, 0.00012, 1e-12);
        assert.strictEqual(restoredFromDisk.buckets[0]?.unpricedRecords, 0);
      }).pipe(Effect.scoped),
  );

  it.live("preserves project attribution and cache-write pricing across a ledger restart", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const baseDir = NodePath.join(home, "project-cache-ledger-state");
      const canonical = currentCanonicalWindow();
      const timestamp = `${canonical.sinceDay}T10:00:00Z`;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          transcript,
          claudeCacheLine(1, timestamp, "/work/app/src", 10, 20) +
            claudeCacheLine(2, timestamp, "/work/other", 20, 10) +
            claudeCacheLine(3, timestamp, "", 15, 15),
        ),
      );
      const projectRepository: ProjectionProjectRepository["Service"] = {
        upsert: () => Effect.die("unused project upsert"),
        getById: () => Effect.die("unused project lookup"),
        listAll: () =>
          Effect.succeed([
            {
              projectId: ProjectId.make("project-app"),
              title: "App",
              workspaceRoot: "/work/app",
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              scripts: [],
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              deletedAt: null,
            },
          ]),
        deleteById: () => Effect.die("unused project delete"),
      };
      const layers = serviceLayers({
        prefix: "usage-service-project-cache-ledger-test",
        baseDir,
        home,
        settings,
        projectRepository,
        ratesDocument: {
          "claude-fable-5": {
            input_cost_per_token: 1e-5,
            output_cost_per_token: 5e-5,
            cache_read_input_token_cost: 1e-6,
            cache_creation_input_token_cost: 1.25e-5,
            cache_creation_input_token_cost_above_1hr: 2e-5,
          },
        },
      });
      const service = yield* UsageService.make.pipe(Effect.provide(layers));

      const scanned = yield* service.refreshSummary(canonical);
      const scannedByAttribution = Object.fromEntries(
        scanned.buckets.map((bucket) => [bucket.projectAttribution, bucket]),
      );
      assert.deepStrictEqual(Object.keys(scannedByAttribution).toSorted(), [
        "outside",
        "project",
        "unknown",
      ]);
      assert.strictEqual(scannedByAttribution["project"]?.projectId, "project-app");
      assert.strictEqual(scannedByAttribution["project"]?.project, "App");
      assert.closeTo(
        scannedByAttribution["project"]?.cacheWriteUsd ?? -1,
        10 * 1.25e-5 + 20 * 2e-5,
        1e-12,
      );
      assert.closeTo(
        scannedByAttribution["outside"]?.cacheWriteUsd ?? -1,
        20 * 1.25e-5 + 10 * 2e-5,
        1e-12,
      );
      assert.closeTo(
        scannedByAttribution["unknown"]?.cacheWriteUsd ?? -1,
        15 * 1.25e-5 + 15 * 2e-5,
        1e-12,
      );

      yield* Effect.promise(() => NodeFSP.rm(transcript));
      const restarted = yield* UsageService.make.pipe(Effect.provide(layers));
      const restored = yield* restarted.readSummary(canonical);

      assert.deepStrictEqual(restored.buckets, scanned.buckets);
    }).pipe(Effect.scoped),
  );

  it.live("rebuilds a v2 ledger before applying a custom price to an unknown model", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const baseDir = NodePath.join(home, "v2-ledger-price-upgrade-state");
      const stateDir = NodePath.join(baseDir, "userdata");
      const canonical = currentCanonicalWindow();
      const timestamp = `${canonical.sinceDay}T10:00:00Z`;
      const totals = {
        uncachedInputTokens: 10,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      };
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(stateDir, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-record-ledger.json"),
          JSON.stringify({
            version: 2,
            generatedAtMs: Date.now(),
            aggregates: [
              {
                hostId: NodeOS.hostname(),
                provider: "claude",
                resolvedHomePath: NodePath.dirname(NodePath.dirname(transcript)),
                volumeId: "legacy-volume",
                bucketStartMs: Date.parse(timestamp),
                model: "example-model",
                totals,
                pricedTotals: {
                  uncachedInputTokens: 0,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  outputTokens: 0,
                  reasoningTokens: 0,
                },
                savingsTotals: totals,
                legacyPricing: false,
                legacyPricingRecords: 0,
                reportedCostUsd: 0,
                records: 1,
                unpricedRecords: 1,
                providerReportedRecords: 0,
                sessions: ["session-1"],
              },
            ],
            sources: [],
          }),
        );
        await NodeFSP.writeFile(transcript, claudeModelLine(1, 5, "example-model", timestamp));
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-v2-ledger-price-upgrade-test",
            baseDir,
            home,
            settings: {
              ...settings,
              usagePriceOverrides: {
                "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
              },
            },
          }),
        ),
      );

      const result = yield* service.readSummary(canonical);

      assert.closeTo(result.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
      assert.strictEqual(result.buckets[0]?.unpricedRecords, 0);
      const persisted = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(stateDir, "usage-record-ledger.json"), "utf8"),
        ),
      ) as {
        version: number;
        generatedAtMs: number;
        aggregates: readonly (Record<string, unknown> & { readonly dynamicPricing?: boolean })[];
        sources: readonly unknown[];
      };
      assert.strictEqual(persisted.version, 4);

      // A failed mandatory rebuild still serves the matching last-good
      // snapshot. Rewrite the fixture as v2 and make its transcript root
      // unreadable to exercise that upgrade fallback.
      const emptyTotals = {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      };
      const v2Aggregates = persisted.aggregates.map(
        ({ dynamicPricing: _dynamicPricing, ...aggregate }) => ({
          ...aggregate,
          pricedTotals: emptyTotals,
          unpricedRecords: 1,
        }),
      );
      const transcriptRoot = NodePath.dirname(NodePath.dirname(transcript));
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-record-ledger.json"),
          JSON.stringify({
            version: 2,
            generatedAtMs: persisted.generatedAtMs,
            aggregates: v2Aggregates,
            sources: persisted.sources,
          }),
        );
        await NodeFSP.rm(transcriptRoot, { recursive: true });
        await NodeFSP.writeFile(transcriptRoot, "not a directory");
      });
      const fallbackService = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-v2-ledger-price-fallback-test",
            baseDir,
            home,
            settings: {
              ...settings,
              usagePriceOverrides: {
                "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
              },
            },
          }),
        ),
      );
      const fallback = yield* fallbackService.readSummary(canonical);
      assert.closeTo(fallback.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
    }).pipe(Effect.scoped),
  );

  it.live("walks first-day transcript files before UTC midnight in a positive-offset zone", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const canonical = currentCanonicalWindow("Pacific/Kiritimati");
      const firstDayUtcSpelling = Date.parse(`${canonical.sinceDay}T00:00:00Z`);
      const firstLocalDayRecord = new Date(firstDayUtcSpelling - 13 * 60 * 60 * 1000);
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5, firstLocalDayRecord.toISOString()));
        await NodeFSP.utimes(transcript, firstLocalDayRecord, firstLocalDayRecord);
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-positive-offset-walk-test", home, settings }),
        ),
      );

      const result = yield* service.refreshSummary(canonical);

      assert.strictEqual(result.buckets[0]?.day, canonical.sinceDay);
      assert.strictEqual(totalOutputTokens(result), 5);
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
      const second = yield* service.refreshSummary(WINDOW);
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
      yield* Effect.promise(() =>
        NodeFSP.writeFile(transcript, claudeModelLine(1, 5, "example-model")),
      );

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

      // A later request is fresh work again, not a stale cached answer.
      yield* service.refreshSummary(WINDOW);
      assert.strictEqual(ratesFetches, 2);
    }).pipe(Effect.scoped),
  );

  it.live("coalesces concurrent caller refresh tokens for the same summary", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const ratesStarted = yield* Deferred.make<void>();
      const ratesGate = yield* Deferred.make<void>();
      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-refresh-coalescing-test",
            home,
            settings,
            ratesGate,
            ratesStarted,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const reads = yield* Effect.forEach(
        Array.from({ length: 16 }, (_, index) => `caller-${index}`),
        (refreshToken) => service.readSummary({ ...WINDOW, refreshToken }),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(ratesStarted);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(ratesGate, undefined);
      const summaries = yield* Fiber.join(reads);

      assert.strictEqual(ratesFetches, 1);
      assert.strictEqual(new Set(summaries.map(({ readAt }) => readAt)).size, 1);
    }).pipe(Effect.scoped),
  );

  it.live("loads a durable final snapshot without rescanning on the next server", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const layers = serviceLayers({
        prefix: "usage-service-snapshot-test",
        baseDir: NodePath.join(home, "server-state"),
        home,
        settings,
      });
      const firstService = yield* UsageService.make.pipe(Effect.provide(layers));

      const first = yield* firstService.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      const secondService = yield* UsageService.make.pipe(Effect.provide(layers));
      const cached = yield* secondService.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(cached), 5);
      assert.strictEqual(cached.coverage?.availableThroughDay, WINDOW.untilDay);
    }).pipe(Effect.scoped),
  );

  it.live("keeps the last complete snapshot after a failed refresh and restart", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const layers = serviceLayers({
        prefix: "usage-service-last-good-test",
        baseDir: NodePath.join(home, "server-state"),
        home,
        settings,
      });
      const firstService = yield* UsageService.make.pipe(Effect.provide(layers));

      const complete = yield* firstService.refreshSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(complete), 5);

      const transcriptRoot = NodePath.join(home, "claude", "projects");
      yield* Effect.promise(() => NodeFSP.rename(transcriptRoot, `${transcriptRoot}-valid`));
      yield* Effect.promise(() => NodeFSP.writeFile(transcriptRoot, "not a directory"));
      const failed = yield* firstService.refreshSummary(WINDOW).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));

      const restartedService = yield* UsageService.make.pipe(Effect.provide(layers));
      const retained = yield* restartedService.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(retained), 5);
      assert.strictEqual(retained.coverage?.availableThroughDay, WINDOW.untilDay);
      assert.strictEqual(retained.coverage?.generatedAt, complete.coverage?.generatedAt);
    }).pipe(Effect.scoped),
  );

  it.live("retains the last-good snapshot when a transcript stays unreadable", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const layers = serviceLayers({
        prefix: "usage-service-unreadable-file-test",
        baseDir: NodePath.join(home, "server-state"),
        home,
        settings,
      });
      const complete = yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const complete = yield* service.refreshSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(complete), 5);

        // A symlink with a directory target is listed as a transcript entry, but
        // opening it as a stream fails persistently. Publishing the valid sibling
        // would make an incomplete corpus look complete.
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.dirname(transcript), `${transcript}.bad.jsonl`),
        );

        const failed = yield* service.refreshSummary(WINDOW).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(failed));
        const retained = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(retained), 5);
        assert.strictEqual(retained.coverage?.generatedAt, complete.coverage?.generatedAt);

        // The failed refresh leaves an incomplete parsed source candidate in
        // memory. Thread rows must reject it and retry the issue-aware path,
        // which still sees the unreadable matching file.
        const threadRead = yield* service.readThreadBreakdown(WINDOW).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(threadRead));
        if (Exit.isFailure(threadRead)) {
          const error = threadRead.cause.reasons[0];
          assert.isTrue(error !== undefined && error._tag === "Fail");
          if (error !== undefined && error._tag === "Fail") {
            assert.strictEqual(error.error.reason, "scanFailed");
            assert.strictEqual(
              error.error.detail,
              "Thread usage could not read every matching transcript file.",
            );
          }
        }
        return complete;
      }).pipe(Effect.provide(layers));

      const restartedService = yield* UsageService.make.pipe(Effect.provide(layers));
      const restarted = yield* restartedService.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(restarted), 5);
      assert.strictEqual(restarted.coverage?.generatedAt, complete.coverage?.generatedAt);
    }).pipe(Effect.scoped),
  );

  it.live("reports unavailable when the first refresh cannot read a transcript", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.dirname(transcript), `${transcript}.bad.jsonl`),
      );
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-fresh-unreadable-file-test",
            baseDir: NodePath.join(home, "server-state"),
            home,
            settings,
          }),
        ),
      );

      const unavailable = yield* service.readSummary(WINDOW).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(unavailable));

      yield* Effect.promise(() => NodeFSP.rm(`${transcript}.bad.jsonl`));
      const retried = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(retried), 5);
    }).pipe(Effect.scoped),
  );

  it.live("does not enroll a canonical waiter until the refresh effect runs", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-lazy-waiter-test", home, settings })),
      );
      const canonical = currentCanonicalWindow();

      // Construction alone must not make later readers wait forever.
      const discardedRefresh = service.refreshSummary(canonical);
      assert.isTrue(discardedRefresh !== undefined);
      const refreshed = yield* service.refreshSummary(canonical);
      assert.strictEqual(totalOutputTokens(refreshed), 5);
      const read = yield* service.readSummary({ ...canonical, timeZone: "Australia/Adelaide" });
      assert.strictEqual(totalOutputTokens(read), 5);
    }).pipe(Effect.scoped),
  );

  it.live("replaces the canonical ledger after transcripts are deleted", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const baseDir = NodePath.join(home, "replace-ledger-state");
      const layers = serviceLayers({
        prefix: "usage-service-replace-ledger-test",
        baseDir,
        home,
        settings,
      });
      const service = yield* UsageService.make.pipe(Effect.provide(layers));
      const canonical = currentCanonicalWindow();
      yield* service.refreshSummary(canonical);

      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(home, "claude", "projects"), { recursive: true }),
      );
      yield* service.refreshSummary(canonical);
      const read = yield* service.readSummary({ ...canonical, timeZone: "America/Los_Angeles" });
      assert.strictEqual(totalOutputTokens(read), 0);
    }).pipe(Effect.scoped),
  );

  it.live("stores one bounded aggregate for repeated records", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          transcript,
          Array.from({ length: 1_000 }, (_, index) => claudeLine(index, 1)).join(""),
        ),
      );
      const baseDir = NodePath.join(home, "bounded-ledger-state");
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-bounded-ledger-test", baseDir, home, settings }),
        ),
      );
      yield* service.refreshSummary(currentCanonicalWindow());
      const raw = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(baseDir, "userdata", "usage-record-ledger.json"), "utf8"),
      );
      const document = JSON.parse(raw) as {
        aggregates?: readonly unknown[];
        records?: readonly unknown[];
      };
      assert.strictEqual(document.aggregates?.length, 1);
      assert.isUndefined(document.records);
      assert.isBelow(raw.length, 20_000);
    }).pipe(Effect.scoped),
  );

  it.live("marks persisted v2 priced cells unpriced when the rates cache is corrupt", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const baseDir = NodePath.join(home, "corrupt-rates-ledger-state");
      const stateDir = NodePath.join(baseDir, "userdata");
      const totals = {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      };
      yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(stateDir, "usage-model-rates.json"), "{corrupt"),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-record-ledger.json"),
          JSON.stringify({
            version: 2,
            generatedAtMs: Date.now(),
            aggregates: [
              {
                hostId: "mac",
                provider: "claude",
                resolvedHomePath: "/a/.claude",
                volumeId: "vol-1",
                bucketStartMs: Date.parse("2026-08-01T10:00:00.000Z"),
                model: "claude-fable-5",
                totals,
                pricedTotals: totals,
                savingsTotals: totals,
                legacyPricing: false,
                legacyPricingRecords: 0,
                reportedCostUsd: 0,
                records: 1,
                unpricedRecords: 0,
                providerReportedRecords: 0,
                sessions: ["session-1"],
              },
            ],
            sources: [
              {
                fingerprint: {
                  hostId: "mac",
                  provider: "claude",
                  resolvedHomePath: "/a/.claude",
                  volumeId: "vol-1",
                },
                status: "ok",
                scannedFiles: 1,
                skippedFiles: 0,
                malformedRecords: 0,
                distinctSessions: 1,
                message: null,
              },
            ],
          }),
        ),
      );

      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-corrupt-rates-test", baseDir, home, settings }),
        ),
      );
      const result = yield* service.readSummary(currentCanonicalWindow());
      const bucket = result.buckets.find((entry) => entry.model === "claude-fable-5");
      assert.isNotNull(bucket);
      if (bucket === undefined) throw new Error("expected persisted model bucket");
      assert.strictEqual(bucket.costUsd, 0);
      assert.strictEqual(bucket.costSource, "unpriced");
      assert.strictEqual(bucket.records, 1);
      assert.strictEqual(bucket.unpricedRecords, 1);
    }).pipe(Effect.scoped),
  );

  it.live("rejects daily ledger data at the positive-offset retention boundary", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const baseDir = NodePath.join(home, "positive-offset-retention-state");
      const stateDir = NodePath.join(baseDir, "userdata");
      const totals = {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      };
      yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-record-ledger.json"),
          JSON.stringify({
            version: 2,
            generatedAtMs: Date.parse("2026-09-03T00:00:00.000Z"),
            aggregates: [
              {
                hostId: "mac",
                provider: "claude",
                resolvedHomePath: "/a/.claude",
                volumeId: "vol-1",
                bucketStartMs: Date.parse("2026-06-02T12:00:00.000Z"),
                model: "claude-fable-5",
                totals,
                pricedTotals: totals,
                savingsTotals: totals,
                legacyPricing: false,
                legacyPricingRecords: 0,
                reportedCostUsd: 0,
                records: 1,
                unpricedRecords: 0,
                providerReportedRecords: 0,
                sessions: ["session-1"],
              },
            ],
            sources: [],
          }),
        ),
      );
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-positive-offset-retention-test",
            baseDir,
            home,
            settings,
          }),
        ),
      );
      const result = yield* service
        .readSummary({
          timeZone: "Pacific/Kiritimati",
          sinceDay: UsageDay.make("2026-06-03"),
          untilDay: UsageDay.make("2026-06-03"),
          resolution: "day",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
    }).pipe(Effect.scoped),
  );

  it.live("accepts a canonical negative-offset window late in the local day", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const baseDir = NodePath.join(home, "negative-offset-retention-state");
      const stateDir = NodePath.join(baseDir, "userdata");
      const totals = {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      };
      yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-record-ledger.json"),
          JSON.stringify({
            version: 2,
            // At 01:00 UTC, June 4 is still the previous local day in Los Angeles.
            generatedAtMs: Date.parse("2026-09-03T01:00:00.000Z"),
            aggregates: [
              {
                hostId: "mac",
                provider: "claude",
                resolvedHomePath: "/a/.claude",
                volumeId: "vol-1",
                bucketStartMs: Date.parse("2026-06-04T12:00:00.000Z"),
                model: "claude-fable-5",
                totals,
                pricedTotals: totals,
                savingsTotals: totals,
                legacyPricing: false,
                legacyPricingRecords: 0,
                reportedCostUsd: 0,
                records: 1,
                unpricedRecords: 0,
                providerReportedRecords: 0,
                sessions: ["session-1"],
              },
            ],
            sources: [],
          }),
        ),
      );
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-negative-offset-retention-test",
            baseDir,
            home,
            settings,
          }),
        ),
      );
      const result = yield* service.readSummary({
        timeZone: "America/Los_Angeles",
        sinceDay: UsageDay.make("2026-06-04"),
        untilDay: UsageDay.make("2026-09-01"),
        resolution: "day",
      });
      assert.strictEqual(totalOutputTokens(result), 5);
    }).pipe(Effect.scoped),
  );

  it.live("rejects a canonical window when a local midnight gap crosses retention", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const baseDir = NodePath.join(home, "midnight-gap-retention-state");
      const stateDir = NodePath.join(baseDir, "userdata");
      const totals = {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      };
      yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-record-ledger.json"),
          JSON.stringify({
            version: 2,
            // The 92-day retention cutoff is 00:00 UTC on April 24. Cairo's
            // April 24 midnight gap begins at 22:00 UTC on April 23, so the
            // first two hours of the local day are outside the ledger.
            generatedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
            aggregates: [
              {
                hostId: "mac",
                provider: "claude",
                resolvedHomePath: "/a/.claude",
                volumeId: "vol-1",
                bucketStartMs: Date.parse("2026-04-24T12:00:00.000Z"),
                model: "claude-fable-5",
                totals,
                pricedTotals: totals,
                savingsTotals: totals,
                legacyPricing: false,
                legacyPricingRecords: 0,
                reportedCostUsd: 0,
                records: 1,
                unpricedRecords: 0,
                providerReportedRecords: 0,
                sessions: ["session-1"],
              },
            ],
            sources: [],
          }),
        ),
      );
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-midnight-gap-retention-test",
            baseDir,
            home,
            settings,
          }),
        ),
      );
      const result = yield* service
        .readSummary({
          timeZone: "Africa/Cairo",
          sinceDay: UsageDay.make("2026-04-24"),
          untilDay: UsageDay.make("2026-07-22"),
          resolution: "day",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
    }).pipe(Effect.scoped),
  );

  it.live("rejects a skipped local civil date", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const baseDir = NodePath.join(home, "skipped-date-retention-state");
      const stateDir = NodePath.join(baseDir, "userdata");
      const totals = {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      };
      yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-record-ledger.json"),
          JSON.stringify({
            version: 2,
            // Apia skipped December 30, 2011 when it moved across the date
            // line. The old iterative resolver could return a prior instant.
            generatedAtMs: Date.parse("2012-03-28T00:00:00.000Z"),
            aggregates: [
              {
                hostId: "mac",
                provider: "claude",
                resolvedHomePath: "/a/.claude",
                volumeId: "vol-1",
                bucketStartMs: Date.parse("2011-12-30T12:00:00.000Z"),
                model: "claude-fable-5",
                totals,
                pricedTotals: totals,
                savingsTotals: totals,
                legacyPricing: false,
                legacyPricingRecords: 0,
                reportedCostUsd: 0,
                records: 1,
                unpricedRecords: 0,
                providerReportedRecords: 0,
                sessions: ["session-1"],
              },
            ],
            sources: [],
          }),
        ),
      );
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-skipped-date-retention-test",
            baseDir,
            home,
            settings,
          }),
        ),
      );
      const result = yield* service
        .readSummary({
          timeZone: "Pacific/Apia",
          sinceDay: UsageDay.make("2011-12-30"),
          untilDay: UsageDay.make("2011-12-30"),
          resolution: "day",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
    }).pipe(Effect.scoped),
  );

  it.live("serves a remote-timezone preset from the normalized ledger", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      let ratesFetches = 0;
      const layers = serviceLayers({
        prefix: "usage-service-ledger-timezone-test",
        baseDir: NodePath.join(home, "server-state"),
        home,
        settings,
        onRatesFetch: () => {
          ratesFetches += 1;
        },
      });
      const canonical = currentCanonicalWindow();
      const firstService = yield* UsageService.make.pipe(Effect.provide(layers));
      yield* firstService.refreshSummary(canonical);
      const fetchesAfterRefresh = ratesFetches;

      const remoteService = yield* UsageService.make.pipe(Effect.provide(layers));
      const remote = yield* remoteService.readSummary({
        ...canonical,
        timeZone: "America/Los_Angeles",
      });
      assert.strictEqual(totalOutputTokens(remote), 5);
      assert.strictEqual(ratesFetches, fetchesAfterRefresh);
    }).pipe(Effect.scoped),
  );

  it.live("prefers the current ledger over an older persisted common snapshot", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const baseDir = NodePath.join(home, "common-snapshot-state");
      const layers = serviceLayers({
        prefix: "usage-service-common-snapshot-test",
        baseDir,
        home,
        settings,
      });
      const service = yield* UsageService.make.pipe(Effect.provide(layers));
      const canonical = currentCanonicalWindow();
      yield* service.refreshSummary(canonical);
      const remote = { ...canonical, timeZone: "America/Los_Angeles" };
      const stale = yield* service.readSummary(remote);
      const snapshotKey = JSON.stringify([
        remote.timeZone,
        remote.sinceDay,
        remote.untilDay,
        remote.resolution ?? "day",
        remote.sinceTime ?? null,
        remote.untilTime ?? null,
      ]);
      const snapshotPath = NodePath.join(baseDir, "userdata", "usage-snapshot.json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          snapshotPath,
          JSON.stringify({ version: 1, entries: [{ key: snapshotKey, summary: stale }] }),
        ),
      );
      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      yield* service.refreshSummary(canonical);

      const restarted = yield* UsageService.make.pipe(Effect.provide(layers));
      const current = yield* restarted.readSummary(remote);
      assert.strictEqual(totalOutputTokens(current), 12);
    }).pipe(Effect.scoped),
  );

  it.live("lets a first preset read join the in-flight canonical background scan", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const ratesGate = yield* Deferred.make<void>();
      const ratesStarted = yield* Deferred.make<void>();
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-canonical-wait-test",
            home,
            settings,
            ratesGate,
            ratesStarted,
          }),
        ),
      );
      const canonical = currentCanonicalWindow();
      const background = yield* service.startBackgroundRefresh.pipe(Effect.forkChild);
      yield* Deferred.await(ratesStarted);

      const preset = yield* service.readSummary(canonical).pipe(Effect.forkChild);
      yield* Deferred.succeed(ratesGate, undefined);
      const result = yield* Fiber.join(preset);
      assert.strictEqual(totalOutputTokens(result), 5);
      yield* Fiber.interrupt(background);
    }).pipe(Effect.scoped),
  );

  it.live("derives a canonical follower response for its requested timezone", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const leader = currentCanonicalWindow();
      const recordTimestamp = `${leader.sinceDay}T12:30:00Z`;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, recordTimestamp)));
      const ratesGate = yield* Deferred.make<void>();
      const ratesStarted = yield* Deferred.make<void>();
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-canonical-follower-test",
            home,
            settings,
            ratesGate,
            ratesStarted,
          }),
        ),
      );
      const follower = { ...leader, timeZone: "Pacific/Kiritimati" };
      const leaderFiber = yield* service.refreshSummary(leader).pipe(Effect.forkChild);
      yield* Deferred.await(ratesStarted);
      const followerFiber = yield* service.refreshSummary(follower).pipe(Effect.forkChild);
      yield* Deferred.succeed(ratesGate, undefined);
      yield* Fiber.join(leaderFiber);
      const result = yield* Fiber.join(followerFiber);
      assert.strictEqual(result.timeZone, follower.timeZone);
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: follower.timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .formatToParts(new Date(recordTimestamp))
          .map(({ type, value }) => [type, value]),
      );
      assert.strictEqual(result.buckets[0]?.day, `${parts.year}-${parts.month}-${parts.day}`);
    }).pipe(Effect.scoped),
  );

  it.live("keeps a shared canonical scan alive when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const ratesGate = yield* Deferred.make<void>();
      const ratesStarted = yield* Deferred.make<void>();
      let canonicalScans = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-canonical-interrupt-test",
            home,
            settings,
            ratesGate,
            ratesStarted,
          }),
        ),
        Effect.provideService(UsageService.UsageRefreshHooks, {
          beforeCanonicalScan: Effect.sync(() => {
            canonicalScans += 1;
          }),
        }),
      );
      const canonical = currentCanonicalWindow();
      const leader = yield* service.refreshSummary(canonical).pipe(Effect.forkChild);
      yield* Deferred.await(ratesStarted);
      const follower = yield* service.refreshSummary(canonical).pipe(Effect.forkChild);
      const interrupt = yield* Fiber.interrupt(leader).pipe(Effect.forkDetach);
      yield* Effect.yieldNow;
      yield* Fiber.join(interrupt).pipe(Effect.timeout("5 seconds"));
      assert.isUndefined(follower.pollUnsafe());

      yield* Deferred.succeed(ratesGate, undefined);
      const result = yield* Fiber.join(follower).pipe(Effect.timeout("5 seconds"));
      assert.strictEqual(totalOutputTokens(result), 5);
      assert.strictEqual(canonicalScans, 1);

      const next = yield* service.refreshSummary(canonical).pipe(Effect.timeout("5 seconds"));
      assert.strictEqual(totalOutputTokens(next), 5);
      assert.strictEqual(canonicalScans, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes once at startup and again after the 30-minute cadence", () =>
    Effect.gen(function* () {
      let refreshes = 0;
      const background = yield* UsageService.backgroundRefreshSchedule(
        Effect.sync(() => {
          refreshes += 1;
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.strictEqual(refreshes, 1);

      yield* TestClock.adjust("29 minutes");
      assert.strictEqual(refreshes, 1);
      yield* TestClock.adjust("1 minute");
      yield* Effect.yieldNow;
      assert.strictEqual(refreshes, 2);
      yield* Fiber.interrupt(background);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("logs a background refresh failure before swallowing it", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const brokenHome = NodePath.join(home, "broken-claude");
      yield* Effect.promise(() => NodeFSP.mkdir(brokenHome, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(brokenHome, "projects"), "file"));
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-background-log-test",
            home,
            settings: {
              ...settings,
              providers: {
                ...settings.providers,
                claudeAgent: { homePath: brokenHome },
              },
            },
          }),
        ),
      );
      const messages: string[] = [];
      const logger = Logger.make(({ message }) => {
        messages.push(String(message));
      });
      const background = yield* service.startBackgroundRefresh.pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.forkChild,
      );
      for (
        let attempt = 0;
        attempt < 100 &&
        !messages.some((message) => message.startsWith("Usage background refresh failed"));
        attempt += 1
      ) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(background);
      assert.isTrue(
        messages.some((message) => message.startsWith("Usage background refresh failed")),
      );
    }).pipe(Effect.scoped),
  );

  it.live("turns a failed canonical waiter into a typed not-ready result", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const unreadableHome = NodePath.join(home, "not-a-directory");
      yield* Effect.promise(() => NodeFSP.writeFile(unreadableHome, "not a directory"));
      const ratesGate = yield* Deferred.make<void>();
      const ratesStarted = yield* Deferred.make<void>();
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-canonical-failure-wait-test",
            home,
            settings: {
              ...settings,
              providers: {
                ...settings.providers,
                claudeAgent: { homePath: unreadableHome },
              },
            },
            ratesGate,
            ratesStarted,
          }),
        ),
      );
      const background = yield* service.startBackgroundRefresh.pipe(Effect.forkChild);
      yield* Deferred.await(ratesStarted);
      const preset = yield* service
        .readSummary(currentCanonicalWindow())
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.succeed(ratesGate, undefined);
      const result = yield* Fiber.join(preset);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        const error = result.cause.reasons[0];
        assert.isTrue(error !== undefined && error._tag === "Fail");
        if (error !== undefined && error._tag === "Fail") {
          assert.strictEqual(error.error.reason, "scanFailed");
          assert.strictEqual(
            error.error.detail,
            "Usage refresh could not read every transcript file; the last-good snapshot remains active.",
          );
        }
      }
      yield* Fiber.interrupt(background);
    }).pipe(Effect.scoped),
  );

  it.live("derives an empty complete canonical scan as zero usage", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const layers = serviceLayers({
        prefix: "usage-service-empty-canonical-test",
        baseDir: NodePath.join(home, "empty-canonical-state"),
        home,
        settings,
      });
      const canonical = currentCanonicalWindow();
      const first = yield* UsageService.make.pipe(Effect.provide(layers));
      yield* first.refreshSummary(canonical);
      const second = yield* UsageService.make.pipe(Effect.provide(layers));
      const remote = yield* second.readSummary({ ...canonical, timeZone: "Pacific/Kiritimati" });
      assert.strictEqual(totalOutputTokens(remote), 0);
    }).pipe(Effect.scoped),
  );

  it.live("dedupes within a transcript directory but not across projects", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const duplicateClaude = NodePath.join(NodePath.dirname(transcript), "duplicate.jsonl");
      const sharedKeyClaude = claudeLine(1, 5, "2026-08-01T10:00:00Z", "session:prompt", "grok");
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, sharedKeyClaude));
      yield* Effect.promise(() => NodeFSP.writeFile(duplicateClaude, sharedKeyClaude));

      const otherProjectDir = NodePath.join(home, "claude", "projects", "other");
      yield* Effect.promise(() => NodeFSP.mkdir(otherProjectDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(otherProjectDir, "session.jsonl"), sharedKeyClaude),
      );

      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-directory-dedupe-test",
            baseDir: NodePath.join(home, "directory-dedupe-state"),
            home,
            settings,
          }),
        ),
      );
      const result = yield* service.refreshSummary(currentCanonicalWindow());
      // Both Claude project directories deliberately produce the same
      // non-null key. The duplicate file in the first directory is dropped,
      // while the second project's record remains visible.
      assert.strictEqual(totalOutputTokens(result), 10);
      const read = yield* service.readSummary(currentCanonicalWindow());
      assert.strictEqual(totalOutputTokens(read), 10);
      const raw = yield* Effect.promise(() =>
        NodeFSP.readFile(
          NodePath.join(home, "directory-dedupe-state", "userdata", "usage-record-ledger.json"),
          "utf8",
        ),
      );
      const document = JSON.parse(raw) as {
        aggregates?: readonly {
          records?: number;
          totals?: { outputTokens?: number };
        }[];
      };
      assert.strictEqual(document.aggregates?.length, 1);
      assert.strictEqual(document.aggregates?.[0]?.records, 2);
      assert.strictEqual(document.aggregates?.[0]?.totals?.outputTokens, 10);
    }).pipe(Effect.scoped),
  );

  it.live("does not advance the canonical ledger for a narrow manual refresh", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const baseDir = NodePath.join(home, "narrow-refresh-state");
      const layers = serviceLayers({
        prefix: "usage-service-narrow-refresh-test",
        baseDir,
        home,
        settings,
      });
      const service = yield* UsageService.make.pipe(Effect.provide(layers));
      const canonical = currentCanonicalWindow();
      yield* service.refreshSummary(canonical);
      const ledgerPath = NodePath.join(baseDir, "userdata", "usage-record-ledger.json");
      const before = yield* Effect.promise(() => NodeFSP.readFile(ledgerPath, "utf8"));
      yield* service.refreshSummary(WINDOW);
      const after = yield* Effect.promise(() => NodeFSP.readFile(ledgerPath, "utf8"));
      assert.strictEqual(after, before);
    }).pipe(Effect.scoped),
  );

  it.live("refreshes canonical data for a common manual preset", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const baseDir = NodePath.join(home, "common-refresh-state");
      const layers = serviceLayers({
        prefix: "usage-service-common-refresh-test",
        baseDir,
        home,
        settings,
      });
      const service = yield* UsageService.make.pipe(Effect.provide(layers));
      yield* service.refreshSummary(currentCanonicalWindow());
      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));

      const common: UsageSummaryInput = {
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-08-04"),
        untilDay: UsageDay.make("2026-09-02"),
        resolution: "day",
      };
      yield* service.refreshSummary(common);
      const raw = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(baseDir, "userdata", "usage-record-ledger.json"), "utf8"),
      );
      const document = JSON.parse(raw) as {
        aggregates: readonly { totals: { outputTokens: number } }[];
      };
      assert.strictEqual(
        document.aggregates.reduce((sum, entry) => sum + entry.totals.outputTokens, 0),
        12,
      );
    }).pipe(Effect.scoped),
  );

  it.live("scans common windows outside ledger retention instead of returning truncated data", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(transcript, claudeLine(1, 5, "2026-04-01T10:00:00Z")),
      );
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-historical-preset-test",
            baseDir: NodePath.join(home, "historical-preset-state"),
            home,
            settings,
          }),
        ),
      );
      const windows: readonly UsageSummaryInput[] = [
        { sinceDay: UsageDay.make("2026-04-01"), untilDay: UsageDay.make("2026-04-01") },
        { sinceDay: UsageDay.make("2026-03-29"), untilDay: UsageDay.make("2026-04-04") },
        { sinceDay: UsageDay.make("2026-03-18"), untilDay: UsageDay.make("2026-04-16") },
        { sinceDay: UsageDay.make("2026-01-06"), untilDay: UsageDay.make("2026-04-05") },
      ].map((window) => ({ ...window, timeZone: "UTC", resolution: "day" as const }));

      for (const input of windows) {
        const result = yield* service.refreshSummary(input);
        assert.strictEqual(totalOutputTokens(result), 5);
      }
      const current = yield* service.refreshSummary(currentCanonicalWindow());
      assert.strictEqual(totalOutputTokens(current), 0);
    }).pipe(Effect.scoped),
  );

  it.live("uses the last complete client-aligned hourly bucket from a :20 ledger cutoff", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const baseDir = NodePath.join(home, "hourly-ledger-state");
      const stateDir = NodePath.join(baseDir, "userdata");
      yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-record-ledger.json"),
          JSON.stringify({
            version: 1,
            generatedAtMs: Date.parse("2026-08-02T00:20:00.000Z"),
            records: [
              {
                hostId: "mac",
                provider: "claude",
                resolvedHomePath: "/a/.claude",
                volumeId: "vol-1",
                record: {
                  provider: "claude",
                  timestampMs: Date.parse("2026-08-01T22:45:00.000Z"),
                  model: "claude-fable-5",
                  sessionId: "session-1",
                  totals: {
                    uncachedInputTokens: 1,
                    cachedInputTokens: 0,
                    cacheCreationTokens: 0,
                    outputTokens: 5,
                    reasoningTokens: 0,
                  },
                  reportedCostUsd: 3,
                  dedupeKey: "record-1",
                },
              },
            ],
          }),
        ),
      );
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-hourly-ledger-test",
            baseDir,
            home,
            settings,
          }),
        ),
      );
      const result = yield* service.readSummary({
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-08-01"),
        untilDay: UsageDay.make("2026-08-02"),
        resolution: "hour",
        sinceTime: "2026-08-01T00:30:00.000Z",
        untilTime: "2026-08-02T00:30:00.000Z",
      });
      assert.strictEqual(result.coverage?.availableThroughTime, "2026-08-01T23:30:00.000Z");
      assert.deepStrictEqual(
        result.buckets.map((bucket) => bucket.hourStart),
        ["2026-08-01T22:30:00.000Z"],
      );
      assert.strictEqual(result.buckets[0]?.costUsd, 3);
    }).pipe(Effect.scoped),
  );

  it.live("returns an empty last-good hourly view when ledger coverage predates the window", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const baseDir = NodePath.join(home, "stale-hourly-ledger-state");
      const stateDir = NodePath.join(baseDir, "userdata");
      yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-record-ledger.json"),
          JSON.stringify({
            version: 1,
            generatedAtMs: Date.parse("2026-09-02T00:00:00.000Z"),
            records: [],
          }),
        ),
      );
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-stale-hourly-ledger-test",
            baseDir,
            home,
            settings,
          }),
        ),
      );

      const result = yield* service.readSummary({
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-09-03"),
        untilDay: UsageDay.make("2026-09-04"),
        resolution: "hour",
        sinceTime: "2026-09-03T00:00:00.000Z",
        untilTime: "2026-09-04T00:00:00.000Z",
      });

      assert.deepStrictEqual(result.buckets, []);
      assert.strictEqual(result.coverage?.availableThroughTime, "2026-09-02T00:00:00.000Z");
    }).pipe(Effect.scoped),
  );

  it.live("bounds hourly coverage at scan start", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const ratesGate = yield* Deferred.make<void>();
      const ratesStarted = yield* Deferred.make<void>();
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-scan-start-coverage-test",
            home,
            settings,
            ratesGate,
            ratesStarted,
          }),
        ),
      );
      const untilMs = Math.floor(Date.now() / (30 * 60_000)) * (30 * 60_000) + 60 * 60_000;
      const sinceMs = untilMs - 23 * 60 * 60_000;
      const input: UsageSummaryInput = {
        timeZone: "UTC",
        sinceDay: UsageDay.make(new Date(sinceMs).toISOString().slice(0, 10)),
        untilDay: UsageDay.make(new Date(untilMs).toISOString().slice(0, 10)),
        resolution: "hour",
        sinceTime: new Date(sinceMs).toISOString(),
        untilTime: new Date(untilMs).toISOString(),
      };
      const refresh = yield* service.refreshSummary(input).pipe(Effect.forkChild);
      yield* Deferred.await(ratesStarted);
      yield* Deferred.succeed(ratesGate, undefined);
      const result = yield* Fiber.join(refresh);
      assert.isTrue(
        Date.parse(result.coverage!.availableThroughTime!) <=
          Date.parse(result.coverage!.generatedAt),
      );
    }).pipe(Effect.scoped),
  );

  it.live("does not include records timestamped after scan start", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const future = new Date(Date.now() + 5 * 60_000).toISOString();
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, future)));
      const ratesGate = yield* Deferred.make<void>();
      const ratesStarted = yield* Deferred.make<void>();
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-scan-start-filter-test",
            home,
            settings,
            ratesGate,
            ratesStarted,
          }),
        ),
      );
      const nowMs = Date.now();
      const sinceMs = nowMs - 60 * 60_000;
      const untilMs = nowMs + 60 * 60_000;
      const input: UsageSummaryInput = {
        timeZone: "UTC",
        sinceDay: UsageDay.make(new Date(sinceMs).toISOString().slice(0, 10)),
        untilDay: UsageDay.make(new Date(untilMs).toISOString().slice(0, 10)),
        resolution: "hour",
        sinceTime: new Date(sinceMs).toISOString(),
        untilTime: new Date(untilMs).toISOString(),
      };
      const refresh = yield* service.refreshSummary(input).pipe(Effect.forkChild);
      yield* Deferred.await(ratesStarted);
      yield* Deferred.succeed(ratesGate, undefined);
      const result = yield* Fiber.join(refresh);
      assert.strictEqual(totalOutputTokens(result), 0);
    }).pipe(Effect.scoped),
  );

  it.live("uses an exact scan for unaligned 24-hour windows", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          transcript,
          claudeLine(1, 5, "2026-08-01T04:36:59.000Z") +
            claudeLine(2, 7, "2026-08-01T04:37:00.000Z"),
        ),
      );
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-unaligned-hour-test", home, settings }),
        ),
      );
      const result = yield* service.refreshSummary({
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-08-01"),
        untilDay: UsageDay.make("2026-08-02"),
        resolution: "hour",
        sinceTime: "2026-08-01T04:37:00.000Z",
        untilTime: "2026-08-02T04:37:00.000Z",
      });
      assert.strictEqual(totalOutputTokens(result), 7);
    }).pipe(Effect.scoped),
  );

  it.live("keeps v1 null-cost records priceable during migration", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const baseDir = NodePath.join(home, "v1-ledger-state");
      const stateDir = NodePath.join(baseDir, "userdata");
      yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-record-ledger.json"),
          JSON.stringify({
            version: 1,
            generatedAtMs: Date.parse("2026-08-02T00:00:00.000Z"),
            records: [
              {
                hostId: "mac",
                provider: "claude",
                resolvedHomePath: "/a/.claude",
                volumeId: "vol-1",
                record: {
                  provider: "claude",
                  timestampMs: Date.parse("2026-08-01T10:00:00.000Z"),
                  model: "claude-fable-5",
                  sessionId: "session-1",
                  totals: {
                    uncachedInputTokens: 0,
                    cachedInputTokens: 0,
                    cacheCreationTokens: 0,
                    outputTokens: 5,
                    reasoningTokens: 0,
                  },
                  reportedCostUsd: null,
                  dedupeKey: "record-1",
                },
              },
              {
                hostId: "mac",
                provider: "claude",
                resolvedHomePath: "/a/.claude",
                volumeId: "vol-1",
                record: {
                  provider: "claude",
                  timestampMs: Date.parse("2026-08-01T10:01:00.000Z"),
                  model: "unknown-model",
                  sessionId: "session-1",
                  totals: {
                    uncachedInputTokens: 0,
                    cachedInputTokens: 0,
                    cacheCreationTokens: 0,
                    outputTokens: 3,
                    reasoningTokens: 0,
                  },
                  reportedCostUsd: null,
                  dedupeKey: "record-2",
                },
              },
            ],
          }),
        ),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(stateDir, "usage-model-rates.json"),
          JSON.stringify({
            fetchedAtMs: Date.now(),
            document: {
              "claude-fable-5": { input_cost_per_token: 1, output_cost_per_token: 2 },
            },
          }),
        ),
      );
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-v1-migration-test", baseDir, home, settings }),
        ),
      );
      const result = yield* service.readSummary(currentCanonicalWindow());
      assert.strictEqual(totalOutputTokens(result), 8);
      assert.strictEqual(
        result.buckets.find((bucket) => bucket.model === "claude-fable-5")?.costUsd,
        10,
      );
      assert.strictEqual(
        result.buckets.find((bucket) => bucket.model === "unknown-model")?.unpricedRecords,
        1,
      );
    }).pipe(Effect.scoped),
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
      matchesTarget("/claude/C--Users-Alex-App--wt-thread-1/legacy-session.jsonl", windowsTarget),
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
