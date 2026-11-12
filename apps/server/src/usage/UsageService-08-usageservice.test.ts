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
  it.live("reports one Cursor source when two API keys belong to the same account", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      const cursor = makeFakeCursor();
      cursor.state.events = [{ timestampMs: CURSOR_NOW - 3 * HOUR_MS, outputTokens: 7 }];
      let revoked = false;
      yield* Effect.gen(function* () {
        const service = yield* makeWithCursor((credential, sinceMs, untilMs) =>
          revoked && (credential as { apiKey?: string }).apiKey === "second-key"
            ? Effect.succeed({
                accountKey: null,
                records: [],
                missing: false,
                error: "Cursor account usage could not be read.",
              })
            : cursor.read(credential, sinceMs, untilMs),
        );
        const first = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.strictEqual(cursor.state.credentials.length, 2);
        assert.deepStrictEqual(
          cursorSources(first).map((source) => source.distinctSessions),
          [1],
        );

        // The revoked key keeps its stale cache, which must not replace the working key's history.
        revoked = true;
        cursor.state.events.push({ timestampMs: CURSOR_NOW + 60 * 1000, outputTokens: 5 });
        yield* TestClock.adjust(Duration.minutes(2));
        const second = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.deepStrictEqual(
          cursorSources(second).map((source) => source.status),
          ["ok"],
        );
        assert.strictEqual(totalOutputTokens(second), 12);
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-cursor-shared-account",
            home,
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("cursor")]: {
                  driver: ProviderDriverKind.make("cursor"),
                  environment: [{ name: "CURSOR_API_KEY", value: "first-key", sensitive: true }],
                },
                [ProviderInstanceId.make("cursor-work")]: {
                  driver: ProviderDriverKind.make("cursor"),
                  environment: [{ name: "CURSOR_API_KEY", value: "second-key", sensitive: true }],
                },
              },
            },
            platform: "darwin",
            environment: {},
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
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
});

