// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as CodexUsageHistory from "./CodexUsageHistory.ts";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as AntigravityUsage from "../provider/Drivers/AntigravityUsage.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import { totalTokens, type UsageRecord } from "@t3tools/provider-core/server/usage";
import * as UsageService from "./UsageService.ts";
import * as MuseSdk from "../../../../packages/provider-muse/src/server/sdk.ts";
import { MuseUsageHome } from "@t3tools/provider-muse/server";
import { makeScanCacheWriter, SCAN_CACHE_FILE_NAME } from "./usageScanCache.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../../../../packages/provider-muse/src/server/sdk.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof MuseSdk>()),
  createMuseSdkHostEffect: vi.fn(() =>
    Effect.try(() => {
      throw new Error("Muse is not installed in this test");
    }),
  ),
}));

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJsonString = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

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
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: NodePath.join(home, "claude") },
        },
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { homePath: NodePath.join(home, "codex") },
        },
      },
    },
  };
});

const layerCursorUsageAccounts = <E, R>(
  reader: Layer.Layer<CursorAccountReader.CursorAccountReader, E, R>,
) => Layer.fresh(CursorUsageAccounts.layer).pipe(Layer.provide(reader));

const makeWithCursor = (read: CursorAccountReader.CursorAccountReader["Service"]["read"]) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      layerCursorUsageAccounts(Layer.succeed(CursorAccountReader.CursorAccountReader, { read })),
    );
    const accounts = Context.get(context, CursorUsageAccounts.CursorUsageAccounts);
    const service = yield* UsageService.make.pipe(Effect.provideContext(context));
    return {
      ...service,
      awaitPersisted: Effect.andThen(service.awaitPersisted, accounts.awaitPersisted),
    };
  });

const layerService = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: (request: HttpClientRequest.HttpClientRequest) => void;
  readonly ratesDocument?: unknown;
  readonly ratesStatus?: () => number;
  readonly ratesResponse?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly hostname?: string;
}) =>
  layerCursorUsageAccounts(
    CursorAccountReader.layer.pipe(Layer.provide(CursorKeychain.layer)),
  ).pipe(
    Layer.provideMerge(AntigravityUsage.layer),
    Layer.provideMerge(MuseUsageHome.layer),
    Layer.provideMerge(ProviderHostLive.layer),
    Layer.provideMerge(CodexUsageHistory.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
    Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
    Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), NodePath.join(input.home, input.prefix)),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, input.platform ?? "linux")),
    Layer.provideMerge(Layer.succeed(HostProcess.Hostname, input.hostname ?? "usage-test-host")),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.suspend(() => {
            input.onRatesFetch?.(request);
            const response = input.ratesResponse
              ? input.ratesResponse(request)
              : Effect.succeed(
                  Response.json(input.ratesDocument ?? {}, {
                    status: input.ratesStatus?.() ?? 200,
                  }),
                );
            return response.pipe(
              Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
            );
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcess.Environment, {
        HOME: input.home,
        GROK_HOME: NodePath.join(input.home, "grok"),
        PI_CODING_AGENT_DIR: NodePath.join(input.home, "pi"),
        OPENCODE_DATA_DIR: NodePath.join(input.home, "opencode"),
        ANTIGRAVITY_DATA_DIR: NodePath.join(input.home, "antigravity"),
        XDG_CONFIG_HOME: NodePath.join(input.home, "config"),
        APPDATA: NodePath.join(input.home, "config"),
        ...input.environment,
      }),
    ),
  );

const BEFORE_NARROW_WINDOW = Date.parse("2026-08-01T10:00:00Z") / 1000;
const NARROW_WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-02"),
};

// Each waiting gate holds a libuv thread; allow at most three.
const makeGate = (path: string, lastWriteSeconds?: number) =>
  Effect.promise(async () => {
    NodeChildProcess.execFileSync("mkfifo", [path]);
    if (lastWriteSeconds !== undefined) {
      await NodeFSP.utimes(path, lastWriteSeconds, lastWriteSeconds);
    }
  });

const openGate = (path: string) =>
  Effect.promise(async () => (await NodeFSP.open(path, "w")).close());

const replaceFile = (path: string, content: string) =>
  Effect.promise(async () => {
    await NodeFSP.writeFile(path + ".next", content);
    await NodeFSP.rename(path + ".next", path);
  });

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

const CURSOR_NOW = Date.parse("2026-08-02T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

function makeFakeCursor() {
  const state = {
    accountKey: "account-a",
    events: [] as { readonly timestampMs: number; readonly outputTokens: number }[],
    error: null as string | null,
    gate: undefined as Deferred.Deferred<void> | undefined,
    calls: [] as { readonly sinceMs: number; readonly untilMs: number }[],
  };
  const read = (_credential: unknown, sinceMs: number, untilMs: number) =>
    Effect.gen(function* () {
      state.calls.push({ sinceMs, untilMs });
      if (state.gate !== undefined) yield* Deferred.await(state.gate);
      const { accountKey, error } = state;
      if (error !== null) return { accountKey, records: [], missing: false, error };
      const occurrences = new Map<string, number>();
      const records = state.events
        .filter(({ timestampMs }) => timestampMs >= sinceMs && timestampMs <= untilMs)
        .map(({ timestampMs, outputTokens }): UsageRecord => {
          const key = `${timestampMs}:${outputTokens}`;
          const occurrence = occurrences.get(key) ?? 0;
          occurrences.set(key, occurrence + 1);
          return {
            provider: "cursor",
            timestampMs,
            model: "claude-fable-5",
            sessionId: "conversation-1",
            totals: {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens,
              reasoningTokens: 0,
            },
            reportedCostUsd: null,
            speed: "standard",
            dedupeKey: `cursor-account:${accountKey}:${key}:${occurrence}`,
          };
        });
      return { accountKey, records, missing: false, error: null };
    });
  return { state, read };
}

const writeCursorLogin = (home: string) =>
  Effect.promise(async () => {
    const authPath = NodePath.join(home, "config", "cursor", "auth.json");
    await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
    await NodeFSP.writeFile(authPath, "{}");
  });

function cursorSource(summary: { readonly sources: readonly UsageSource[] }) {
  return summary.sources.find((source) => source.fingerprint.provider === "cursor");
}

const seedCodexHistory = (input: {
  id: string;
  nativeTurnId?: string;
  sessionId?: string;
  model?: string;
  options?: readonly { id: string; value: string | boolean }[];
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { id } = input;
    const selection = {
      instanceId: "codex",
      model: input.model ?? "gpt-6-astra",
      options: input.options ?? [{ id: "serviceTier", value: "priority" }],
    };
    const run = {
      id: `run-${id}`,
      activeAttemptId: `attempt-${id}`,
      status: "running",
      modelSelection: selection,
    };
    yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
      attempt_id: run.activeAttemptId,
      thread_id: `thread-${id}`,
      run_id: run.id,
      attempt_ordinal: 1,
      root_node_id: `node-${id}`,
      provider: "codex",
      provider_thread_id: `provider-thread-${id}`,
      provider_turn_id: `turn-${id}`,
      status: "completed",
      payload_json: encodeUnknownJsonString({ nativeThreadId: input.sessionId ?? "session" }),
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
      provider_turn_id: `turn-${id}`,
      thread_id: `thread-${id}`,
      provider_thread_id: `provider-thread-${id}`,
      node_id: `node-${id}`,
      run_attempt_id: run.activeAttemptId,
      ordinal: 1,
      status: "completed",
      payload_json: encodeUnknownJsonString({
        nativeTurnRef: { driver: "codex", nativeId: input.nativeTurnId ?? id, strength: "strong" },
      }),
    })}`;
    const changedSelection = {
      ...selection,
      options: [{ id: "serviceTier", value: "ultrafast" }],
    };
    // These selections disagree so reading the current projection or the wrong event is visible.
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: run.id,
      thread_id: `thread-${id}`,
      ordinal: 1,
      provider: "codex",
      provider_thread_id: `provider-thread-${id}`,
      status: "completed",
      requested_at: "2026-08-01T10:00:00Z",
      payload_json: encodeUnknownJsonString({
        ...run,
        status: "completed",
        modelSelection: { ...selection, options: [] },
      }),
    })}`;
    for (const [index, payload] of [
      { ...run, activeAttemptId: "earlier-attempt", modelSelection: changedSelection },
      { ...run, status: "queued", modelSelection: changedSelection },
      run,
      { ...run, modelSelection: changedSelection },
    ].entries()) {
      yield* sql`INSERT INTO orchestration_events ${sql.insert({
        event_id: `event-${id}-${index}`,
        aggregate_kind: "thread",
        stream_id: `thread-${id}`,
        stream_version: index + 1,
        event_type: "run.updated",
        occurred_at: "2026-08-01T10:00:00Z",
        actor_kind: "system",
        metadata_json: "{}",
        application_event_version: 2,
        payload_json: encodeUnknownJsonString(payload),
      })}`;
    }
  });

describe("Codex usage history", () => {
  const historyLayer = CodexUsageHistory.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
  const request = (nativeTurnId: string) => ({
    sessionId: "session",
    nativeTurnId,
    model: "gpt-6-astra",
  });

  it.effect("resolves a batch from each attempt's first running selection", () =>
    Effect.gen(function* () {
      yield* seedCodexHistory({ id: "fast" });
      yield* seedCodexHistory({
        id: "ultrafast",
        options: [{ id: "serviceTier", value: "ultrafast" }],
      });
      yield* seedCodexHistory({ id: "legacy-option", options: [{ id: "fastMode", value: true }] });
      yield* seedCodexHistory({ id: "standard", options: [] });
      const requests = ["fast", "ultrafast", "legacy-option", "standard", "fast"].map(request);
      const history = yield* CodexUsageHistory.CodexUsageHistory;
      const resolved = yield* history.resolve(requests);
      assert.strictEqual(resolved.size, requests.length);
      assert.deepStrictEqual(
        requests.map((item) => resolved.get(item)),
        ["fast", "ultrafast", "fast", "standard", "fast"],
      );
    }).pipe(Effect.provide(historyLayer)),
  );

  it.effect("leaves ambiguous, mismatched, and missing V2 evidence unresolved", () =>
    Effect.gen(function* () {
      for (const id of [
        "valid",
        "duplicate-model",
        "duplicate-session",
        "imported",
        "v1-event",
        "queued",
        "missing-selection",
      ]) {
        yield* seedCodexHistory({ id });
      }
      yield* seedCodexHistory({
        id: "second-model",
        nativeTurnId: "duplicate-model",
        model: "other-model",
      });
      yield* seedCodexHistory({
        id: "second-session",
        nativeTurnId: "duplicate-session",
        sessionId: "other-session",
      });
      yield* seedCodexHistory({ id: "wrong-model", model: "other-model" });
      yield* seedCodexHistory({ id: "wrong-session", sessionId: "other-session" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_provider_turns
        SET run_attempt_id = NULL WHERE provider_turn_id = 'turn-imported'`;
      yield* sql`DELETE FROM orchestration_v2_projection_run_attempts WHERE attempt_id = 'attempt-imported'`;
      yield* sql`UPDATE orchestration_events SET application_event_version = 1
        WHERE stream_id = 'thread-v1-event'`;
      yield* sql`UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.status', 'queued')
        WHERE stream_id = 'thread-queued'`;
      yield* sql`UPDATE orchestration_events
        SET payload_json = json_remove(payload_json, '$.modelSelection')
        WHERE event_id = 'event-missing-selection-2'`;
      const requests = [
        "valid",
        "duplicate-model",
        "duplicate-session",
        "wrong-model",
        "wrong-session",
        "missing-turn",
        "imported",
        "v1-event",
        "queued",
        "missing-selection",
      ].map(request);
      const history = yield* CodexUsageHistory.CodexUsageHistory;
      const resolved = yield* history.resolve(requests);
      assert.deepStrictEqual([...resolved], [[requests[0], "fast"]]);
    }).pipe(Effect.provide(historyLayer)),
  );

  it.effect(
    "reports SQL failures through the typed channel and can resolve again after repair",
    () =>
      Effect.gen(function* () {
        yield* seedCodexHistory({ id: "retry" });
        const history = yield* CodexUsageHistory.CodexUsageHistory;
        const sql = yield* SqlClient.SqlClient;
        const input = request("retry");
        yield* sql`ALTER TABLE orchestration_events RENAME TO unavailable_events`;
        const error = yield* Effect.flip(history.resolve([input]));
        assert.instanceOf(error, CodexUsageHistory.CodexUsageHistoryReadError);
        assert.strictEqual(error.requestedTurnCount, 1);
        yield* sql`ALTER TABLE unavailable_events RENAME TO orchestration_events`;
        assert.strictEqual((yield* history.resolve([input])).get(input), "fast");
      }).pipe(Effect.provide(historyLayer)),
  );
});

describe("UsageService", () => {
  it.effect("keeps pricing metadata paired with the rates used during a concurrent refresh", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const sessions = NodePath.join(home, "codex", "sessions");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(sessions, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(sessions, "session.jsonl"),
          [
            { type: "session_meta", payload: { id: "session", model_provider: "openai" } },
            { type: "turn_context", payload: { model: "gpt-6-astra", turn_id: "turn" } },
            {
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 0, output_tokens: 1 } },
              },
            },
          ]
            .map((record) => encodeUnknownJsonString(record))
            .join("\n") + "\n",
        );
      });
      let rate = 0;
      yield* Effect.gen(function* () {
        const resolving = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const service = yield* UsageService.make.pipe(
          Effect.provideService(CodexUsageHistory.CodexUsageHistory, {
            resolve: () =>
              Deferred.succeed(resolving, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(new Map()),
              ),
          }),
        );
        const initialPricing = yield* service.refreshRates;
        yield* TestClock.adjust(61_000);
        const pending = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(resolving);
        yield* service.refreshRates;
        yield* Deferred.succeed(release, undefined);
        const original = yield* Fiber.join(pending);
        assert.strictEqual(original.buckets[0]?.costUsd, 1);
        assert.strictEqual(original.pricing.fetchedAt, initialPricing.fetchedAt);
        const updated = yield* service.readSummary(WINDOW);
        assert.strictEqual(updated.buckets[0]?.costUsd, 2);
        assert.notStrictEqual(updated.pricing.fetchedAt, initialPricing.fetchedAt);
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "concurrent-rates",
            home,
            settings,
            ratesResponse: () =>
              Effect.succeed(
                Response.json({
                  "gpt-6-astra": { input_cost_per_token: 0, output_cost_per_token: ++rate },
                }),
              ),
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("shows saved usage before refreshing changed transcripts after restart", () =>
    Effect.gen(function* () {
      const { home, settings, transcript } = yield* setup;
      let ratesFetches = 0;
      const ratesDocument = {
        "claude-fable-5": { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
      };
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.gen(function* () {
        const first = yield* UsageService.make;
        const cold = yield* first.readSummary({ ...WINDOW, preferCached: true });
        assert.strictEqual(totalOutputTokens(cold), 0);
        assert.strictEqual(
          cold.sources.some((source) => source.refreshing),
          true,
        );
        assert.strictEqual(totalOutputTokens(yield* first.readSummary(WINDOW)), 5);
        yield* first.awaitPersisted;
        yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
        const config = yield* ServerConfig.ServerConfig;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(config.stateDir, "usage-model-rates.json"),
            encodeUnknownJsonString({ fetchedAtMs: 0, document: ratesDocument }),
          ),
        );

        const restarted = yield* UsageService.make;
        const savedInput = { ...WINDOW, preferCached: true };
        const saved = yield* restarted.readSummary(savedInput);
        assert.strictEqual(totalOutputTokens(saved), 5);
        assert.strictEqual(saved.pricing.status, "cached");
        assert.strictEqual(ratesFetches, 1);
        assert.strictEqual(
          saved.sources.find((source) => source.fingerprint.provider === "claude")?.refreshing,
          true,
        );
        const fresh = yield* restarted.readSummary({ ...savedInput, awaitRefresh: true });
        assert.strictEqual(totalOutputTokens(fresh), 12);
        assert.strictEqual(fresh.pricing.status, "fresh");
        assert.strictEqual(ratesFetches, 2);
        assert.strictEqual(
          fresh.sources.some((source) => source.refreshing),
          false,
        );
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "saved-first",
            home,
            settings,
            ratesDocument,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("keeps the first host identity across recreation and explicit override removal", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      for (const [hostname, override, expected] of [
        ["container-a", undefined, "container-a"],
        ["container-b", undefined, "container-a"],
        ["container-c", "physical-host", "physical-host"],
        ["container-d", undefined, "container-a"],
      ] as const) {
        const summary = yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          return yield* service.readSummary(WINDOW);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-host-id",
              home,
              settings,
              hostname,
              environment: override === undefined ? {} : { T3CODE_HOST_ID: override },
            }),
          ),
        );
        const source = summary.sources.find((source) => source.fingerprint.provider === "claude");
        assert.strictEqual(source?.fingerprint.hostId, expected);
      }
    }).pipe(Effect.scoped),
  );

  it.live("concurrent initialization keeps one host identity across service recreation", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const prefix = "usage-host-id-race";
      const hostIdPath = NodePath.join(home, prefix, "usage-host-id");
      const bothRead = yield* Deferred.make<void>();
      let reads = 0;
      const summaries = yield* Effect.forEach(
        ["container-a", "container-b"],
        (hostname) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            let firstRead = true;
            const service = yield* UsageService.make.pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fileSystem,
                readFileString: (path, encoding) =>
                  Effect.gen(function* () {
                    if (path !== hostIdPath || !firstRead) {
                      return yield* fileSystem.readFileString(path, encoding);
                    }
                    firstRead = false;
                    // Both instances observe the missing file before either can create it.
                    const result = yield* Effect.exit(fileSystem.readFileString(path, encoding));
                    reads += 1;
                    if (reads === 2) yield* Deferred.succeed(bothRead, undefined);
                    yield* Deferred.await(bothRead);
                    return yield* result;
                  }),
              }),
            );
            return yield* service.readSummary(WINDOW);
          }).pipe(
            Effect.scoped,
            Effect.provide(layerService({ prefix, home, settings, hostname })),
          ),
        { concurrency: "unbounded" },
      );
      const persisted = yield* Effect.promise(() => NodeFSP.readFile(hostIdPath, "utf8"));
      const hostId = persisted.trim();
      assert.include(["container-a", "container-b"], hostId);
      const restarted = yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        return yield* service.readSummary(WINDOW);
      }).pipe(
        Effect.scoped,
        Effect.provide(layerService({ prefix, home, settings, hostname: "container-c" })),
      );
      for (const summary of [...summaries, restarted]) {
        const source = summary.sources.find((source) => source.fingerprint.provider === "claude");
        assert.strictEqual(source?.fingerprint.hostId, hostId);
      }
    }).pipe(Effect.scoped),
  );

  it.live(
    "repairs initial Codex prices after unchanged-file retries, persists evidence and corrections, and honors later native tiers",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const sessions = NodePath.join(home, "codex", "sessions");
        const fastPath = NodePath.join(sessions, "fast.jsonl");
        const ultraPath = NodePath.join(sessions, "ultra.jsonl");
        const meta = (id: string) => ({
          type: "session_meta",
          payload: { id, model_provider: "openai" },
        });
        const context = (turn_id?: string) => ({
          type: "turn_context",
          payload: { model: "gpt-6-astra", turn_id },
        });
        const usage = (output_tokens: number) => ({
          type: "event_msg",
          timestamp: "2026-08-01T10:00:00Z",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 0, output_tokens } },
          },
        });
        const tier = (service_tier?: string) => ({
          type: "event_msg",
          payload: { type: "thread_settings_applied", thread_settings: { service_tier } },
        });
        const lines = (records: readonly unknown[]) =>
          records.map((record) => encodeUnknownJsonString(record)).join("\n") + "\n";
        const verify = (summary: UsageSummary, output: number, cost: number) => {
          assert.strictEqual(totalOutputTokens(summary), output);
          assert.strictEqual(
            summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            cost,
          );
        };
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sessions, { recursive: true });
          await NodeFSP.writeFile(
            fastPath,
            lines([meta("fast-session"), context("fast-turn"), usage(1)]) +
              encodeUnknownJsonString(usage(2)),
          );
          await NodeFSP.writeFile(
            ultraPath,
            lines([meta("ultra-session"), context("ultra-turn"), usage(4)]),
          );
        });
        yield* Effect.gen(function* () {
          const first = yield* UsageService.make;
          verify(yield* first.readSummary(WINDOW), 7, 7);
          yield* first.awaitPersisted;
          const pending = yield* UsageService.make;
          verify(yield* pending.readSummary(WINDOW), 7, 7);
          yield* seedCodexHistory({ id: "fast-turn", sessionId: "fast-session" });
          yield* seedCodexHistory({
            id: "ultra-turn",
            sessionId: "ultra-session",
            options: [{ id: "serviceTier", value: "ultrafast" }],
          });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`ALTER TABLE orchestration_events RENAME TO unavailable_events`;
          verify(yield* pending.readSummary(WINDOW), 7, 7);
          yield* pending.awaitPersisted;
          const retry = yield* UsageService.make;
          verify(yield* retry.readSummary(WINDOW), 7, 7);
          yield* sql`ALTER TABLE unavailable_events RENAME TO orchestration_events`;
          // History repair must touch both the committed record and tentative tail.
          verify(yield* retry.readSummary(WINDOW), 7, 30);
          yield* retry.awaitPersisted;
          yield* sql`ALTER TABLE orchestration_events RENAME TO resolved_events`;
          verify(yield* retry.readSummary(WINDOW), 7, 30);
          const resolved = yield* UsageService.make;
          verify(yield* resolved.readSummary(WINDOW), 7, 30);
          yield* sql`ALTER TABLE resolved_events RENAME TO orchestration_events`;

          // Completing the tail reparses it; neither an absent turn ID nor a new
          // turn with no retained attempt may inherit the inferred Fast speed.
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              fastPath,
              "\n" + lines([context(), usage(3), context("unretained-turn"), usage(4)]),
            ),
          );
          verify(yield* resolved.readSummary(WINDOW), 14, 37);
          yield* seedCodexHistory({
            id: "native-turn",
            sessionId: "fast-session",
            options: [{ id: "serviceTier", value: "ultrafast" }],
          });
          yield* seedCodexHistory({ id: "later-native-turn", sessionId: "fast-session" });
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              fastPath,
              lines([
                context("native-turn"),
                tier(),
                usage(5),
                context("later-native-turn"),
                usage(6),
                tier("priority"),
              ]) + encodeUnknownJsonString(usage(7)),
            ),
          );
          verify(yield* resolved.readSummary(WINDOW), 32, 62);
          yield* resolved.awaitPersisted;
          const native = yield* UsageService.make;
          verify(yield* native.readSummary(WINDOW), 32, 62);
          yield* seedCodexHistory({
            id: "after-restart-native",
            sessionId: "fast-session",
            options: [{ id: "serviceTier", value: "ultrafast" }],
          });
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              fastPath,
              "\n" +
                lines([context("after-restart-native"), usage(8), tier("ultrafast"), usage(9)]),
            ),
          );
          verify(yield* native.readSummary(WINDOW), 49, 132);
          yield* native.awaitPersisted;
          yield* Effect.promise(async () => {
            await NodeFSP.rm(fastPath);
            await NodeFSP.rm(ultraPath);
          });
          yield* sql`DELETE FROM orchestration_events`;
          const deleted = yield* UsageService.make;
          verify(yield* deleted.readSummary(WINDOW), 49, 132);
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-initial-tier",
              home,
              settings,
              ratesDocument: {
                "gpt-6-astra": {
                  input_cost_per_token: 0,
                  output_cost_per_token: 1,
                  input_cost_per_token_priority: 0,
                  output_cost_per_token_priority: 2,
                  input_cost_per_token_ultrafast: 0,
                  output_cost_per_token_ultrafast: 6,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "reads Pi per-model usage and auxiliary costs once across forks and repeated entries",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const dir = NodePath.join(home, "pi", "sessions", "project");
        const usage = {
          input: 10,
          output: 5,
          cacheRead: 20,
          cacheWrite: 3,
          reasoning: 2,
          totalTokens: 38,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
        };
        const parent = {
          type: "message",
          id: "a123abcd",
          parentId: null,
          timestamp: "2026-08-01T10:00:00Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "requested-model",
            responseModel: "actual-model",
            usage,
          },
        };
        const auxiliary = [
          {
            type: "message",
            id: "tool",
            message: { role: "toolResult", toolName: "classify", usage },
          },
          {
            type: "message",
            id: "image",
            message: {
              role: "toolResult",
              toolName: "image",
              usage: { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          },
          { type: "compaction", id: "compact", usage },
          { type: "branch_summary", id: "summary", usage },
        ].map((entry) => ({ ...entry, timestamp: "2026-08-01T11:00:00Z" }));
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "parent.jsonl"),
            [
              { type: "session", id: "parent" },
              parent,
              ...auxiliary,
              {
                type: "usage",
                id: "warm",
                timestamp: "2026-08-01T12:00:00Z",
                kind: "cache_warm",
                provider: "openai",
                model: "actual-model",
                usage: { ...usage, cost: { ...usage.cost, total: 0 } },
              },
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
          await NodeFSP.writeFile(
            NodePath.join(dir, "fork.jsonl"),
            [
              { type: "session", id: "fork", parentSession: NodePath.join(dir, "parent.jsonl") },
              { ...parent, parentId: "relinked" },
              parent,
              ...auxiliary,
              {
                ...parent,
                timestamp: "2026-08-01T13:00:00Z",
                message: { ...parent.message, provider: "openai", responseModel: "another-model" },
              },
              { type: "get_session_stats", usage: { ...usage, cost: { total: 1000 } } },
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
        });
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          const pi = first.buckets.filter((bucket) => bucket.provider === "pi");
          assert.strictEqual(
            pi.reduce((total, bucket) => total + bucket.costUsd, 0),
            44,
          );
          assert.strictEqual(
            pi.reduce((total, bucket) => total + totalTokens(bucket.totals), 0),
            228,
          );
          assert.deepStrictEqual(pi.map((bucket) => bucket.model).sort(), [
            "Tools/summaries",
            "anthropic/actual-model",
            "openai/actual-model",
            "openai/another-model",
          ]);
          const assistant = pi.find((bucket) => bucket.model === "anthropic/actual-model");
          assert.deepStrictEqual(assistant?.totals, {
            uncachedInputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 20,
            cacheCreationTokens: 3,
            reasoningTokens: 2,
          });
          assert.strictEqual(assistant?.costSource, "providerReported");
          assert.approximately(assistant?.categoryCostUsd?.input ?? NaN, 10 / 38, 1e-6);
          assert.approximately(assistant?.categoryCostUsd?.cacheRead ?? NaN, 2 / 38, 1e-6);
          assert.approximately(assistant?.categoryCostUsd?.cacheWrite ?? NaN, 6 / 38, 1e-6);
          assert.approximately(assistant?.categoryCostUsd?.output ?? NaN, 20 / 38, 1e-6);
          assert.strictEqual(assistant?.cacheSavingsUsd, 18);
          const warm = pi.find((bucket) => bucket.model === "openai/actual-model");
          assert.strictEqual(warm?.costSource, "modelPriced");
          assert.strictEqual(warm?.costUsd, 38);
          assert.deepStrictEqual(warm?.categoryCostUsd, {
            input: 10,
            cacheRead: 2,
            cacheWrite: 6,
            output: 20,
          });
          assert.strictEqual(warm?.cacheSavingsUsd, 18);
          assert.strictEqual(
            first.sources.filter((source) => source.fingerprint.provider === "pi").length,
            1,
          );
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              NodePath.join(dir, "fork.jsonl"),
              encodeUnknownJsonString({
                ...parent,
                id: "new",
                timestamp: "2026-08-01T14:00:00Z",
                message: { ...parent.message, responseModel: "latest-model" },
              }) + "\n",
            ),
          );
          const grown = yield* service.readSummary(WINDOW);
          assert.strictEqual(
            grown.buckets
              .filter((bucket) => bucket.provider === "pi")
              .reduce((total, bucket) => total + bucket.costUsd, 0),
            45,
          );
          yield* service.awaitPersisted;
          const restarted = yield* UsageService.make;
          assert.deepStrictEqual((yield* restarted.readSummary(WINDOW)).buckets, grown.buckets);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-pi-fork",
              home,
              ratesDocument: {
                "actual-model": {
                  input_cost_per_token: 1,
                  output_cost_per_token: 4,
                  cache_read_input_token_cost: 0.1,
                  cache_creation_input_token_cost: 2,
                },
              },
              settings: {
                ...settings,
                providerInstances: {
                  ...settings.providerInstances,
                  [ProviderInstanceId.make("pi-extra")]: {
                    driver: ProviderDriverKind.make("pi"),
                    enabled: false,
                    environment: [
                      {
                        name: "PI_CODING_AGENT_DIR",
                        value: NodePath.join(home, "pi"),
                        sensitive: false,
                      },
                    ],
                  },
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "reads Muse inference history once, persists appended usage, and reprices unknown models",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const museHome = NodePath.join(home, "configured-data", "muse");
        const dir = NodePath.join(museHome, "sessions", "2026", "08", "01", "parent");
        const child = NodePath.join(dir, "subagent", "child");
        const entry = (
          id: string,
          sessionId = "parent",
          timestamp = "2026-08-01T00:00:00Z",
          model = "muse-unknown",
        ) => ({
          schema_version: 1,
          record_type: "event",
          payload_type: "runtime.session",
          payload_schema_version: 1,
          id,
          recorded_at: Date.parse(timestamp) * 1000 + 999,
          stream: { kind: "session", id: sessionId },
          payload: {
            source_run_record_id: id,
            event: {
              kind: "model_completed",
              model,
              usage: {
                input_tokens: 100,
                cached_tokens: 60,
                cache_read_tokens: 60,
                cache_write_tokens: 10,
                output_tokens: 20,
                reasoning_tokens: 8,
              },
            },
          },
        });
        const parent = entry("inference-1");
        const review = {
          ...entry("review", "child"),
          payload_schema_version: 3,
          payload: {
            event: {
              ...parent.payload.event,
              kind: "automated_review_completed",
              model: { model_id: "priced-model" },
              usage: {
                input_tokens: 100,
                cached_input_tokens: 60,
                output_tokens: 20,
                reasoning_tokens: 8,
              },
            },
          },
        };
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(child, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "session.jsonl"),
            [
              parent,
              parent,
              {
                ...parent,
                payload: { event: { ...parent.payload.event, kind: "workflow_completed" } },
              },
              { ...parent, payload_type: "goal_usage_attribution" },
              entry("before", "parent", "2026-07-31T23:59:59.999Z"),
              entry("after", "parent", "2026-08-02T00:00:00Z"),
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n{broken}\n",
          );
          await NodeFSP.writeFile(
            NodePath.join(child, "session.jsonl"),
            [
              { ...parent, id: "copied-envelope", stream: { kind: "session", id: "child" } },
              entry("child-inference", "child"),
              review,
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
          await NodeFSP.writeFile(
            NodePath.join(child, "telemetry.jsonl"),
            encodeUnknownJsonString(entry("not-a-session")) + "\n",
          );
        });
        using _create = vi.spyOn(MuseSdk, "createMuseSdkHostEffect").mockImplementation((options) =>
          Effect.succeed({
            initializeResult: {
              grantedCapabilities: [],
              museHome: NodePath.join(options.environment?.XDG_DATA_HOME ?? home, "muse"),
            },
            close: async () => {},
          } as unknown as MuseSdk.MuseSdkHost),
        );
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const window = {
            timeZone: "UTC",
            sinceDay: UsageDay.make("2026-08-01"),
            untilDay: UsageDay.make("2026-08-01"),
          };
          const muse = (summary: UsageSummary) =>
            summary.buckets.filter((bucket) => bucket.provider === "muse");
          const first = yield* service.readSummary(window);
          const buckets = muse(first);
          assert.strictEqual(
            buckets.reduce((sum, b) => sum + b.records, 0),
            3,
          );
          assert.strictEqual(
            buckets.reduce((sum, b) => sum + totalTokens(b.totals), 0),
            360,
          );
          const unknown = buckets.find((b) => b.model === "muse-unknown");
          assert.strictEqual(unknown?.costSource, "unpriced");
          assert.strictEqual(unknown?.unpricedRecords, 2);
          assert.deepStrictEqual(unknown?.totals, {
            uncachedInputTokens: 60,
            cachedInputTokens: 120,
            cacheCreationTokens: 20,
            outputTokens: 40,
            reasoningTokens: 16,
          });
          const priced = buckets.find((b) => b.model === "priced-model");
          assert.strictEqual(priced?.costSource, "modelPriced");
          assert.closeTo(priced?.costUsd ?? NaN, 0.000172, 1e-12);
          assert.closeTo(priced?.cacheSavingsUsd ?? NaN, 0.000108, 1e-12);
          const sources = first.sources.filter((source) => source.fingerprint.provider === "muse");
          assert.strictEqual(sources.length, 1);
          assert.strictEqual(sources[0]?.scannedFiles, 2);
          assert.strictEqual(sources[0]?.distinctSessions, 2);
          const local = muse(
            yield* service.readSummary({ ...window, timeZone: "America/Los_Angeles" }),
          );
          assert.strictEqual(
            local.reduce((sum, b) => sum + b.records, 0),
            1,
          );
          assert.strictEqual(local[0]?.day, "2026-08-01");
          const hourly = muse(
            yield* service.readSummary({
              ...window,
              resolution: "hour",
              sinceTime: "2026-08-01T00:00:00.000Z",
              untilTime: "2026-08-02T00:00:00.000Z",
            }),
          );
          assert.strictEqual(
            hourly.reduce((sum, b) => sum + b.records, 0),
            3,
          );
          const appended = encodeUnknownJsonString(entry("appended", "child"));
          const file = NodePath.join(child, "session.jsonl");
          yield* Effect.promise(() => NodeFSP.appendFile(file, appended.slice(0, -10)));
          assert.deepStrictEqual(muse(yield* service.readSummary(window)), buckets);
          yield* service.awaitPersisted;
          const restarted = yield* UsageService.make;
          yield* Effect.promise(() => NodeFSP.appendFile(file, appended.slice(-10) + "\n"));
          const grown = muse(yield* restarted.readSummary(window));
          assert.strictEqual(
            grown.reduce((sum, b) => sum + b.records, 0),
            4,
          );
          assert.strictEqual(
            grown.reduce((sum, b) => sum + totalTokens(b.totals), 0),
            480,
          );
          const settingsService = yield* ServerSettings.ServerSettingsService;
          yield* settingsService.updateSettings({
            usagePriceOverrides: {
              "muse-unknown": {
                inputCostPerMillionTokens: 2,
                outputCostPerMillionTokens: 4,
                cacheReadCostPerMillionTokens: 0.2,
                cacheWriteCostPerMillionTokens: 1,
              },
            },
          });
          const repriced = muse(yield* restarted.readSummary(window)).find(
            (b) => b.model === "muse-unknown",
          );
          assert.strictEqual(repriced?.unpricedRecords, 0);
          assert.closeTo(repriced?.costUsd ?? NaN, 0.000486, 1e-12);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-muse",
              home,
              environment: { XDG_DATA_HOME: NodePath.dirname(museHome) },
              settings: {
                ...settings,
                providerInstances: {
                  ...settings.providerInstances,
                  [ProviderInstanceId.make("muse")]: {
                    driver: ProviderDriverKind.make("muse"),
                    enabled: false,
                  },
                  [ProviderInstanceId.make("muse-alias")]: {
                    driver: ProviderDriverKind.make("muse"),
                    enabled: false,
                  },
                },
              },
              ratesDocument: {
                "priced-model": {
                  input_cost_per_token: 0.000002,
                  output_cost_per_token: 0.000004,
                  cache_read_input_token_cost: 0.0000002,
                  cache_creation_input_token_cost: 0.0000002,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live("reports missing Pi history and skips malformed records without losing valid usage", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const missing = yield* service.readSummary(WINDOW);
        assert.strictEqual(
          missing.sources.find((source) => source.fingerprint.provider === "pi")?.status,
          "missing",
        );
        const dir = NodePath.join(home, "pi", "sessions");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "session.jsonl"),
            [
              "{broken",
              "null",
              encodeUnknownJsonString({ type: "session", id: "valid" }),
              encodeUnknownJsonString({
                type: "message",
                id: "bad",
                timestamp: "invalid",
                message: {
                  role: "assistant",
                  provider: "openai",
                  model: "model",
                  usage: { input: 100 },
                },
              }),
              encodeUnknownJsonString({
                type: "message",
                id: "valid",
                timestamp: "2026-08-01T10:00:00Z",
                message: {
                  role: "assistant",
                  provider: "openai",
                  model: "model",
                  usage: {
                    input: -1,
                    cacheRead: "100",
                    output: 7,
                    reasoning: 50,
                    cost: { total: -1 },
                  },
                },
              }),
            ].join("\n") + "\n",
          );
        });
        const summary = yield* service.readSummary(WINDOW);
        const pi = summary.buckets.filter((bucket) => bucket.provider === "pi");
        assert.strictEqual(pi.length, 1);
        assert.strictEqual(pi[0] && totalTokens(pi[0].totals), 7);
        assert.strictEqual(pi[0]?.totals.reasoningTokens, 7);
        assert.strictEqual(pi[0]?.costSource, "unpriced");
      }).pipe(
        Effect.scoped,
        Effect.provide(layerService({ prefix: "usage-pi-malformed", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("discovers Pi history in its default home and directory overrides", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      for (const [agentDir, sessionDir, relativeDir] of [
        [undefined, undefined, ".pi/agent/sessions"],
        ["~/custom-pi", undefined, "custom-pi/sessions"],
        ["~/ignored-pi", "~/custom-sessions", "custom-sessions"],
        ["~/ignored-pi", NodePath.join(home, "absolute-sessions"), "absolute-sessions"],
      ] as const) {
        const dir = NodePath.join(home, relativeDir);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "session.jsonl"),
            [
              { type: "session", id: relativeDir },
              {
                type: "usage",
                id: "warm",
                timestamp: "2026-08-01T10:00:00Z",
                provider: "openai",
                model: "model",
                usage: { input: 7 },
              },
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
        });
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const summary = yield* service.readSummary(WINDOW);
          const pi = summary.buckets.filter((bucket) => bucket.provider === "pi");
          assert.strictEqual(pi.length, 1);
          assert.strictEqual(pi[0]?.totals.uncachedInputTokens, 7);
          assert.strictEqual(
            summary.sources.find((source) => source.fingerprint.provider === "pi")?.fingerprint
              .resolvedHomePath,
            dir,
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-pi-" + relativeDir.replaceAll("/", "-"),
              home,
              settings,
              environment: {
                PI_CODING_AGENT_DIR: agentDir,
                PI_CODING_AGENT_SESSION_DIR: sessionDir,
              },
            }),
          ),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
      }
    }).pipe(Effect.scoped),
  );

  it.live("reads shared managed default and disabled extra account history once", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const summary = yield* Effect.gen(function* () {
        for (const [id, output] of [
          ["codex", 17],
          ["codex-personal", 23],
        ] as const) {
          const sessions = NodePath.join(home, "shared-codex", "sessions");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(sessions, { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(sessions, `${id}-rollout.jsonl`),
              [
                { type: "session_meta", payload: { id } },
                { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
                {
                  type: "event_msg",
                  timestamp: "2026-08-01T10:00:00Z",
                  payload: {
                    type: "token_count",
                    info: { last_token_usage: { input_tokens: 10, output_tokens: output } },
                  },
                },
              ]
                .map((line) => encodeUnknownJsonString(line))
                .join("\n") + "\n",
            );
          });
        }
        const service = yield* UsageService.make;
        return yield* service.readSummary(WINDOW);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerService({
            prefix: "usage-managed-accounts",
            home,
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: {
                    setupMode: "managed",
                    homePath: NodePath.join(home, "shared-codex"),
                  },
                },
                [ProviderInstanceId.make("codex-personal")]: {
                  driver: ProviderDriverKind.make("codex"),
                  enabled: false,
                  config: {
                    setupMode: "managed",
                    homePath: NodePath.join(home, "shared-codex"),
                    shadowHomePath: NodePath.join(home, "personal-shadow"),
                  },
                  environment: [
                    {
                      name: "CODEX_HOME",
                      value: NodePath.join(home, "ignored-environment"),
                      sensitive: false,
                    },
                  ],
                },
              },
            },
          }),
        ),
      );
      assert.strictEqual(totalOutputTokens(summary), 40);
      assert.strictEqual(
        summary.sources.filter(
          (source) => source.fingerprint.provider === "codex" && source.status === "ok",
        ).length,
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.live("keeps Cursor credential errors visible when a saved login cannot be read", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const authPath = NodePath.join(home, "config", "cursor", "auth.json");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
        await NodeFSP.writeFile(authPath, "invalid json");
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({ prefix: "usage-service-cursor-invalid-login", home, settings }),
        ),
      );
      const summary = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
      const cursor = summary.sources.find((source) => source.fingerprint.provider === "cursor");
      assert.strictEqual(cursor?.message, "Cursor credentials could not be read.");
    }).pipe(Effect.scoped),
  );

  it.live("restores the Cursor account cache after a restart", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* writeCursorLogin(home);
      yield* TestClock.setTime(CURSOR_NOW);
      const before = makeFakeCursor();
      before.state.events = [
        { timestampMs: CURSOR_NOW - 30 * HOUR_MS, outputTokens: 5 },
        { timestampMs: CURSOR_NOW - 3 * HOUR_MS, outputTokens: 7 },
      ];
      yield* Effect.gen(function* () {
        const first = yield* makeWithCursor(before.read);
        const original = yield* first.readSummary({ ...WINDOW, awaitRefresh: true });
        yield* first.awaitPersisted;

        const after = makeFakeCursor();
        after.state.events = before.state.events;
        const restarted = yield* makeWithCursor(after.read);
        const restored = yield* restarted.readSummary(WINDOW);
        assert.isUndefined(cursorSource(restored)?.refreshing);
        assert.deepStrictEqual(restored.buckets, original.buckets);
        assert.deepStrictEqual(cursorSource(restored), cursorSource(original));
        assert.strictEqual(after.state.calls.length, 0);

        yield* TestClock.adjust(Duration.minutes(2));
        const refreshed = yield* restarted.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.deepStrictEqual(refreshed.buckets, original.buckets);
        assert.deepStrictEqual(after.state.calls, [
          { sinceMs: CURSOR_NOW - HOUR_MS, untilMs: CURSOR_NOW + 2 * 60 * 1000 },
        ]);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-cursor-restart", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not read the macOS Cursor Keychain before account usage is enabled", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-cursor-keychain-disabled",
            home,
            settings,
            platform: "darwin",
            environment: {},
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const cursor = summary.sources.find((source) => source.fingerprint.provider === "cursor");
      assert.strictEqual(cursor?.status, "missing");
      assert.strictEqual(cursor?.action, "enableCursorKeychain");
    }).pipe(Effect.scoped),
  );

  it.live("ignores stale Cursor file logins when the active credential store differs", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      for (const [index, testCase] of [
        {
          platform: "darwin" as const,
          environment: { AGENT_CLI_CREDENTIAL_STORE: "memory" },
          authPath: [".cursor", "auth.json"],
        },
        {
          platform: "linux" as const,
          environment: { AGENT_CLI_CREDENTIAL_STORE: "memory" },
          authPath: ["config", "cursor", "auth.json"],
        },
        {
          platform: "linux" as const,
          environment: { CURSOR_API_KEY: "different-account" },
          authPath: ["config", "cursor", "auth.json"],
        },
      ].entries()) {
        const authPath = NodePath.join(home, ...testCase.authPath);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
          await NodeFSP.writeFile(
            authPath,
            encodeUnknownJsonString({ accessToken: "stale-token" }),
          );
        });
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            layerService({
              prefix: `usage-service-cursor-store-${index}`,
              home,
              settings,
              platform: testCase.platform,
              environment: testCase.environment,
            }),
          ),
        );
        const summary = yield* service.readSummary(WINDOW);
        const cursor = summary.sources.find((source) => source.fingerprint.provider === "cursor");
        assert.strictEqual(cursor?.status, "missing");
        assert.include(cursor?.message ?? "", "Cursor CLI login");
        assert.isFalse(summary.buckets.some((bucket) => bucket.provider === "cursor"));
      }
    }).pipe(Effect.scoped),
  );

  it.live(
    "includes OpenCode history but does not substitute desktop usage for an unavailable Cursor account",
    () =>
      Effect.gen(function* () {
        const { settings, home } = yield* setup;
        const root = NodePath.join(home, "opencode");
        const message = yield* encodeUnknownJson({
          id: "msg_1",
          sessionID: "session-1",
          role: "assistant",
          modelID: "example-model",
          time: { created: Date.parse("2026-08-01T10:00:00Z") },
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 20, write: 3 } },
        });
        const bubble = yield* encodeUnknownJson({
          type: 2,
          createdAt: "2026-08-01T10:00:00Z",
          modelInfo: { modelName: "example-model" },
          tokenCount: { inputTokens: 100, outputTokens: 20 },
        });
        yield* Effect.promise(async () => {
          const directory = NodePath.join(root, "storage", "message", "session-1");
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(directory, "msg_1.json"), message);
          const desktop = NodePath.join(home, "config", "Cursor", "User", "globalStorage");
          await NodeFSP.mkdir(desktop, { recursive: true });
          const db = new NodeSqlite.DatabaseSync(NodePath.join(desktop, "state.vscdb"));
          try {
            db.exec("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
            db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
              "bubbleId:session:assistant",
              bubble,
            );
          } finally {
            db.close();
          }
        });
        const service = yield* UsageService.make.pipe(
          Effect.provide(layerService({ prefix: "usage-service-opencode", home, settings })),
        );
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(summary.buckets[0]?.provider, "opencode");
        assert.isFalse(summary.buckets.some((bucket) => bucket.provider === "cursor"));
        assert.isFalse(summary.sources.some((source) => source.fingerprint.provider === "cursor"));
        assert.strictEqual(
          summary.buckets[0]?.sourcePath,
          yield* Effect.promise(() => NodeFSP.realpath(root)),
        );
        assert.strictEqual(summary.buckets[0]?.totals.outputTokens, 7);
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "opencode")
            ?.distinctSessions,
          1,
        );
      }).pipe(Effect.scoped),
  );

  it.live("includes host and merged OpenCode instance histories once across list aliases", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const hostRoot = NodePath.join(home, "opencode");
      const instanceRoot = NodePath.join(home, "opencode-work");
      const alias = NodePath.join(home, "opencode-alias");
      const dataHome = NodePath.join(home, "data");
      const xdgRoot = NodePath.join(dataHome, "opencode");
      const histories = [
        { root: hostRoot, id: "host", output: 5 },
        { root: instanceRoot, id: "work", output: 7 },
        { root: xdgRoot, id: "xdg", output: 11 },
      ];
      yield* Effect.promise(async () => {
        for (const { root, id, output } of histories) {
          const directory = NodePath.join(root, "storage", "message", "session-1");
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(directory, `${id}.json`),
            encodeUnknownJsonString({
              role: "assistant",
              modelID: "example-model",
              time: { created: Date.parse("2026-08-01T10:00:00Z") },
              tokens: { input: 10, output },
            }),
          );
        }
        await NodeFSP.symlink(instanceRoot, alias, "junction");
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-opencode-instances",
            home,
            environment: { XDG_DATA_HOME: dataHome },
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("opencode-work")]: {
                  driver: ProviderDriverKind.make("opencode"),
                  environment: [
                    {
                      name: "OPENCODE_DATA_DIR",
                      value: ` ${instanceRoot}, ${alias} `,
                      sensitive: false,
                    },
                  ],
                },
                [ProviderInstanceId.make("opencode-xdg")]: {
                  driver: ProviderDriverKind.make("opencode"),
                  environment: [{ name: "OPENCODE_DATA_DIR", value: "", sensitive: false }],
                },
              },
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const sources = summary.sources.filter(
        (source) => source.fingerprint.provider === "opencode",
      );
      const expectedRoots = yield* Effect.promise(() =>
        Promise.all(histories.map(({ root }) => NodeFSP.realpath(root))),
      );
      assert.deepStrictEqual(
        sources.map((source) => source.fingerprint.resolvedHomePath).sort(),
        expectedRoots.sort(),
      );
      assert.deepStrictEqual(
        summary.buckets
          .filter((bucket) => bucket.provider === "opencode")
          .map((bucket) => bucket.totals.outputTokens)
          .sort((a, b) => a - b),
        [5, 7, 11],
      );
    }).pipe(Effect.scoped),
  );

  it.live("counts aliased OpenCode and Antigravity directories once", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const opencode = NodePath.join(home, "opencode-store");
      const opencodeAlias = NodePath.join(home, "opencode-alias");
      const conversations = NodePath.join(home, "antigravity-conversations");
      const antigravityA = NodePath.join(home, "antigravity-a");
      const antigravityB = NodePath.join(home, "antigravity-b");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(opencode);
        await NodeFSP.symlink(opencode, opencodeAlias, "junction");
        await NodeFSP.mkdir(conversations);
        await NodeFSP.mkdir(antigravityA);
        await NodeFSP.mkdir(antigravityB);
        await NodeFSP.symlink(
          conversations,
          NodePath.join(antigravityA, "conversations"),
          "junction",
        );
        await NodeFSP.symlink(
          conversations,
          NodePath.join(antigravityB, "conversations"),
          "junction",
        );
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-aliased-roots-test",
            home,
            settings,
            environment: {
              OPENCODE_DATA_DIR: `${opencode},${opencodeAlias}`,
              ANTIGRAVITY_DATA_DIR: `${antigravityA},${antigravityB}`,
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const sourcesFor = (provider: "opencode" | "antigravity") =>
        summary.sources.filter((source) => source.fingerprint.provider === provider);
      assert.strictEqual(sourcesFor("opencode").length, 1);
      assert.strictEqual(sourcesFor("antigravity").length, 1);
      assert.strictEqual(
        sourcesFor("opencode")[0]?.fingerprint.resolvedHomePath,
        yield* Effect.promise(() => NodeFSP.realpath(opencode)),
      );
      assert.strictEqual(
        sourcesFor("antigravity")[0]?.fingerprint.resolvedHomePath,
        yield* Effect.promise(() => NodeFSP.realpath(conversations)),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reads Antigravity history from each instance's data directory", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const first = NodePath.join(home, "antigravity-first");
      const second = NodePath.join(home, "antigravity-second");
      yield* Effect.promise(async () => {
        for (const [dir, outputTokens] of [
          [first, 7],
          [second, 11],
        ] as const) {
          await NodeFSP.mkdir(dir);
          const db = new NodeSqlite.DatabaseSync(
            NodePath.join(dir, `${NodePath.basename(dir)}.db`),
          );
          try {
            db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
            // Step protobuf: 100 input tokens, distinct output tokens, and 2026-08-01T10:00Z.
            const metadata = new Uint8Array([
              0x4a,
              4,
              0x10,
              100,
              0x18,
              outputTokens,
              ...Buffer.from("420608a087b7d306", "hex"),
            ]);
            db.prepare("INSERT INTO steps VALUES (?, ?)").run(0, metadata);
          } finally {
            db.close();
          }
        }
      });
      const instance = (dataDir: string) => ({
        driver: ProviderDriverKind.make("antigravity"),
        environment: [{ name: "ANTIGRAVITY_DATA_DIR", value: dataDir, sensitive: false }],
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-antigravity-instances-test",
            home,
            settings: {
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("antigravity-first")]: instance(first),
                [ProviderInstanceId.make("antigravity-second")]: instance(` ${second}, `),
              },
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const roots = summary.sources
        .filter((source) => source.fingerprint.provider === "antigravity")
        .map((source) => source.fingerprint.resolvedHomePath);
      for (const [dir, outputTokens] of [
        [first, 7],
        [second, 11],
      ] as const) {
        const root = yield* Effect.promise(() => NodeFSP.realpath(dir));
        assert.include(roots, root);
        assert.strictEqual(
          summary.buckets
            .filter((bucket) => bucket.provider === "antigravity" && bucket.sourcePath === root)
            .reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0),
          outputTokens,
        );
      }
    }).pipe(Effect.scoped),
  );

  it.live("reads configured and disabled accounts once across shared and aliased homes", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const codexHome = NodePath.join(home, "codex-account");
      const alias = NodePath.join(home, "codex-alias");
      const claudeHome = NodePath.join(home, "claude-account");
      const grokHome = NodePath.join(home, "grok-account");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        await NodeFSP.mkdir(NodePath.join(claudeHome, "projects"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(claudeHome, "projects", "session.jsonl"),
          claudeLine(2, 7),
        );
        await NodeFSP.mkdir(NodePath.join(codexHome, "sessions"), { recursive: true });
        await NodeFSP.symlink(codexHome, alias, "junction");
        await NodeFSP.writeFile(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          [
            { type: "session_meta", payload: { id: "codex-account-session" } },
            { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
            ...[11, 12, 11].map((outputTokens) => ({
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 10, output_tokens: outputTokens } },
              },
            })),
          ]
            .map((line) => encodeUnknownJsonString(line))
            .join("\n") + "\n",
        );
        await NodeFSP.mkdir(NodePath.join(grokHome, "sessions", "session"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(grokHome, "sessions", "session", "updates.jsonl"),
          encodeUnknownJsonString({
            timestamp: Date.parse("2026-08-01T10:00:00Z") / 1000,
            method: "_x.ai/session/update",
            params: {
              sessionId: "grok-account-session",
              update: {
                sessionUpdate: "turn_completed",
                prompt_id: "prompt-1",
                usage: { inputTokens: 10, outputTokens: 13 },
              },
            },
          }) + "\n",
        );
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-accounts-test",
            home,
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("claude-work")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  enabled: false,
                  environment: [{ name: "CLAUDE_CONFIG_DIR", value: claudeHome, sensitive: false }],
                },
                [ProviderInstanceId.make("codex-work")]: {
                  driver: ProviderDriverKind.make("codex"),
                  environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }],
                },
                [ProviderInstanceId.make("codex-alias")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: alias },
                },
                [ProviderInstanceId.make("codex-shadow")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: codexHome, shadowHomePath: NodePath.join(home, "shadow") },
                  environment: [
                    { name: "CODEX_HOME", value: NodePath.join(home, "ignored"), sensitive: false },
                  ],
                },
                [ProviderInstanceId.make("grok-work")]: {
                  driver: ProviderDriverKind.make("grok"),
                  config: { customModels: "not-a-list" },
                  environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
                },
              },
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(summary), 59);
      yield* Effect.promise(() =>
        NodeFSP.rename(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          NodePath.join(codexHome, "sessions", "moved.jsonl"),
        ),
      );
      const moved = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(moved.buckets, summary.buckets);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(codexHome, "sessions"), { recursive: true }),
      );
      const removed = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(removed.buckets, summary.buckets);

      const sources = summary.sources.filter((source) => source.status === "ok");
      assert.strictEqual(sources.length, 4);
      assert.strictEqual(
        sources.reduce((sum, source) => sum + source.scannedFiles, 0),
        4,
      );
      assert.strictEqual(
        sources.filter((source) => source.fingerprint.provider === "codex").length,
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "uses explicit account settings before environment and default homes, then refreshes them",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const configured = NodePath.join(home, "configured");
        const environmentHome = NodePath.join(home, "environment");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(transcript, claudeLine(1, 100));
          for (const [index, root] of [configured, environmentHome].entries()) {
            await NodeFSP.mkdir(NodePath.join(root, "projects"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(root, "projects", "session.jsonl"),
              claudeLine(index + 2, index + 7),
            );
          }
          await NodeFSP.mkdir(NodePath.join(configured, ".claude", "projects"), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            NodePath.join(configured, ".claude", "projects", "wrong.jsonl"),
            claudeLine(4, 1000),
          );
        });
        yield* Effect.gen(function* () {
          const settingsService = yield* ServerSettings.ServerSettingsService;
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(first), 7);
          const configuredProjects = yield* Effect.promise(() =>
            NodeFSP.realpath(NodePath.join(configured, "projects")),
          );
          assert.include(
            first.sources.map((source) => source.fingerprint.resolvedHomePath),
            configuredProjects,
          );
          yield* settingsService.updateSettings({
            providerInstances: {
              ...settings.providerInstances,
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: "" },
                environment: [
                  { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                ],
              },
            },
          });
          const second = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(second), 8);
          const environmentProjects = yield* Effect.promise(() =>
            NodeFSP.realpath(NodePath.join(environmentHome, "projects")),
          );
          assert.include(
            second.sources.map((source) => source.fingerprint.resolvedHomePath),
            environmentProjects,
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-service-home-refresh-test",
              home,
              environment: { CLAUDE_CONFIG_DIR: NodePath.join(home, "host-ignored") },
              settings: {
                ...settings,
                providerInstances: {
                  ...settings.providerInstances,
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: { homePath: configured },
                    environment: [
                      { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                    ],
                  },
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "uses inherited home variables when explicit default accounts have no home settings",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            layerService({
              prefix: "usage-service-inherited-homes-test",
              home,
              environment: {
                CODEX_HOME: NodePath.join(home, "inherited-codex"),
                CLAUDE_CONFIG_DIR: NodePath.join(home, "claude"),
              },
              settings: {
                ...settings,
                providerInstances: {
                  [ProviderInstanceId.make("codex")]: {
                    driver: ProviderDriverKind.make("codex"),
                    config: {},
                  },
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: {},
                  },
                },
              },
            }),
          ),
        );
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(summary), 5);
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "codex")?.fingerprint
            .resolvedHomePath,
          NodePath.join(home, "inherited-codex", "sessions"),
        );
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "grok")?.fingerprint
            .resolvedHomePath,
          NodePath.join(home, "grok", "sessions"),
        );
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "reports unreadable transcripts as partial and recovers once they can be read",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const unreadable = NodePath.join(NodePath.dirname(transcript), "other.jsonl");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(transcript, claudeLine(1, 5));
          await NodeFSP.writeFile(unreadable, claudeLine(2, 7));
          await NodeFSP.chmod(unreadable, 0);
        });
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const partial = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(partial), 5);
          assert.strictEqual(partial.sources[0]?.status, "partial");

          yield* Effect.promise(() => NodeFSP.chmod(unreadable, 0o600));
          const healthy = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(healthy), 12);
          assert.strictEqual(healthy.sources[0]?.status, "ok");
          assert.isNull(healthy.sources[0]?.message);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-service-unreadable", home, settings })),
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
        Effect.scoped,
        Effect.provide(
          layerService({ prefix: "usage-service-price-overrides-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "retains Codex reconciliation and partial coverage through persisted restart, append and repair",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const dir = NodePath.join(home, "codex", "sessions");
        const transcript = NodePath.join(dir, "rollout.jsonl");
        const usage = (input: number, output: number) => ({
          input_tokens: input,
          output_tokens: output,
          total_tokens: input + output,
        });
        const counted = (input: number, output: number, totalInput: number, totalOutput: number) =>
          encodeUnknownJsonString({
            type: "event_msg",
            timestamp: "2026-08-01T10:00:00Z",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: usage(input, output),
                total_token_usage: usage(totalInput, totalOutput),
              },
            },
          });
        const tier = (service_tier: string) =>
          encodeUnknownJsonString({
            type: "event_msg",
            payload: { type: "thread_settings_applied", thread_settings: { service_tier } },
          });
        const bad = counted(10, 2, 130, 28);
        // Cross the reader's projection threshold so cumulative fields must survive selection.
        const stale = counted(20, 5, 100, 20).replace(
          '"payload":',
          '"padding":' + encodeUnknownJsonString("x".repeat(9 * 1024 * 1024)) + ',"payload":',
        );
        let content = [
          encodeUnknownJsonString({ type: "turn_context", payload: { model: "gpt-6-astra" } }),
          counted(100, 20, 100, 20),
          stale,
          tier("priority"),
          bad,
        ].join("\n");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(transcript, content);
        });
        yield* Effect.gen(function* () {
          const verify = (
            summary: UsageSummary,
            output: number,
            cost: number,
            malformed: number,
          ) => {
            assert.strictEqual(totalOutputTokens(summary), output);
            assert.strictEqual(
              summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
              cost,
            );
            const source = summary.sources.find(
              (source) => source.fingerprint.provider === "codex",
            );
            assert.strictEqual(source?.status, malformed === 0 ? "ok" : "partial");
            assert.strictEqual(source?.malformedRecords, malformed);
            if (malformed > 0) assert.match(source?.message ?? "", /1 malformed or inconsistent/);
            else assert.notMatch(source?.message ?? "", /malformed|inconsistent/);
          };
          const open = vi.spyOn(NodeFSP, "open");
          open.mockClear();
          yield* Effect.addFinalizer(() => Effect.sync(() => open.mockRestore()));
          const first = yield* UsageService.make;
          const cold = yield* first.readSummary(WINDOW);
          assert.isTrue(open.mock.calls.some(([path]) => path === transcript));
          verify(cold, 20, 20, 1);
          yield* first.awaitPersisted;
          const restarted = yield* UsageService.make;
          open.mockClear();
          verify(yield* first.readSummary(WINDOW), 20, 20, 1);
          verify(yield* restarted.readSummary(WINDOW), 20, 20, 1);
          assert.isFalse(open.mock.calls.some(([path]) => path === transcript));
          open.mockRestore();

          const append = "\n" + counted(10, 2, 140, 30) + "\n";
          content += append;
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, append));
          verify(yield* restarted.readSummary(WINDOW), 22, 24, 1);
          yield* restarted.awaitPersisted;
          const resumed = yield* UsageService.make;
          verify(yield* resumed.readSummary(WINDOW), 22, 24, 1);
          const next = tier("ultrafast") + "\n" + counted(10, 2, 150, 32) + "\n";
          content += next;
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, next));
          verify(yield* resumed.readSummary(WINDOW), 24, 36, 1);

          const repaired = content.replace(bad, counted(30, 8, 130, 28));
          assert.strictEqual(Buffer.byteLength(repaired), Buffer.byteLength(content));
          yield* Effect.promise(async () => {
            const stat = await NodeFSP.stat(transcript);
            await NodeFSP.writeFile(transcript, repaired);
            await NodeFSP.utimes(transcript, stat.atime, stat.mtimeMs / 1000 + 1);
          });
          verify(yield* resumed.readSummary(WINDOW), 32, 52, 0);
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-codex-reconciliation",
              home,
              settings,
              ratesDocument: {
                "gpt-6-astra": {
                  input_cost_per_token: 0,
                  output_cost_per_token: 1,
                  input_cost_per_token_priority: 0,
                  output_cost_per_token_priority: 2,
                  input_cost_per_token_ultrafast: 0,
                  output_cost_per_token_ultrafast: 6,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "keeps large-record totals and costs exact through append, dedupe, restart and cleanup",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const large = claudeLine(1, 9900).replace(
          '"message":',
          '"padding":' + encodeUnknownJsonString("x".repeat(9 * 1024 * 1024)) + ',"message":',
        );
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, large));
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(first), 9900);
          assert.closeTo(
            first.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            0.4951,
            1e-12,
          );
          const warm = yield* service.readSummary(WINDOW);
          assert.deepStrictEqual(warm.buckets, first.buckets);
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, large + claudeLine(2, 100)));
          const appended = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(appended), 10000);
          assert.strictEqual(
            appended.buckets.reduce((sum, bucket) => sum + bucket.totals.uncachedInputTokens, 0),
            20,
          );
          yield* service.awaitPersisted;
          const restarted = yield* UsageService.make;
          const restored = yield* restarted.readSummary(WINDOW);
          assert.deepStrictEqual(restored.buckets, appended.buckets);
          yield* restarted.awaitPersisted;
          yield* Effect.promise(() => NodeFSP.rm(transcript));
          const afterCleanup = yield* UsageService.make;
          assert.deepStrictEqual(
            (yield* afterCleanup.readSummary(WINDOW)).buckets,
            appended.buckets,
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-service-large-record-test",
              home,
              settings,
              ratesDocument: {
                "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live.each([4, 5, 6, 7, 8])(
    "upgrades a v%s cache: reparses live Codex usage, keeps deleted rollouts and the old file",
    (version) =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const sessions = NodePath.join(home, "codex", "sessions");
        const rollout = (sessionId: string, outputTokens: number) =>
          [
            { type: "session_meta", payload: { id: sessionId } },
            { type: "turn_context", payload: { model: "gpt-6-astra" } },
            {
              type: "event_msg",
              payload: {
                type: "thread_settings_applied",
                thread_settings: { service_tier: "ultrafast" },
              },
            },
            {
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: {
                  last_token_usage: { input_tokens: 0, output_tokens: outputTokens },
                  total_token_usage: { input_tokens: 100, output_tokens: outputTokens + 30 },
                },
              },
            },
          ]
            .map((line) => encodeUnknownJsonString(line))
            .join("\n") + "\n";
        const live = NodePath.join(sessions, "live.jsonl");
        const deleted = NodePath.join(sessions, "deleted.jsonl");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sessions, { recursive: true });
          await NodeFSP.writeFile(live, rollout("live", 10));
          await NodeFSP.writeFile(deleted, rollout("deleted", 20));
        });

        yield* Effect.gen(function* () {
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const cachePath = NodePath.join(stateDir, SCAN_CACHE_FILE_NAME);
          const legacyPath = NodePath.join(
            stateDir,
            version === 4 ? "usage-scan-cache.json" : `usage-scan-cache-v${version}.json`,
          );
          const first = yield* UsageService.make;
          yield* first.readSummary(WINDOW);
          yield* first.awaitPersisted;

          const legacy = yield* Effect.promise(async () => {
            const livePath = await NodeFSP.realpath(live);
            const document = decodeUnknownJsonString(await NodeFSP.readFile(cachePath, "utf8")) as {
              files: Record<string, { r: unknown[][]; mr: number; cs: Record<string, unknown> }>;
            };
            for (const [path, file] of Object.entries(document.files)) {
              file.r = file.r.map((row) => [
                ...row.slice(0, 6),
                path === livePath ? 99 : row[6],
                ...row.slice(7, 10),
                version === 4 ? 0 : 1,
              ]);
              if (version === 4) delete file.cs.speed;
              if (version < 6) {
                delete file.cs.lastCumulativeUsage;
                delete file.cs.malformedRecords;
              }
              if (version === 8 && path === livePath) {
                file.r = [];
                file.mr = 1;
                file.cs.malformedRecords = 1;
              }
            }
            const text = encodeUnknownJsonString({ ...document, version });
            await NodeFSP.rm(cachePath);
            await NodeFSP.writeFile(legacyPath, text);
            if (version === 6) {
              for (const [name, olderVersion] of [
                ["usage-scan-cache-v5.json", 5],
                ["usage-scan-cache.json", 4],
              ] as const) {
                await NodeFSP.writeFile(
                  NodePath.join(stateDir, name),
                  encodeUnknownJsonString({ ...document, version: olderVersion, files: {} }),
                );
              }
            }
            await NodeFSP.rm(deleted);
            return text;
          });

          const upgraded = yield* UsageService.make;
          const summary = yield* upgraded.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(summary), 30);
          assert.strictEqual(
            summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            60 + 20 * (version === 4 ? 1 : 2),
          );
          yield* upgraded.awaitPersisted;
          assert.strictEqual(SCAN_CACHE_FILE_NAME, "usage-scan-cache-v10.json");
          assert.strictEqual(
            yield* Effect.promise(() => NodeFSP.readFile(legacyPath, "utf8")),
            legacy,
          );
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-service-cache-upgrade-test",
              home,
              settings,
              ratesDocument: {
                "gpt-6-astra": {
                  input_cost_per_token: 0,
                  output_cost_per_token: 1,
                  input_cost_per_token_priority: 0,
                  output_cost_per_token_priority: 2,
                  input_cost_per_token_ultrafast: 0,
                  output_cost_per_token_ultrafast: 6,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live("preserves saved tokens, costs and sessions after transcript cleanup and restart", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const alias = NodePath.join(home, "claude-alias");
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(home, "claude"), alias, "junction"),
      );
      const content = claudeLine(1, 5);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, content));
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(first), 5);
        assert.isAbove(first.buckets[0]?.costUsd ?? 0, 0);

        yield* Effect.promise(() => NodeFSP.rm(transcript));
        const deleted = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(deleted.buckets, first.buckets);
        assert.deepStrictEqual(deleted.sources, first.sources);

        yield* service.awaitPersisted;
        const restarted = yield* UsageService.make;
        const restored = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, first.buckets);
        assert.deepStrictEqual(restored.sources, first.sources);

        yield* Effect.promise(() => NodeFSP.writeFile(transcript + ".jsonl", content));
        const moved = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(moved.buckets, first.buckets);
        assert.strictEqual(moved.sources[0]?.distinctSessions, 1);
        yield* restarted.awaitPersisted;

        const replacementProjects = NodePath.join(home, "replacement-projects");
        yield* Effect.promise(() => NodeFSP.mkdir(replacementProjects));
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
        );
        const afterRootCleanup = yield* UsageService.make;
        const missingRoot = yield* afterRootCleanup.readSummary(WINDOW);
        assert.deepStrictEqual(missingRoot.buckets, first.buckets);
        assert.strictEqual(missingRoot.sources[0]?.distinctSessions, 1);
        assert.strictEqual(missingRoot.sources[0]?.status, "ok");
        assert.deepStrictEqual(missingRoot.sources[0]?.fingerprint, first.sources[0]?.fingerprint);
        yield* Effect.promise(async () => {
          const projects = NodePath.join(home, "claude", "projects");
          await NodeFSP.rename(replacementProjects, projects);
          await NodeFSP.writeFile(NodePath.join(projects, "new.jsonl"), claudeLine(2, 7));
        });
        const recreated = yield* afterRootCleanup.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(recreated), 12);
        assert.deepStrictEqual(recreated.sources[0]?.fingerprint, first.sources[0]?.fingerprint);

        const merged = mergeUsage(
          [
            {
              environmentId: EnvironmentId.make("cleanup-test"),
              label: "test",
              summary: recreated,
            },
            {
              environmentId: EnvironmentId.make("other-environment"),
              label: "before cleanup",
              summary: first,
            },
          ],
          missingRoot.contractVersion,
        );
        assert.strictEqual(merged.outputTokens, 12);
        assert.strictEqual(merged.sessions, 1);
        assert.strictEqual(merged.costUsd, recreated.buckets[0]?.costUsd);

        const outsideWindow = yield* restarted.readSummary({
          ...WINDOW,
          sinceDay: UsageDay.make("2026-08-02"),
        });
        assert.deepStrictEqual(outsideWindow.buckets, []);
        assert.strictEqual(outsideWindow.sources[0]?.distinctSessions, 0);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerService({
            prefix: "usage-service-cleanup-test",
            home,
            settings: {
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: alias },
                },
              },
            },
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("credits the same copy of a duplicate after its transcripts are deleted", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const dir = NodePath.dirname(transcript);
      const [first = "", second = ""] = yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(dir, "a.jsonl"), "");
        await NodeFSP.writeFile(NodePath.join(dir, "b.jsonl"), "");
        return (await NodeFSP.readdir(dir)).map((name) => NodePath.join(dir, name));
      });
      const forked = (line: string) => line.replace('"session-1"', '"session-2"');
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(
          first,
          claudeLine(1, 5).replace(
            '"message":',
            '"padding":' + encodeUnknownJsonString("x".repeat(9 * 1024 * 1024)) + ',"message":',
          ),
        );
        await NodeFSP.writeFile(second, forked(claudeLine(1, 5)) + forked(claudeLine(2, 7)));
      });
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const live = yield* service.readSummary(WINDOW);
        assert.strictEqual(live.buckets[0]?.sessions, 2);

        yield* Effect.promise(() => Promise.all([NodeFSP.rm(first), NodeFSP.rm(second)]));
        const saved = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(saved.buckets, live.buckets);
        assert.deepStrictEqual(saved.sources, live.sources);
        yield* service.awaitPersisted;
        const restored = yield* (yield* UsageService.make).readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, live.buckets);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-copy-order-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "keeps a newer cached read when a slower scan of another window finishes later",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const dir = NodePath.dirname(transcript);
        const probe = NodePath.join(dir, "probe.jsonl");
        const hold = NodePath.join(dir, "hold.jsonl");
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        yield* makeGate(probe, BEFORE_NARROW_WINDOW);
        yield* makeGate(hold, BEFORE_NARROW_WINDOW);
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const wide = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
          yield* openGate(probe);
          yield* replaceFile(transcript, claudeLine(1, 5) + claudeLine(2, 7));
          yield* service.readSummary(NARROW_WINDOW);
          yield* openGate(hold);
          yield* Fiber.join(wide);

          yield* Effect.promise(() =>
            Promise.all([transcript, probe, hold].map((path) => NodeFSP.rm(path))),
          );
          assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-service-stale-read-test", home, settings })),
        );
      }).pipe(Effect.scoped),
  );

  it.live("keeps an absent directory missing when its cached files only contain diagnostics", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
      );
      yield* Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const mtimeMs = yield* Clock.currentTimeMillis;
        const cache = makeScanCacheWriter()(
          new Map([
            [
              transcript,
              {
                size: 0,
                mtimeMs,
                provider: "claude" as const,
                records: [],
                tailRecords: [],
                malformedRecords: 2,
                position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
              },
            ],
          ]),
          {},
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(stateDir, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(stateDir, SCAN_CACHE_FILE_NAME), cache);
        });
        const summary = yield* (yield* UsageService.make).readSummary(WINDOW);
        const source = summary.sources.find((source) => source.fingerprint.provider === "claude");
        assert.strictEqual(source?.status, "missing");
        assert.strictEqual(source?.scannedFiles, 0);
        assert.strictEqual(source?.malformedRecords, 2);
      }).pipe(
        Effect.provide(
          layerService({ prefix: "usage-service-missing-diagnostics", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reports saved usage of a removed directory only for windows it reaches", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        const lastWrite = Date.parse("2026-08-01T10:00:00Z") / 1000;
        await NodeFSP.utimes(transcript, lastWrite, lastWrite);
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(layerService({ prefix: "usage-service-saved-window-test", home, settings })),
      );
      const first = yield* service.readSummary(WINDOW);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
      );

      const reached = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(reached.buckets, first.buckets);
      assert.strictEqual(reached.sources[0]?.status, "ok");

      const later = yield* service.readSummary({
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-08-10"),
        untilDay: UsageDay.make("2026-08-12"),
      });
      assert.deepStrictEqual(later.buckets, []);
      assert.strictEqual(later.sources[0]?.status, "missing");
      assert.strictEqual(later.sources[0]?.scannedFiles, 0);
    }).pipe(Effect.scoped),
  );

  it.live("does not share an in-flight scan after custom prices change", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));
      const transcriptDir = yield* Effect.promise(() =>
        NodeFSP.realpath(NodePath.join(home, "claude", "projects")),
      );

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
                  if (path !== transcriptDir) return Effect.void;
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
        Effect.provide(layerService({ prefix: "usage-service-price-race-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live.each(["network", "http", "invalidJson", "empty"] as const)(
    "recovers pricing through the GitHub API after a %s failure",
    (failure) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const requests: HttpClientRequest.HttpClientRequest[] = [];
        const ratesDocument = {
          "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
        };
        const serviceLayer = layerService({
          prefix: `usage-service-rates-fallback-${failure}-test`,
          home,
          settings,
          onRatesFetch: (request) => requests.push(request),
          ratesResponse: (request) => {
            if (request.url.startsWith("https://api.github.com/")) {
              return Effect.succeed(Response.json(ratesDocument));
            }
            if (failure === "network") {
              return Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause: new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com"),
                  }),
                }),
              );
            }
            return Effect.succeed(
              failure === "invalidJson"
                ? new Response("not JSON")
                : Response.json({}, { status: failure === "http" ? 503 : 200 }),
            );
          },
        });
        const service = yield* UsageService.make.pipe(Effect.provide(serviceLayer));

        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(summary.pricing.status, "fresh");
        assert.strictEqual(summary.pricing.knownModels, 1);
        assert.closeTo(summary.buckets[0]?.costUsd ?? -1, 0.00035, 1e-12);
        assert.deepStrictEqual(
          requests.map((request) => request.url),
          [
            "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
            "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main",
          ],
        );
        assert.strictEqual(requests[1]?.headers.accept, "application/vnd.github.raw+json");

        const restarted = yield* UsageService.make.pipe(Effect.provide(serviceLayer));
        const cached = yield* restarted.readSummary(WINDOW);
        assert.strictEqual(cached.pricing.status, "cached");
        assert.deepStrictEqual(cached.buckets, summary.buckets);
        assert.strictEqual(requests.length, 2);
      }).pipe(Effect.scoped),
  );

  it.live("does not orphan an in-flight scan when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(layerService({ prefix: "usage-service-interruption-test", home, settings })),
      );

      let orphanedAt: number | undefined;
      // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- Fixed-count scheduler interruption matrix; each iteration exercises a different interruption point.
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
