// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
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

function piLine(id: string, outputTokens: number): string {
  return `${JSON.stringify({
    type: "message",
    id,
    timestamp: "2026-08-01T11:00:00Z",
    message: {
      role: "assistant",
      provider: "cliproxyapi",
      model: "gpt-5.6-sol",
      usage: {
        input: 20,
        output: outputTokens,
        cacheRead: 30,
        cacheWrite: 4,
        reasoning: 3,
        cost: { total: 0.25 },
      },
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
  const piTranscriptDir = NodePath.join(home, "pi", "sessions", "project");
  yield* Effect.promise(() =>
    Promise.all([
      NodeFSP.mkdir(transcriptDir, { recursive: true }),
      NodeFSP.mkdir(piTranscriptDir, { recursive: true }),
    ]),
  );
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    piTranscript: NodePath.join(piTranscriptDir, "pi-session.jsonl"),
    settings: {
      providers: {
        claudeAgent: { homePath: NodePath.join(home, "claude") },
        codex: { homePath: NodePath.join(home, "codex") },
        piAgent: { agentDir: NodePath.join(home, "pi") },
      },
    },
  };
});

const serviceLayers = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly piSessionDirEnv?: string;
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
        ...(input.piSessionDirEnv === undefined
          ? {}
          : { PI_CODING_AGENT_SESSION_DIR: input.piSessionDirEnv }),
      }),
    ),
  );

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService", () => {
  it.live("includes Pi sessions from the configured agent directory", () =>
    Effect.gen(function* () {
      const { piTranscript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(piTranscript, piLine("pi-entry-1", 7)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-pi-test", home, settings })),
      );

      const summary = yield* service.readSummary(WINDOW);
      const piBucket = summary.buckets.find((bucket) => bucket.provider === "pi");
      const piSource = summary.sources.find((source) => source.fingerprint.provider === "pi");

      assert.deepStrictEqual(piBucket?.totals, {
        uncachedInputTokens: 20,
        cachedInputTokens: 30,
        cacheCreationTokens: 4,
        outputTokens: 7,
        reasoningTokens: 3,
      });
      assert.strictEqual(piBucket?.model, "gpt-5.6-sol");
      assert.strictEqual(piBucket?.costUsd, 0.25);
      assert.strictEqual(piBucket?.costSource, "providerReported");
      assert.strictEqual(piSource?.distinctSessions, 1);
      assert.strictEqual(
        piSource?.fingerprint.resolvedHomePath,
        NodePath.join(home, "pi", "sessions"),
      );
    }).pipe(Effect.scoped),
  );

  it.live("uses PI_CODING_AGENT_SESSION_DIR when sessionDir is not configured", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const envSessionDir = NodePath.join(home, "pi-env-sessions");
      const envTranscript = NodePath.join(envSessionDir, "project", "pi-session.jsonl");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(envTranscript), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(envTranscript, piLine("pi-env-entry", 11)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-pi-env-test",
            home,
            settings,
            piSessionDirEnv: envSessionDir,
          }),
        ),
      );

      const summary = yield* service.readSummary(WINDOW);
      const piBucket = summary.buckets.find((bucket) => bucket.provider === "pi");
      const piSource = summary.sources.find((source) => source.fingerprint.provider === "pi");

      assert.strictEqual(piBucket?.totals.outputTokens, 11);
      assert.strictEqual(piSource?.fingerprint.resolvedHomePath, envSessionDir);
    }).pipe(Effect.scoped),
  );

  it.live("prefers configured Pi sessionDir over PI_CODING_AGENT_SESSION_DIR", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const configuredSessionDir = NodePath.join(home, "pi-configured-sessions");
      const envSessionDir = NodePath.join(home, "pi-env-sessions");
      const configuredTranscript = NodePath.join(configuredSessionDir, "project", "pi.jsonl");
      const envTranscript = NodePath.join(envSessionDir, "project", "pi.jsonl");
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.mkdir(NodePath.dirname(configuredTranscript), { recursive: true }),
          NodeFSP.mkdir(NodePath.dirname(envTranscript), { recursive: true }),
        ]),
      );
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.writeFile(configuredTranscript, piLine("pi-configured-entry", 13)),
          NodeFSP.writeFile(envTranscript, piLine("pi-env-entry", 97)),
        ]),
      );

      const configuredSettings = {
        ...settings,
        providers: {
          ...settings.providers,
          piAgent: { ...settings.providers.piAgent, sessionDir: configuredSessionDir },
        },
      };
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-pi-precedence-test",
            home,
            settings: configuredSettings,
            piSessionDirEnv: envSessionDir,
          }),
        ),
      );

      const summary = yield* service.readSummary(WINDOW);
      const piBucket = summary.buckets.find((bucket) => bucket.provider === "pi");
      const piSource = summary.sources.find((source) => source.fingerprint.provider === "pi");

      assert.strictEqual(piBucket?.totals.outputTokens, 13);
      assert.strictEqual(piSource?.fingerprint.resolvedHomePath, configuredSessionDir);
    }).pipe(Effect.scoped),
  );

  it.live("includes sessions from enabled explicit Pi provider instances", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const instanceSessionDir = NodePath.join(home, "pi-instance-sessions");
      const instanceTranscript = NodePath.join(instanceSessionDir, "project", "pi.jsonl");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(instanceTranscript), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(instanceTranscript, piLine("pi-instance-entry", 17)),
      );

      const instanceId = ProviderInstanceId.make("pi-work");
      const instanceSettings = {
        ...settings,
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("piAgent"),
            enabled: true,
            config: { sessionDir: instanceSessionDir },
          },
        },
      };
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-pi-instance-test",
            home,
            settings: instanceSettings,
          }),
        ),
      );

      const summary = yield* service.readSummary(WINDOW);
      const piBucket = summary.buckets.find((bucket) => bucket.provider === "pi");
      const piSource = summary.sources.find(
        (source) => source.fingerprint.resolvedHomePath === instanceSessionDir,
      );

      assert.strictEqual(piBucket?.totals.outputTokens, 17);
      assert.strictEqual(piSource?.fingerprint.resolvedHomePath, instanceSessionDir);
    }).pipe(Effect.scoped),
  );

  it.live("deduplicates Pi session directories shared by legacy and explicit instances", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const sharedSessionDir = NodePath.join(home, "pi-shared-sessions");
      const instanceSessionDir = NodePath.join(home, "pi-instance-sessions");
      const sharedTranscript = NodePath.join(sharedSessionDir, "project", "shared.jsonl");
      const instanceTranscript = NodePath.join(instanceSessionDir, "project", "instance.jsonl");
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.mkdir(NodePath.dirname(sharedTranscript), { recursive: true }),
          NodeFSP.mkdir(NodePath.dirname(instanceTranscript), { recursive: true }),
        ]),
      );
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.writeFile(sharedTranscript, piLine("pi-shared-entry", 5)),
          NodeFSP.writeFile(instanceTranscript, piLine("pi-instance-entry", 7)),
        ]),
      );

      const legacySettings = {
        ...settings,
        providers: {
          ...settings.providers,
          piAgent: { ...settings.providers.piAgent, sessionDir: sharedSessionDir },
        },
        providerInstances: {
          [ProviderInstanceId.make("pi-shared")]: {
            driver: ProviderDriverKind.make("piAgent"),
            enabled: true,
            config: { sessionDir: sharedSessionDir },
          },
          [ProviderInstanceId.make("pi-work")]: {
            driver: ProviderDriverKind.make("piAgent"),
            enabled: true,
            config: { sessionDir: instanceSessionDir },
          },
        },
      };
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-pi-instance-dedupe-test",
            home,
            settings: legacySettings,
          }),
        ),
      );

      const summary = yield* service.readSummary(WINDOW);
      const piBucket = summary.buckets.find((bucket) => bucket.provider === "pi");
      const piSources = summary.sources.filter((source) => source.fingerprint.provider === "pi");

      assert.strictEqual(piBucket?.totals.outputTokens, 12);
      assert.strictEqual(piSources.length, 2);
      assert.deepStrictEqual(
        new Set(piSources.map((source) => source.fingerprint.resolvedHomePath)),
        new Set([sharedSessionDir, instanceSessionDir]),
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
