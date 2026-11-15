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
import * as SqlClient from "effect/sql/SqlClient";

import { devinRateModel, devinUsageReader } from "./devinUsageReader.ts";

const openDatabase = Effect.fn("openDatabase")(function* (filename: string) {
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
  const sql = Context.get(context, SqlClient.SqlClient);
  return {
    exec: (statement: string) => sql.unsafe(statement),
    run: (statement: string, params: ReadonlyArray<unknown>) => sql.unsafe(statement, params),
  };
});

const seedDatabase = <E>(
  filename: string,
  seed: (db: Effect.Success<ReturnType<typeof openDatabase>>) => Effect.Effect<void, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed(yield* openDatabase(filename));
    }),
  );

const TABLES = [
  "CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, working_directory TEXT)",
  `CREATE TABLE message_nodes (
		row_id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		chat_message TEXT NOT NULL
	)`,
];

const T0 = Math.floor(Date.parse("2026-08-01T10:00:00Z") / 1000);

const assistantMessage = (input: {
  readonly requestId: string | null;
  readonly model: string | null;
  readonly metrics: Record<string, number> | null;
}) =>
  JSON.stringify({
    role: "assistant",
    content: "done",
    metadata: {
      request_id: input.requestId,
      generation_model: input.model,
      metrics: input.metrics,
    },
  });

const insertMessage = (
  db: Effect.Success<ReturnType<typeof openDatabase>>,
  session: string,
  createdAt: number,
  chatMessage: string,
) =>
  db.run("INSERT INTO message_nodes (session_id, created_at, chat_message) VALUES (?, ?, ?)", [
    session,
    createdAt,
    chatMessage,
  ]);

const scan = (dirs: string) =>
  devinUsageReader.kind === "scan"
    ? devinUsageReader.scan({
        instances: [
          {
            instanceId: ProviderInstanceId.make("devin"),
            config: {},
            environment: { DEVIN_SESSIONS_DIR: dirs },
            configured: false,
          },
        ],
        settings: DEFAULT_SERVER_SETTINGS,
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: false,
      })
    : Effect.die("devin usage reader must be a scan reader");

describe("devinUsageReader", () => {
  it.effect("counts each response once by request id and maps metrics into records", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const metrics = {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 4,
        cache_creation_tokens: 2,
      };
      yield* seedDatabase(path.join(dir, "sessions.db"), (db) =>
        Effect.gen(function* () {
          yield* Effect.forEach(TABLES, db.exec);
          yield* db.run(
            "INSERT INTO sessions VALUES ('session-1', 'gpt-6-astra-medium', '/home/dev/project')",
            [],
          );
          // A context rebuild re-saves the same response under a new node id.
          for (const _ of [0, 1]) {
            yield* insertMessage(
              db,
              "session-1",
              T0,
              assistantMessage({ requestId: "request-1", model: null, metrics }),
            );
          }
          yield* insertMessage(
            db,
            "session-1",
            T0 + 60,
            assistantMessage({
              requestId: null,
              model: null,
              metrics: {
                input_tokens: 7,
                output_tokens: 3,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
              },
            }),
          );
          yield* insertMessage(
            db,
            "session-1",
            T0 + 120,
            JSON.stringify({ role: "user", content: "hi" }),
          );
          yield* insertMessage(
            db,
            "session-1",
            T0 + 180,
            assistantMessage({ requestId: "request-3", model: null, metrics: null }),
          );
        }),
      );

      const scanned = yield* scan(dir);

      assert.strictEqual(scanned.length, 1);
      assert.strictEqual(scanned[0]!.status, "ok");
      const records = scanned[0]!.files![0]!.records;
      assert.deepStrictEqual(
        records.map(({ model, timestampMs, sessionId, totals, dedupeKey }) => ({
          model,
          timestampMs,
          sessionId,
          ...totals,
          dedupeKey,
        })),
        [
          {
            model: "gpt-6-astra-medium",
            timestampMs: T0 * 1000,
            sessionId: "session-1",
            uncachedInputTokens: 10,
            cachedInputTokens: 4,
            cacheCreationTokens: 2,
            outputTokens: 5,
            reasoningTokens: 0,
            dedupeKey: "devin:session-1:request-1",
          },
          {
            model: "gpt-6-astra-medium",
            timestampMs: (T0 + 60) * 1000,
            sessionId: "session-1",
            uncachedInputTokens: 7,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 3,
            reasoningTokens: 0,
            dedupeKey: "devin:session-1:node:3",
          },
        ],
      );
      assert.strictEqual(devinRateModel("claude-opus-5-5-high"), "claude-opus-5-5");
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/tmp"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("reports a missing source and an unreadable database", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const missing = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const corrupt = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      yield* fileSystem.writeFileString(path.join(corrupt, "sessions.db"), "not a database");

      const scanned = yield* scan(`${missing},${corrupt}`);

      assert.strictEqual(scanned.length, 2);
      const missingDir = yield* fileSystem.realPath(missing);
      const corruptDir = yield* fileSystem.realPath(corrupt);
      const [missingScan] = scanned.filter((entry) => entry.dir === missingDir);
      assert.strictEqual(missingScan!.status, "ok");
      assert.strictEqual(missingScan!.files, null);
      const [corruptScan] = scanned.filter((entry) => entry.dir === corruptDir);
      assert.strictEqual(corruptScan!.status, "partial");
      assert.strictEqual(corruptScan!.files![0]!.records.length, 0);
      assert.include(corruptScan!.message ?? "", "could not be read");
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/tmp"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("re-reads changed databases and honors the scan window", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const database = path.join(dir, "sessions.db");
      const create = seedDatabase(database, (db) =>
        Effect.gen(function* () {
          yield* Effect.forEach(TABLES, db.exec);
          yield* db.run(
            "INSERT INTO sessions VALUES ('session-1', 'gpt-6-astra-medium', '/home/dev/project')",
            [],
          );
          yield* insertMessage(
            db,
            "session-1",
            T0,
            assistantMessage({
              requestId: "request-1",
              model: null,
              metrics: {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
              },
            }),
          );
        }),
      );
      const append = seedDatabase(database, (db) =>
        insertMessage(
          db,
          "session-1",
          T0 + 60,
          assistantMessage({
            requestId: "request-2",
            model: null,
            metrics: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
            },
          }),
        ),
      );
      const recordsOf = (windowStartMs: number) =>
        Effect.map(scan(dir), (scanned) =>
          scanned[0]!.files![0]!.records.filter((record) => record.timestampMs >= windowStartMs),
        );

      yield* create;
      assert.strictEqual((yield* recordsOf(0)).length, 1);
      // The cached database filters by the window without re-reading rows.
      assert.strictEqual((yield* recordsOf((T0 + 60) * 1000)).length, 0);
      // A write changes the fingerprint, so the second response is read and dedupe still holds.
      yield* append;
      const after = yield* recordsOf(0);
      assert.strictEqual(after.length, 2);
      assert.deepStrictEqual(
        after.map(({ dedupeKey }) => dedupeKey),
        ["devin:session-1:request-1", "devin:session-1:request-2"],
      );
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/tmp"),
      Effect.provide(NodeServices.layer),
    ),
  );
});
