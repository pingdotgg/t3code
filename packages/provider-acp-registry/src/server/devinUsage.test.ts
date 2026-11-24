import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { AcpRegistrySettings } from "../settings.ts";
import { devinRateModel, devinUsageReader, isDevinAcpRegistryConfig } from "./devinUsage.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const WINDOW_START_MS = Date.parse("2026-11-20T00:00:00.000Z");
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1_000);

const assistant = (input: {
  readonly messageId: string;
  readonly requestId?: string;
  readonly createdAt?: string;
  readonly model?: string;
  readonly metrics: Record<string, number | null>;
}) =>
  JSON.stringify({
    role: "assistant",
    message_id: input.messageId,
    content: "done",
    metadata: {
      num_tokens: 1,
      ...(input.requestId === undefined ? {} : { request_id: input.requestId }),
      ...(input.createdAt === undefined ? {} : { created_at: input.createdAt }),
      ...(input.model === undefined ? {} : { generation_model: input.model }),
      metrics: input.metrics,
    },
  });

const writeDevinDatabase = Effect.fn(function* (filename: string) {
  const sql = yield* Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );
  yield* sql.unsafe(
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL,
       backend_type TEXT NOT NULL, model TEXT NOT NULL, agent_mode TEXT NOT NULL,
       created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT, metadata TEXT)`,
  );
  yield* sql.unsafe(
    `CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER,
       chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT,
       UNIQUE(session_id, node_id))`,
  );
  const now = seconds("2026-11-24T00:00:00.000Z");
  yield* sql.unsafe(
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at)
     VALUES ('session-1', '/repo', 'local', 'swe-2-high', 'normal', ?, ?),
            ('session-2', '/repo', 'local', 'swe-2-high', 'normal', ?, ?)`,
    [now, now, now, now],
  );
  const rows: Array<readonly [string, number, string, number]> = [
    [
      "session-1",
      1,
      assistant({
        messageId: "message-1",
        requestId: "request-1",
        createdAt: "2026-11-24T01:28:08.939838Z",
        model: "claude-opus-5-5-medium",
        metrics: {
          input_tokens: 2,
          output_tokens: 451,
          cache_read_tokens: 117_898,
          cache_creation_tokens: 1_324,
          context_input_tokens: 119_224,
        },
      }),
      seconds("2026-11-24T01:28:09.000Z"),
    ],
    // A branch copies the same inference onto a newer node.
    [
      "session-1",
      2,
      assistant({
        messageId: "message-1",
        requestId: "request-1",
        createdAt: "2026-11-24T01:28:08.939838Z",
        model: "claude-opus-5-5-medium",
        metrics: {
          input_tokens: 2,
          output_tokens: 451,
          cache_read_tokens: 117_898,
          cache_creation_tokens: 1_324,
        },
      }),
      seconds("2026-11-24T02:00:00.000Z"),
    ],
    [
      "session-1",
      3,
      assistant({
        messageId: "message-old",
        requestId: "request-old",
        createdAt: "2026-11-10T00:00:00.000Z",
        model: "swe-2-high",
        metrics: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 10 },
      }),
      seconds("2026-11-10T00:00:00.000Z"),
    ],
    // A copy written inside the window of an inference made before it.
    [
      "session-1",
      4,
      assistant({
        messageId: "message-copied-old",
        requestId: "request-copied-old",
        createdAt: "2026-11-10T00:00:00.000Z",
        model: "swe-2-high",
        metrics: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 10 },
      }),
      seconds("2026-11-24T03:00:00.000Z"),
    ],
    [
      "session-1",
      5,
      JSON.stringify({ role: "user", message_id: "user-1", metadata: { num_tokens: 5 } }),
      seconds("2026-11-24T03:00:00.000Z"),
    ],
    ["session-1", 6, "{not json", seconds("2026-11-24T03:00:00.000Z")],
    [
      "session-2",
      1,
      assistant({
        messageId: "message-2",
        requestId: "request-2",
        createdAt: "2026-11-24T04:00:00.000Z",
        metrics: {
          input_tokens: 1_606,
          output_tokens: 276,
          cache_read_tokens: 49_834,
          cache_creation_tokens: null,
        },
      }),
      seconds("2026-11-24T04:00:01.000Z"),
    ],
    [
      "session-2",
      2,
      assistant({
        messageId: "message-3",
        model: "swe-2-max",
        metrics: { input_tokens: 5, output_tokens: 7 },
      }),
      seconds("2026-11-24T05:00:00.000Z"),
    ],
  ];
  for (const [sessionId, nodeId, chatMessage, createdAt] of rows) {
    yield* sql.unsafe(
      `INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)`,
      [sessionId, nodeId, chatMessage, createdAt],
    );
  }
  // Enough distinct inferences to cross a page boundary.
  yield* sql.unsafe(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
     INSERT INTO message_nodes (session_id, node_id, chat_message, created_at)
     SELECT 'session-bulk', i, json_object(
         'role', 'assistant', 'message_id', 'bulk-' || i,
         'metadata', json_object('request_id', 'bulk-request-' || i,
           'created_at', '2026-11-25T00:00:00.000Z', 'generation_model', 'swe-2-high',
           'metrics', json_object('input_tokens', 1, 'output_tokens', 1))),
       ?
     FROM n`,
    [seconds("2026-11-25T00:00:00.000Z")],
  );
});

const scanDevin = Effect.fn(function* (
  instances: ReadonlyArray<{
    readonly config: typeof AcpRegistrySettings.Encoded;
    readonly environment: NodeJS.ProcessEnv;
  }>,
  home: string,
) {
  if (devinUsageReader.kind !== "scan") throw new Error("Expected a Devin scan reader");
  return yield* devinUsageReader
    .scan({
      instances: instances.map(({ config, environment }, index) => ({
        instanceId: ProviderInstanceId.make(`acp-${index}`),
        config: decodeSettings(config),
        environment,
        configured: true,
      })),
      settings: DEFAULT_SERVER_SETTINGS,
      windowStartMs: WINDOW_START_MS,
      retentionCutoffMs: WINDOW_START_MS,
      awaitRefresh: false,
    })
    .pipe(Effect.provideService(HostProcess.HomeDirectory, home));
});

const fixture = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "devin-usage-test-" });
  const home = path.join(root, "home");
  const dataHome = path.join(root, "data");
  const dir = path.join(dataHome, "devin", "cli");
  yield* fileSystem.makeDirectory(home, { recursive: true });
  yield* fileSystem.makeDirectory(dir, { recursive: true });
  yield* writeDevinDatabase(path.join(dir, "sessions.db"));
  return { home, dataHome, dir: yield* fileSystem.realPath(dir) };
});

describe("devinUsageReader", () => {
  it.effect("maps Devin's exclusive token counters and drops copies and out-of-window rows", () =>
    Effect.gen(function* () {
      const { home, dataHome, dir } = yield* fixture();
      const sources = yield* scanDevin(
        [{ config: { agentId: "devin" }, environment: { XDG_DATA_HOME: dataHome } }],
        home,
      );
      assert.strictEqual(sources.length, 1);
      const [source] = sources;
      assert.strictEqual(source!.dir, dir);
      assert.strictEqual(source!.status, "ok");
      const records = source!.files![0]!.records;
      const named = records.filter((record) => record.sessionId !== "session-bulk");
      assert.deepStrictEqual(named, [
        {
          provider: "devin",
          timestampMs: Date.parse("2026-11-24T01:28:08.939Z"),
          model: "claude-opus-5-5-medium",
          rateModel: "claude-opus-5-5",
          sessionId: "session-1",
          totals: {
            uncachedInputTokens: 2,
            cachedInputTokens: 117_898,
            cacheCreationTokens: 1_324,
            outputTokens: 451,
            reasoningTokens: 0,
          },
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: "devin:request-1",
        },
        {
          provider: "devin",
          timestampMs: Date.parse("2026-11-24T04:00:00.000Z"),
          model: "swe-2-high",
          rateModel: "swe-2",
          sessionId: "session-2",
          totals: {
            uncachedInputTokens: 1_606,
            cachedInputTokens: 49_834,
            cacheCreationTokens: 0,
            outputTokens: 276,
            reasoningTokens: 0,
          },
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: "devin:request-2",
        },
        {
          provider: "devin",
          timestampMs: seconds("2026-11-24T05:00:00.000Z") * 1_000,
          model: "swe-2-max",
          rateModel: "swe-2",
          sessionId: "session-2",
          totals: {
            uncachedInputTokens: 5,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 7,
            reasoningTokens: 0,
          },
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: "devin:message-3",
        },
      ]);
      assert.strictEqual(records.length - named.length, 600);
      assert.strictEqual(new Set(records.map((record) => record.dedupeKey)).size, records.length);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads nothing without a Devin instance", () =>
    Effect.gen(function* () {
      const { home, dataHome } = yield* fixture();
      const environment = { XDG_DATA_HOME: dataHome };
      const sources = yield* scanDevin(
        [
          { config: {}, environment },
          { config: { agentId: "claude-acp" }, environment },
          {
            config: { source: "local", agentId: "devin", commandPath: "/bin/notdevin" },
            environment,
          },
        ],
        home,
      );
      assert.deepStrictEqual(sources, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts a shared database once and reports a missing one as absent", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { home, dataHome, dir } = yield* fixture();
      const sources = yield* scanDevin(
        [
          { config: { agentId: "devin" }, environment: { XDG_DATA_HOME: dataHome } },
          {
            config: { source: "local", commandPath: "/opt/devin/bin/devin" },
            environment: { XDG_DATA_HOME: dataHome },
          },
          { config: { agentId: "devin" }, environment: {} },
        ],
        home,
      );
      const missingDir = path.join(home, ".local", "share", "devin", "cli");
      assert.deepStrictEqual(
        sources.map((source) => [source.dir, source.files === null]).sort(),
        [
          [dir, false],
          [missingDir, true],
        ].sort(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Devin model and instance detection", () => {
  it("prices effort variants at their base model", () => {
    assert.strictEqual(devinRateModel("claude-opus-5-5-medium"), "claude-opus-5-5");
    assert.strictEqual(devinRateModel("gpt-6-sol-xhigh"), "gpt-6-sol");
    assert.strictEqual(devinRateModel("compactor"), "compactor");
  });

  it("recognizes registry and local Devin connections", () => {
    assert.isTrue(isDevinAcpRegistryConfig(decodeSettings({ agentId: "devin" })));
    assert.isTrue(
      isDevinAcpRegistryConfig(
        decodeSettings({ source: "local", commandPath: "C:\\Tools\\Devin.exe" }),
      ),
    );
    assert.isFalse(isDevinAcpRegistryConfig(decodeSettings({})));
    assert.isFalse(isDevinAcpRegistryConfig(undefined));
  });
});
