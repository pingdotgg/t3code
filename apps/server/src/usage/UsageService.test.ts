// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { UsageDay, type UsageSummaryInput, type UsageTokenTotals } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";
import * as usageTranscripts from "./usageTranscripts.ts";

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

/** Shaped after a real Codex rollout: session_meta, turn_context, then a token delta. */
function codexLines(input: {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): string {
  const sessionMeta = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T10:00:00Z",
    payload: { type: "session_meta", id: input.sessionId },
  });
  const turnContext = JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T10:00:01Z",
    payload: { type: "turn_context", model: input.model },
  });
  const tokenCount = JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T10:00:02Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input.inputTokens,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: input.outputTokens,
          reasoning_output_tokens: 0,
        },
      },
    },
  });
  return `${sessionMeta}\n${turnContext}\n${tokenCount}\n`;
}

const CODEX_MODEL = "gpt-5.6-sol";

/** Rates for `CODEX_MODEL`, so archived tokens can be asserted as priced. */
const CODEX_RATES = {
  [CODEX_MODEL]: { input_cost_per_token: 1e-6, output_cost_per_token: 1e-5 },
};

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

function totalTokens(summary: { buckets: readonly { totals: UsageTokenTotals }[] }) {
  return summary.buckets.reduce(
    (sum, bucket) => sum + usageTranscripts.totalTokens(bucket.totals),
    0,
  );
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
      const second = yield* service.readSummary(WINDOW);
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

  it.live("counts usage rotated into Codex's archived_sessions directory", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const codexHome = NodePath.join(home, "codex");
      const liveDir = NodePath.join(codexHome, "sessions", "2026", "08", "01");
      // Codex nests live rollouts under `YYYY/MM/DD` but writes the archive flat.
      const archivedDir = NodePath.join(codexHome, "archived_sessions");
      yield* Effect.promise(() => NodeFSP.mkdir(liveDir, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.mkdir(archivedDir, { recursive: true }));

      const rollout = (n: number) => `rollout-00000000-0000-0000-0000-00000000000${n}.jsonl`;
      const write = (dir: string, name: string, contents: string) =>
        Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, name), contents));

      // A rollout Codex has not archived yet.
      yield* write(
        liveDir,
        rollout(1),
        codexLines({
          sessionId: "live-session-1",
          model: CODEX_MODEL,
          inputTokens: 1000,
          outputTokens: 100,
        }),
      );
      // A rollout that has aged into the archive. Invisible before this fix.
      yield* write(
        archivedDir,
        rollout(2),
        codexLines({
          sessionId: "archived-session-1",
          model: CODEX_MODEL,
          inputTokens: 2000,
          outputTokens: 200,
        }),
      );
      // The same rollout under both roots: counted once, not twice.
      const shared = codexLines({
        sessionId: "shared-session-1",
        model: CODEX_MODEL,
        inputTokens: 4000,
        outputTokens: 400,
      });
      yield* write(liveDir, rollout(3), shared);
      yield* write(archivedDir, rollout(3), shared);
      // A rollout that reads empty under `sessions` - how one moved out
      // mid-scan looks - whose records are in the archive. The empty read must
      // not claim the basename and drop the copy that has the usage.
      yield* write(liveDir, rollout(4), "");
      yield* write(
        archivedDir,
        rollout(4),
        codexLines({
          sessionId: "moved-session-1",
          model: CODEX_MODEL,
          inputTokens: 8000,
          outputTokens: 800,
        }),
      );

      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-archived-test",
            home,
            settings,
            ratesDocument: CODEX_RATES,
          }),
        ),
      );

      const summary = yield* service.readSummary(WINDOW);

      // 100 + 200 + 400 (shared, once) + 800 (moved) = 1500. Double counting
      // the shared rollout gives 1900; dropping the moved one gives 700.
      assert.strictEqual(totalOutputTokens(summary), 1500);
      assert.strictEqual(totalTokens(summary), 16500);

      // Archived tokens are priced, not carried as unpriced volume.
      const codexBuckets = summary.buckets.filter((bucket) => bucket.provider === "codex");
      assert.isAbove(codexBuckets.length, 0);
      for (const bucket of codexBuckets) {
        assert.strictEqual(bucket.costSource, "modelPriced");
        assert.strictEqual(bucket.unpricedRecords, 0);
      }
      assert.isAbove(
        codexBuckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
        0,
      );

      const codexSources = summary.sources.filter(
        (source) => source.fingerprint.provider === "codex",
      );
      assert.deepStrictEqual(
        codexSources.map((source) => source.fingerprint.resolvedHomePath).sort(),
        [archivedDir, NodePath.join(codexHome, "sessions")].sort(),
      );

      const archivedSource = codexSources.find(
        (source) => source.fingerprint.resolvedHomePath === archivedDir,
      );
      assert.isDefined(archivedSource);
      assert.strictEqual(archivedSource?.status, "ok");
      // The archived-only rollout and the moved one; the shared duplicate is not a session here.
      assert.strictEqual(archivedSource?.distinctSessions, 2);

      // Six files on disk, four counted: the duplicate basename in the archive
      // and the empty live copy of the moved rollout are skipped.
      assert.strictEqual(
        codexSources.reduce((sum, source) => sum + source.scannedFiles, 0),
        4,
      );
      assert.strictEqual(
        codexSources.reduce((sum, source) => sum + source.skippedFiles, 0),
        2,
      );
    }).pipe(Effect.scoped),
  );

  it.live("keeps Claude transcripts that share a basename across projects", () =>
    Effect.gen(function* () {
      // The Codex rollout dedupe keys on basename alone, which is a Codex fact:
      // rollout names embed a UUID. Claude nests transcripts per project, so the
      // same basename under two projects is two different files and both have to
      // be read. Widening the dedupe past Codex silently drops the second one.
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const otherProject = NodePath.join(home, "claude", "projects", "proj-b");
      yield* Effect.promise(() => NodeFSP.mkdir(otherProject, { recursive: true }));
      yield* Effect.promise(() =>
        // Same basename as `transcript`, different project directory.
        NodeFSP.writeFile(NodePath.join(otherProject, "session.jsonl"), claudeLine(2, 7)),
      );

      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-claude-basename-test", home, settings }),
        ),
      );

      const summary = yield* service.readSummary(WINDOW);
      // Both files counted. Deduping Claude by basename would report only 5.
      assert.strictEqual(totalOutputTokens(summary), 12);

      const claudeSource = summary.sources.find(
        (source) => source.fingerprint.provider === "claude",
      );
      assert.strictEqual(claudeSource?.scannedFiles, 2);
      assert.strictEqual(claudeSource?.skippedFiles, 0);
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
