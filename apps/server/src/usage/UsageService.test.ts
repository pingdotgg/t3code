// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

function claudeLine(id: number, outputTokens: number, model = "claude-fable-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

/**
 * A minimal Antigravity generation record: `chat_model.usage.output_tokens`,
 * `chat_model.chat_start_metadata.created_at` (2026-08-01T10:00:00Z) and
 * `chat_model.response_model`, encoded as protobuf by hand.
 */
function antigravityGeneration(outputTokens: number): Uint8Array {
  const varint = (value: number): number[] => {
    const out: number[] = [];
    let remaining = value;
    do {
      let byte = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) byte |= 0x80;
      out.push(byte);
    } while (remaining > 0);
    return out;
  };
  const bytesField = (number: number, payload: number[]): number[] => [
    ...varint((number << 3) | 2),
    ...varint(payload.length),
    ...payload,
  ];
  const usage = [...varint(2 << 3), ...varint(10), ...varint(3 << 3), ...varint(outputTokens)];
  const createdAt = bytesField(4, [...varint(1 << 3), ...varint(1_785_578_400)]);
  const model = [...new TextEncoder().encode("gemini-3.8-flash")];
  const chatModel = [
    ...bytesField(4, usage),
    ...bytesField(9, createdAt),
    ...bytesField(19, model),
  ];
  return Uint8Array.from(bytesField(1, chatModel));
}

async function writeAntigravityConversation(dir: string, outputTokens: number) {
  await NodeFSP.mkdir(dir, { recursive: true });
  const database = new NodeSqlite.DatabaseSync(NodePath.join(dir, "conversation.db"));
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob)");
    database
      .prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)")
      .run(0, antigravityGeneration(outputTokens));
  } finally {
    database.close();
  }
}

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
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
  readonly geminiHome?: string;
  readonly onRatesFetch?: () => void;
  /** Defaults to an unparsable document so every scan retries the fetch. */
  readonly ratesDocument?: unknown;
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
      Layer.succeed(HostProcessEnvironment, {
        GROK_HOME: NodePath.join(input.home, "grok"),
        GEMINI_HOME: input.geminiHome ?? NodePath.join(input.home, "gemini"),
      }),
    ),
  );

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService", () => {
  it.live("counts Antigravity conversations kept under the state directory", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const conversations = NodePath.join(
          config.stateDir,
          "providers",
          "antigravity",
          "instance-hash",
          "antigravity-acp",
          "conversations",
        );
        yield* Effect.promise(() => NodeFSP.mkdir(conversations, { recursive: true }));
        const database = new NodeSqlite.DatabaseSync(
          NodePath.join(conversations, "conversation.db"),
        );
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob)");
        const insert = database.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
        insert.run(0, antigravityGeneration(26));
        database.close();

        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(
          first.buckets.map((bucket) => [bucket.provider, bucket.model, bucket.records]),
          [["antigravity", "gemini-3.8-flash", 1]],
        );
        assert.strictEqual(totalOutputTokens(first), 26);
        const managed = first.sources.findIndex(
          (source) => source.fingerprint.provider === "antigravity" && source.status === "ok",
        );
        assert.strictEqual(first.sources[managed]?.distinctSessions, 1);
        assert.strictEqual(first.buckets[0]?.source, managed);

        // A turn committed while the agent still holds the database lives in
        // the WAL only; the main file's size and mtime do not move.
        const appender = new NodeSqlite.DatabaseSync(
          NodePath.join(conversations, "conversation.db"),
        );
        appender
          .prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)")
          .run(1, antigravityGeneration(40));
        try {
          const second = yield* service.readSummary(WINDOW);
          assert.strictEqual(second.buckets[0]?.records, 2);
          assert.strictEqual(totalOutputTokens(second), 66);
        } finally {
          appender.close();
        }
      }).pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-antigravity-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("counts overlapping Antigravity roots and database aliases once", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const profile = NodePath.join(config.stateDir, "providers", "antigravity", "profile");
        const conversations = NodePath.join(profile, "antigravity-acp", "conversations");
        yield* Effect.promise(() => writeAntigravityConversation(conversations, 26));
        const service = yield* UsageService.make.pipe(
          Effect.provideService(HostProcessEnvironment, {
            GEMINI_HOME: profile,
            GROK_HOME: NodePath.join(home, "grok"),
          }),
        );
        for (let scan = 0; scan < 2; scan++) {
          const summary = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(summary), 26);
          assert.strictEqual(
            summary.buckets.reduce((sum, bucket) => sum + bucket.records, 0),
            1,
          );
          const sources = summary.sources.filter(
            (source) => source.fingerprint.provider === "antigravity" && source.status === "ok",
          );
          assert.strictEqual(sources.length, 1);
          assert.strictEqual(sources[0]?.scannedFiles, 1);
          assert.strictEqual(
            sources[0]?.fingerprint.resolvedHomePath,
            yield* Effect.promise(() => NodeFSP.realpath(conversations)),
          );
          if (scan === 0) {
            yield* Effect.promise(() =>
              NodeFSP.symlink(
                NodePath.join(conversations, "conversation.db"),
                NodePath.join(conversations, "alias.db"),
              ),
            );
          }
        }
        const appender = yield* Effect.acquireRelease(
          Effect.sync(
            () => new NodeSqlite.DatabaseSync(NodePath.join(conversations, "conversation.db")),
          ),
          (database) => Effect.sync(() => database.close()),
        );
        appender
          .prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)")
          .run(1, antigravityGeneration(40));
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 66);
      }).pipe(
        Effect.provide(serviceLayers({ prefix: "usage-overlapping-antigravity", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("merges a managed parent and another environment's symlinked standalone source", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const managedRoot = NodePath.join(config.stateDir, "providers", "antigravity");
        const sharedProfile = NodePath.join(managedRoot, "shared-profile");
        const sharedDir = NodePath.join(sharedProfile, "antigravity-acp", "conversations");
        yield* Effect.promise(() => writeAntigravityConversation(sharedDir, 26));
        yield* Effect.promise(() =>
          writeAntigravityConversation(
            NodePath.join(managedRoot, "private-profile", "antigravity-acp", "conversations"),
            13,
          ),
        );
        const alias = NodePath.join(home, "shared-profile-alias");
        yield* Effect.promise(() => NodeFSP.symlink(sharedProfile, alias, "dir"));
        const managed = yield* UsageService.make;
        const managedSummary = yield* managed.readSummary(WINDOW);
        const standaloneSummary = yield* Effect.gen(function* () {
          const otherConfig = yield* ServerConfig.ServerConfig;
          yield* Effect.promise(() =>
            writeAntigravityConversation(
              NodePath.join(
                otherConfig.stateDir,
                "providers",
                "antigravity",
                "private",
                "antigravity-acp",
                "conversations",
              ),
              11,
            ),
          );
          const standalone = yield* UsageService.make;
          return yield* standalone.readSummary(WINDOW);
        }).pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-standalone-antigravity",
              home,
              settings,
              geminiHome: alias,
              ratesDocument: {
                "gemini-3.8-flash": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
              },
            }),
          ),
        );
        assert.strictEqual(totalOutputTokens(managedSummary), 39);
        assert.strictEqual(totalOutputTokens(standaloneSummary), 37);
        const canonicalDir = yield* Effect.promise(() => NodeFSP.realpath(sharedDir));
        const managedSource = managedSummary.sources.find(
          (source) => source.fingerprint.resolvedHomePath === canonicalDir,
        );
        const standaloneSource = standaloneSummary.sources.find(
          (source) => source.fingerprint.resolvedHomePath === canonicalDir,
        );
        assert.ok(managedSource);
        assert.ok(standaloneSource);
        assert.deepStrictEqual(managedSource.fingerprint, standaloneSource.fingerprint);
        const environments = [
          {
            environmentId: EnvironmentId.make("a-managed"),
            label: "Managed",
            summary: managedSummary,
          },
          {
            environmentId: EnvironmentId.make("b-standalone"),
            label: "Standalone",
            summary: standaloneSummary,
          },
        ];
        for (const summaries of [environments, environments.toReversed()]) {
          const merged = mergeUsage(summaries, USAGE_CONTRACT_VERSION);
          assert.strictEqual(merged.outputTokens, 50);
          assert.strictEqual(merged.records, 3);
          assert.strictEqual(merged.sessions, 3);
          assert.closeTo(merged.costUsd, 30 * 1e-5 + 50 * 5e-5, 1e-12);
        }
      }).pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-managed-antigravity",
            home,
            settings,
            ratesDocument: {
              "gemini-3.8-flash": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
          }),
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

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      const second = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(second), 12);
    }).pipe(Effect.scoped),
  );

  it.live("does not share an in-flight scan after custom prices change", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const fileSystem = yield* FileSystem.FileSystem;
        const firstScanStarted = yield* Deferred.make<void>();
        const secondScanStarted = yield* Deferred.make<void>();
        const releaseRates = yield* Deferred.make<void>();
        let homeProbes = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: (path) =>
              fileSystem.exists(path).pipe(
                Effect.tap(() => {
                  if (path !== NodePath.join(home, "claude", ".claude", "projects"))
                    return Effect.void;
                  homeProbes += 1;
                  return Deferred.succeed(
                    homeProbes === 1 ? firstScanStarted : secondScanStarted,
                    undefined,
                  );
                }),
              ),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Deferred.await(releaseRates).pipe(
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
        yield* Deferred.await(secondScanStarted);
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
      yield* service.readSummary(WINDOW);
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
});
