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
import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

function claudeLine(
  id: number,
  outputTokens: number,
  timestamp = "2026-08-01T10:00:00Z",
  messageId = `msg_${id}`,
  requestId = `req_${id}`,
): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp,
    requestId,
    sessionId: "session-1",
    message: {
      id: messageId,
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
      const service = yield* UsageService.make.pipe(Effect.provide(layers));
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

  it.live("clears an interrupted canonical waiter so the next refresh can run", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const ratesGate = yield* Deferred.make<void>();
      const ratesStarted = yield* Deferred.make<void>();
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
      );
      const background = yield* service.startBackgroundRefresh.pipe(Effect.forkChild);
      yield* Deferred.await(ratesStarted);
      yield* Fiber.interrupt(background);
      yield* Deferred.succeed(ratesGate, undefined);

      const result = yield* service.refreshSummary(currentCanonicalWindow());
      assert.strictEqual(totalOutputTokens(result), 0);
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
});
