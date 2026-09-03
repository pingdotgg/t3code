// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

function claudeLine(id: number, outputTokens: number): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model: "claude-fable-5",
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
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
  readonly baseDir?: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: () => void;
  readonly ratesGate?: Deferred.Deferred<void, never>;
  readonly ratesStarted?: Deferred.Deferred<void, never>;
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
            return HttpClientResponse.fromWeb(request, Response.json({}));
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

function currentCanonicalWindow(): UsageSummaryInput {
  const untilMs = Date.parse(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  return {
    timeZone: "UTC",
    sinceDay: UsageDay.make(
      new Date(untilMs - 89 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    ),
    untilDay: UsageDay.make(new Date(untilMs).toISOString().slice(0, 10)),
    resolution: "day",
  };
}

describe("UsageService", () => {
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
      const second = yield* service.refreshSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(second), 12);
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
      const canonical: UsageSummaryInput = {
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-06-05"),
        untilDay: UsageDay.make("2026-09-02"),
        resolution: "day",
      };
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
