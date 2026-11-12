// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as Option from "effect/Option";
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

function claudeLine(
  id: number,
  outputTokens: number,
  model = "claude-fable-5",
  sessionId = "session-1",
): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId,
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
  readonly secretStore?: Partial<ServerSecretStore.ServerSecretStore["Service"]>;
}) =>
  layerCursorUsageAccounts(
    CursorAccountReader.layer.pipe(Layer.provide(CursorKeychain.layer)),
  ).pipe(
    Layer.provideMerge(AntigravityUsage.layer),
    Layer.provideMerge(MuseUsageHome.layer),
    Layer.provideMerge(ProviderHostLive.layer),
    Layer.provideMerge(CodexUsageHistory.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
    Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
    Layer.provideMerge(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: () => Effect.succeedNone,
        ...input.secretStore,
      }),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), NodePath.join(input.home, input.prefix)),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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
    credentials: [] as unknown[],
  };
  const read = (credential: unknown, sinceMs: number, untilMs: number) =>
    Effect.gen(function* () {
      state.calls.push({ sinceMs, untilMs });
      state.credentials.push(credential);
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

function cursorSources(summary: { readonly sources: readonly UsageSource[] }) {
  return summary.sources.filter((source) => source.fingerprint.provider === "cursor");
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




describe("UsageService", () => {
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
});

