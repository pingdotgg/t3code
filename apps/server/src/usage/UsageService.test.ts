// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  decodeScanCache,
  decodeScanCacheRetainSince,
  encodeScanCache,
  type ScanCache,
} from "./usageScanCache.ts";
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

/** The scan cache file is JSON of a shape `usageScanCache` narrows by hand. */
const JsonDocument = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeJsonDocument = Schema.decodeUnknownSync(JsonDocument);
const encodeJsonDocument = Schema.encodeSync(JsonDocument);

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
      Layer.succeed(HostProcessEnvironment, { GROK_HOME: NodePath.join(input.home, "grok") }),
    ),
  );

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService", () => {
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

  it.live("keeps transcripts older than the bounded retention cached after an all-time scan", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      // Well past the 90-day retention that bounded windows prune to.
      const nowMs = yield* Clock.currentTimeMillis;
      const staleMtimeSeconds = (nowMs - 200 * 24 * 60 * 60 * 1000) / 1000;
      yield* Effect.promise(() => NodeFSP.utimes(transcript, staleMtimeSeconds, staleMtimeSeconds));
      const allTime: UsageSummaryInput = { ...WINDOW, sinceDay: UsageDay.make("2020-01-01") };

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const service = yield* UsageService.make;

        const first = yield* service.readSummary(allTime);
        assert.strictEqual(totalOutputTokens(first), 5);

        // The bounded window skips the file by mtime; it used to evict the
        // entry too, turning the next all-time view into a cold re-parse.
        const bounded = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(bounded), 0);
        const cachePath = NodePath.join(config.stateDir, "usage-scan-cache.json");
        const persisted = yield* fileSystem.readFileString(cachePath);
        assert.isTrue(decodeScanCache(decodeJsonDocument(persisted)).has(transcript));

        // A restarted server learns the horizon from what it loads, so its
        // first bounded scan keeps the entry as well.
        const restarted = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), 0);
        const afterRestart = yield* fileSystem.readFileString(cachePath);
        assert.isTrue(decodeScanCache(decodeJsonDocument(afterRestart)).has(transcript));
      }).pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-all-time-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("still ages out old entries after a restart when no all-time scan ever ran", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const nowMs = yield* Clock.currentTimeMillis;
      // A cache left behind by bounded scans only: an entry that has since
      // aged past the retention, and no all-time marker.
      const aged: ScanCache = new Map([
        [
          transcript,
          {
            size: 1,
            mtimeMs: nowMs - 200 * 24 * 60 * 60 * 1000,
            provider: "claude",
            records: [],
            tailRecords: [],
            position: { resumeOffset: 1, guardLength: 1, guardHash: 0, codexState: null },
          },
        ],
      ]);

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const cachePath = NodePath.join(config.stateDir, "usage-scan-cache.json");
        yield* fileSystem.writeFileString(cachePath, encodeJsonDocument(encodeScanCache(aged)));

        const service = yield* UsageService.make;
        yield* service.readSummary(WINDOW);
        const persisted = yield* fileSystem.readFileString(cachePath);
        assert.isFalse(decodeScanCache(decodeJsonDocument(persisted)).has(transcript));
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-bounded-prune-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("protects an all-time scan's old entries from a bounded scan finishing mid-walk", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const nowMs = yield* Clock.currentTimeMillis;
      const staleMtimeSeconds = (nowMs - 200 * 24 * 60 * 60 * 1000) / 1000;
      yield* Effect.promise(() => NodeFSP.utimes(transcript, staleMtimeSeconds, staleMtimeSeconds));
      const allTime: UsageSummaryInput = { ...WINDOW, sinceDay: UsageDay.make("2020-01-01") };
      // Walked last, so by the time the all-time scan probes it the old
      // transcript is already in the cache and the prune has not run yet.
      const grokDir = NodePath.join(home, "grok", "sessions");

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const allTimeReachedGrok = yield* Deferred.make<void>();
        const releaseAllTime = yield* Deferred.make<void>();
        let grokProbes = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: (path) => {
              if (path !== grokDir) return fileSystem.exists(path);
              grokProbes += 1;
              if (grokProbes !== 1) return fileSystem.exists(path);
              return Deferred.succeed(allTimeReachedGrok, undefined).pipe(
                Effect.andThen(Deferred.await(releaseAllTime)),
                Effect.andThen(fileSystem.exists(path)),
              );
            },
          }),
        );

        const inFlight = yield* service.readSummary(allTime).pipe(Effect.forkChild);
        yield* Deferred.await(allTimeReachedGrok);
        // A bounded scan runs to completion, prune included, while the
        // all-time scan is still walking.
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 0);
        yield* Deferred.succeed(releaseAllTime, undefined);
        assert.strictEqual(totalOutputTokens(yield* Fiber.join(inFlight)), 5);

        const persisted = yield* fileSystem.readFileString(
          NodePath.join(config.stateDir, "usage-scan-cache.json"),
        );
        assert.isTrue(decodeScanCache(decodeJsonDocument(persisted)).has(transcript));
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-concurrent-prune-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("never lets an earlier, smaller snapshot land after a fuller one", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      // Only the all-time scan lists this one, so its snapshot is the only one
      // carrying the entry and the retention marker.
      const oldTranscript = NodePath.join(NodePath.dirname(transcript), "old.jsonl");
      yield* Effect.promise(() => NodeFSP.writeFile(oldTranscript, claudeLine(2, 7)));
      const nowMs = yield* Clock.currentTimeMillis;
      const staleMtimeSeconds = (nowMs - 200 * 24 * 60 * 60 * 1000) / 1000;
      yield* Effect.promise(() =>
        NodeFSP.utimes(oldTranscript, staleMtimeSeconds, staleMtimeSeconds),
      );
      const allTime: UsageSummaryInput = { ...WINDOW, sinceDay: UsageDay.make("2020-01-01") };
      const grokDir = NodePath.join(home, "grok", "sessions");

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const cachePath = NodePath.join(config.stateDir, "usage-scan-cache.json");
        const firstWriteStarted = yield* Deferred.make<void>();
        const releaseFirstWrite = yield* Deferred.make<void>();
        const allTimeWalked = yield* Deferred.make<void>();
        // Cache writes land here in completion order rather than on disk, so
        // the test sees exactly which snapshot won.
        const landed: string[] = [];
        let cacheWrites = 0;
        let grokProbes = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            // Grok is walked last: its probe resolving means the walk is done.
            exists: (path) =>
              fileSystem.exists(path).pipe(
                Effect.tap(() => {
                  if (path !== grokDir) return Effect.void;
                  grokProbes += 1;
                  return grokProbes === 2
                    ? Deferred.succeed(allTimeWalked, undefined)
                    : Effect.void;
                }),
              ),
            writeFileString: (path, data, options) => {
              if (path !== cachePath) return fileSystem.writeFileString(path, data, options);
              cacheWrites += 1;
              const land = Effect.sync(() => {
                landed.push(data);
              });
              if (cacheWrites !== 1) return land;
              return Deferred.succeed(firstWriteStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstWrite)),
                Effect.andThen(land),
              );
            },
          }),
        );

        const bounded = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(firstWriteStarted);
        // The all-time scan adds the old transcript and lowers the horizon
        // while the bounded snapshot, which has neither, is still being written.
        const allTimeScan = yield* service.readSummary(allTime).pipe(Effect.forkChild);
        yield* Deferred.await(allTimeWalked);
        yield* Deferred.succeed(releaseFirstWrite, undefined);
        assert.strictEqual(totalOutputTokens(yield* Fiber.join(bounded)), 5);
        assert.strictEqual(totalOutputTokens(yield* Fiber.join(allTimeScan)), 12);

        assert.strictEqual(landed.length, 2);
        const final = decodeJsonDocument(landed[1]);
        assert.isTrue(decodeScanCache(final).has(transcript));
        assert.isTrue(decodeScanCache(final).has(oldTranscript));
        assert.isNotNull(decodeScanCacheRetainSince(final));
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-write-barrier-test", home, settings }),
        ),
      );
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
