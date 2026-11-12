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
  it.live.each([4, 5, 6, 7, 8, 10])(
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
              if (version >= 8 && path === livePath) {
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
          assert.strictEqual(SCAN_CACHE_FILE_NAME, "usage-scan-cache-v11.json");
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
  it.live("re-parses a clean v10 Codex rollout that grew after an interrupted request", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const sessions = NodePath.join(home, "codex", "sessions");
      const live = NodePath.join(sessions, "live.jsonl");
      const usage = (input: number, output: number) => ({
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
      });
      const lines = (values: readonly unknown[]) =>
        values.map((value) => `${encodeUnknownJsonString(value)}\n`).join("");
      const request = (second: number, last: unknown) => ({
        type: "token_usage_record",
        timestamp: `2026-08-01T10:00:0${second}Z`,
        payload: { usage: last },
      });
      const tokenCount = (second: number, last: unknown, total: unknown) => ({
        type: "event_msg",
        timestamp: `2026-08-01T10:00:0${second}Z`,
        payload: {
          type: "token_count",
          info: { last_token_usage: last, total_token_usage: total },
        },
      });
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(sessions, { recursive: true });
        await NodeFSP.writeFile(
          live,
          lines([
            { type: "session_meta", payload: { id: "live" } },
            { type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-6-astra" } },
            request(1, usage(100, 20)),
            tokenCount(1, usage(100, 20), usage(100, 20)),
            // Interrupted after this request finished: no token_count reports it.
            request(2, usage(150, 10)),
          ]),
        );
      });

      yield* Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const tokens = (summary: UsageSummary) =>
          summary.buckets.reduce((sum, bucket) => sum + totalTokens(bucket.totals), 0);
        const first = yield* UsageService.make;
        assert.strictEqual(tokens(yield* first.readSummary(WINDOW)), 120);
        yield* first.awaitPersisted;

        yield* Effect.promise(async () => {
          const cachePath = NodePath.join(stateDir, SCAN_CACHE_FILE_NAME);
          const document = decodeUnknownJsonString(await NodeFSP.readFile(cachePath, "utf8")) as {
            files: Record<string, { cs: Record<string, unknown> }>;
          };
          // The v10 parser ignored `token_usage_record`, so its clean state held nothing pending.
          for (const file of Object.values(document.files)) {
            file.cs = Object.fromEntries(
              Object.entries(file.cs).filter(([key]) => !key.startsWith("unreported")),
            );
          }
          await NodeFSP.rm(cachePath);
          await NodeFSP.writeFile(
            NodePath.join(stateDir, "usage-scan-cache-v10.json"),
            encodeUnknownJsonString({ ...document, version: 10 }),
          );
          await NodeFSP.appendFile(
            live,
            lines([
              { type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-6-astra" } },
              request(5, usage(200, 30)),
              tokenCount(5, usage(200, 30), usage(450, 60)),
            ]),
          );
        });

        const upgraded = yield* UsageService.make;
        const summary = yield* upgraded.readSummary(WINDOW);
        assert.deepStrictEqual(
          {
            tokens: tokens(summary),
            malformedRecords: summary.sources.find(
              (source) => source.fingerprint.provider === "codex",
            )?.malformedRecords,
          },
          { tokens: 510, malformedRecords: 0 },
        );
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-cache-v10-interrupted-test",
            home,
            settings,
            ratesDocument: {
              "gpt-6-astra": { input_cost_per_token: 0, output_cost_per_token: 1 },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );
});

