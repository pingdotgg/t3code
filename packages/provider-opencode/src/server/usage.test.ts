import type * as NodeWorkerThreads from "node:worker_threads";
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
import { vi } from "vite-plus/test";

import { openCodeUsageReader, readOpenCodeUsage } from "./usage.ts";

const readerWorkers = vi.hoisted(() => ({ started: 0, enabled: false }));

// Statement spies only see the main thread, so reader workers fail to start unless a test enables them.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class ReaderWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(
        ...((readerWorkers.enabled
          ? args
          : [
              "throw new Error('reader workers disabled');",
              { eval: true },
            ]) as ConstructorParameters<typeof actual.Worker>),
      );
      readerWorkers.started++;
    }
  }
  return { ...actual, Worker: ReaderWorker };
});

const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

describe("readOpenCodeUsage", () => {
  it.effect("bounds raw history allocations while counting every eligible message once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-large-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe("PRAGMA journal_mode = WAL");
      yield* db.unsafe(
        "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
      );
      const sinceMs = 1780000000000;
      const message = {
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        time: { created: sinceMs },
        tokens: { input: 100, output: 20 },
        body: "x".repeat(256 * 1024),
      };
      const data = JSON.stringify(message);
      const insert = (rowId: number, id: string, payload: string, created = sinceMs) =>
        db.unsafe(
          "INSERT INTO message (rowid, id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)",
          [rowId, id, "session-1", payload, created],
        );
      for (let index = 0; index < 130; index++) {
        yield* insert(index * 2 - 10, `msg-${index}`, data);
      }
      yield* insert(300, "old", data, sinceMs - 1);
      yield* insert(301, "user", JSON.stringify({ ...message, role: "user" }));
      for (let index = 0; index < 32; index++) {
        yield* insert(
          400 + index,
          `user-${index}`,
          JSON.stringify({
            role: "user",
            summary: { diffs: [{ patch: "x".repeat(1024 * 1024) }] },
          }),
        );
      }
      yield* insert(302, "invalid", "{invalid");
      yield* insert(303, "msg-0", data);

      const writer = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(path.join(dir, "opencode.db"))),
        (database) => Effect.sync(() => database.close()),
      );
      let changed = false;
      let largestRawResult = 0;
      const originalAll = NodeSqlite.StatementSync.prototype.all;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
            this: NodeSqlite.StatementSync,
            ...params
          ) {
            const rows = originalAll.apply(this, params);
            const rawSize = rows.reduce(
              (size, row) => size + (typeof row.data === "string" ? row.data.length : 0),
              0,
            );
            largestRawResult = Math.max(largestRawResult, rawSize);
            if (!changed && rawSize > 0) {
              changed = true;
              writer
                .prepare("UPDATE message SET data = ? WHERE id = ?")
                .run(JSON.stringify({ ...message, tokens: { input: 900, output: 20 } }), "msg-129");
            }
            return rows;
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.error);
      const records = result.files.flatMap((file) => file.records);
      assert.deepStrictEqual(
        records.map((record) => record.dedupeKey),
        Array.from({ length: 130 }, (_, index) => `opencode:msg-${index}`),
      );
      assert.strictEqual(
        records.reduce((total, record) => total + record.totals.uncachedInputTokens, 0),
        13000,
      );
      assert.strictEqual(
        (yield* readOpenCodeUsage(dir, sinceMs)).files
          .flatMap((file) => file.records)
          .find((record) => record.dedupeKey === "opencode:msg-129")?.totals.uncachedInputTokens,
        900,
      );
      assert.isAbove(largestRawResult, 0);
      assert.isBelow(largestRawResult, 64 * 1024);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads statements in proportion to the window despite sparse, unordered rowids", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-window-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
      );
      yield* db.unsafe("CREATE INDEX message_time ON message(time_created)");
      const sinceMs = 1780000000000;
      const data = JSON.stringify({ modelID: "m", tokens: { input: 1 } });
      yield* db.unsafe(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
        INSERT INTO message SELECT 'old-' || i, 's', ?, ? FROM n`,
        [data, sinceMs - 1],
      );
      for (const [rowid, id] of [
        [-10, "a"],
        [10000, "b"],
        [20000, "c"],
      ] as const) {
        yield* db.unsafe(
          "INSERT INTO message(rowid, id, session_id, data, time_created) VALUES (?, ?, 's', ?, ?)",
          [rowid, id, data, sinceMs],
        );
      }
      let statements = 0;
      let bodyReads = 0;
      const originalAll = NodeSqlite.StatementSync.prototype.all;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
            this: NodeSqlite.StatementSync,
            ...params
          ) {
            statements++;
            if (this.sourceSQL.includes("data ->")) bodyReads++;
            return originalAll.apply(this, params);
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:a", "opencode:b", "opencode:c"],
      );
      assert.isBelow(statements, 10);

      bodyReads = 0;
      const repeated = yield* readOpenCodeUsage(dir, sinceMs);
      assert.deepStrictEqual(
        repeated.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:a", "opencode:b", "opencode:c"],
      );
      // An unchanged database must not have its message bodies read and parsed again.
      assert.strictEqual(bodyReads, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not reuse rows from a replaced or restored database file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-replaced-" });
      const write = (name: string, input: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* openDatabase(path.join(dir, name));
            yield* db.unsafe("PRAGMA journal_mode = WAL");
            yield* db.unsafe(
              "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
            );
            yield* db.unsafe(
              "INSERT INTO message(rowid, id, session_id, time_created, time_updated, data) VALUES (1, 'a', 's', 1, 1, ?)",
              [JSON.stringify({ modelID: "m", tokens: { input } })],
            );
          }),
        );
      const input = Effect.map(
        readOpenCodeUsage(dir, 0),
        (result) => result.files[0]?.records[0]?.totals.uncachedInputTokens,
      );
      yield* write("opencode.db", 100);
      assert.strictEqual(yield* input, 100);
      yield* write("replacement.db", 900);
      yield* fileSystem.rename(path.join(dir, "replacement.db"), path.join(dir, "opencode.db"));
      assert.strictEqual(yield* input, 900);
      // A backup restored in place keeps the inode and birth time, like `cp -p`.
      yield* write("backup.db", 500);
      yield* fileSystem.copyFile(path.join(dir, "backup.db"), path.join(dir, "opencode.db"));
      yield* fileSystem.utimes(path.join(dir, "opencode.db"), 0, 0);
      assert.strictEqual(yield* input, 500);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts migrated OpenCode messages once and sees subsequent WAL writes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe("PRAGMA journal_mode = WAL");
      yield* db.unsafe("PRAGMA wal_autocheckpoint = 0");
      yield* db.unsafe("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
      const message = {
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        time: { created: 1780000000000 },
        cost: 0.25,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
      };
      const insert = (id: string, sessionId: string, data: string) =>
        db.unsafe("INSERT INTO message VALUES (?, ?, ?)", [id, sessionId, data]);
      yield* insert(message.id, message.sessionID, JSON.stringify(message));
      const legacy = path.join(dir, "storage", "message", message.sessionID);
      yield* fileSystem.makeDirectory(legacy, { recursive: true });
      yield* fileSystem.writeFileString(path.join(legacy, "msg-1.json"), JSON.stringify(message));
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          readerWorkers.enabled = true;
          readerWorkers.started = 0;
        }),
        () => Effect.sync(() => (readerWorkers.enabled = false)),
      );
      let mainThreadBodyReads = 0;
      const originalAll = NodeSqlite.StatementSync.prototype.all;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
            this: NodeSqlite.StatementSync,
            ...params
          ) {
            if (this.sourceSQL.includes("data ->")) mainThreadBodyReads++;
            return originalAll.apply(this, params);
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const first = yield* readOpenCodeUsage(dir, 0);
      assert.isFalse(first.error);
      const records = first.files.flatMap((file) => file.records);
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0]?.totals, {
        uncachedInputTokens: 100,
        cachedInputTokens: 30,
        cacheCreationTokens: 10,
        outputTokens: 25,
        reasoningTokens: 5,
      });
      assert.strictEqual(records[0]?.reportedCostUsd, 0.25);
      yield* insert(
        "msg-2",
        message.sessionID,
        JSON.stringify({ ...message, id: "msg-2", time: { created: 1780000001000 } }),
      );
      const next = yield* readOpenCodeUsage(dir, 1780000001000);
      assert.isFalse(next.error);
      assert.deepStrictEqual(
        next.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-2"],
      );
      assert.isAbove(Number((yield* fileSystem.stat(path.join(dir, "opencode.db-wal"))).size), 0);
      // A large database must not be read on the server's event loop.
      assert.isAbove(readerWorkers.started, 0);
      assert.strictEqual(mainThreadBodyReads, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "projects both SQLite formats without changing malformed or optional field handling",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-formats-" });
        const db = yield* openDatabase(path.join(dir, "opencode.db"));
        const sinceMs = 1780000000000;
        const message = { model: { id: "m" }, tokens: { input: 10 }, time: { created: sinceMs } };
        const cases = [
          ["assistant", JSON.stringify({ ...message, role: "assistant", cost: 0.25 }), true],
          ["absent-role", JSON.stringify(message), true],
          ["null-role", JSON.stringify({ ...message, role: null }), false],
          ["user", JSON.stringify({ ...message, role: "user" }), false],
          ["malformed", "{broken", false],
          ["json5", "{role:'assistant'}", false],
          ["null", null, false],
          ["blob", new Uint8Array(Buffer.from(JSON.stringify(message))), false],
          ["fallback", JSON.stringify({ modelID: "fallback-model", tokens: { output: 5 } }), true],
        ] as const;
        for (const table of ["message", "session_message"]) {
          yield* db.unsafe(
            `CREATE TABLE ${table} (id TEXT, session_id TEXT, data, type TEXT, time_created INTEGER)`,
          );
          for (const [id, data] of cases) {
            yield* db.unsafe(`INSERT INTO ${table} VALUES (?, 's', ?, 'assistant', ?)`, [
              `${table}-${id}`,
              data,
              sinceMs,
            ]);
          }
          yield* db.unsafe(`INSERT INTO ${table} VALUES (?, 's', ?, 'user', ?)`, [
            `${table}-type-user`,
            JSON.stringify(message),
            sinceMs,
          ]);
        }
        const result = yield* readOpenCodeUsage(dir, sinceMs);
        assert.isFalse(result.error);
        const records = result.files.flatMap((file) => file.records);
        assert.deepStrictEqual(
          records.map((record) => record.dedupeKey),
          [
            ...cases.filter(([, , valid]) => valid).map(([id]) => `opencode:message-${id}`),
            "opencode:message-type-user",
            ...cases.filter(([, , valid]) => valid).map(([id]) => `opencode:session_message-${id}`),
          ],
        );
        assert.strictEqual(records[0]?.reportedCostUsd, 0.25);
        assert.strictEqual(records[2]?.model, "fallback-model");
        assert.strictEqual(records[2]?.timestampMs, sinceMs);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads only legacy OpenCode messages written since the window opened", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const sinceMs = 1780000000000;
      const legacy = path.join(dir, "storage", "message", "session-1");
      yield* fileSystem.makeDirectory(legacy, { recursive: true });
      const write = Effect.fn(function* (id: string, mtimeMs: number) {
        const file = path.join(legacy, `${id}.json`);
        yield* fileSystem.writeFileString(
          file,
          JSON.stringify({
            id,
            sessionID: "session-1",
            role: "assistant",
            modelID: "claude-sonnet-4-5",
            time: { created: sinceMs + 1000 },
            tokens: { input: 100, output: 20 },
          }),
        );
        yield* fileSystem.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
        return file;
      });
      yield* write("msg-old", sinceMs - 60_000);

      const stale = yield* readOpenCodeUsage(dir, sinceMs);
      assert.deepStrictEqual(stale, { files: [], missing: false, error: false });

      const recent = yield* write("msg-new", sinceMs + 60_000);
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.missing);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        [recent],
      );
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-new"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keys OpenCode Go to opencode_go rates and keeps free gateway models at zero", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const base = {
        sessionID: "session-1",
        role: "assistant",
        time: { created: 1780000000000 },
        cost: 0,
        tokens: { input: 100, output: 20 },
      };
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
      yield* db.unsafe("INSERT INTO message VALUES ('msg-top', 'session-1', ?)", [
        JSON.stringify({ ...base, providerID: "opencode-go", modelID: "deepseek-v4.1-flash" }),
      ]);
      const legacy = path.join(dir, "storage", "message", "session-1");
      yield* fileSystem.makeDirectory(legacy, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(legacy, "msg-nested.json"),
        JSON.stringify({ ...base, model: { providerID: "opencode-go", id: "glm-5.3" } }),
      );
      yield* fileSystem.writeFileString(
        path.join(legacy, "msg-free.json"),
        JSON.stringify({ ...base, providerID: "opencode", modelID: "deepseek-v4.1-flash-free" }),
      );
      const result = yield* readOpenCodeUsage(dir, 0);
      assert.deepStrictEqual(
        result.files
          .flatMap((file) => file.records)
          .map(({ model, rateModel, reportedCostUsd }) => ({ model, rateModel, reportedCostUsd }))
          .sort((a, b) => a.model.localeCompare(b.model)),
        [
          {
            model: "deepseek-v4.1-flash",
            rateModel: "opencode_go/deepseek-v4.1-flash",
            reportedCostUsd: null,
          },
          { model: "deepseek-v4.1-flash-free", rateModel: undefined, reportedCostUsd: 0 },
          { model: "glm-5.3", rateModel: "opencode_go/glm-5.3", reportedCostUsd: null },
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never follows symlinks in the legacy OpenCode store", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const sinceMs = 1780000000000;
      const store = path.join(dir, "storage", "message");
      const session = path.join(store, "session-1");
      yield* fileSystem.makeDirectory(session, { recursive: true });
      const write = Effect.fn(function* (directory: string, id: string, mtimeMs: number) {
        const file = path.join(directory, `${id}.json`);
        yield* fileSystem.writeFileString(
          file,
          JSON.stringify({
            id,
            sessionID: "session-1",
            role: "assistant",
            modelID: "claude-sonnet-4-5",
            time: { created: sinceMs + 1000 },
            tokens: { input: 100, output: 20 },
          }),
        );
        yield* fileSystem.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
        return file;
      });
      const target = yield* write(outside, "msg-linked", sinceMs + 60_000);
      const stale = yield* write(outside, "msg-stale", sinceMs - 60_000);
      yield* fileSystem.symlink(target, path.join(session, "msg-linked.json"));
      yield* fileSystem.symlink(stale, path.join(session, "msg-stale.json"));
      yield* fileSystem.symlink(outside, path.join(store, "session-linked"));
      yield* fileSystem.symlink(store, path.join(session, "cycle"));
      yield* fileSystem.symlink(path.join(outside, "gone.json"), path.join(session, "gone.json"));
      yield* fileSystem.symlink(path.join(session, "loop.json"), path.join(session, "loop.json"));

      const linksOnly = yield* readOpenCodeUsage(dir, sinceMs);
      assert.deepStrictEqual(linksOnly, { files: [], missing: true, error: false });

      const real = yield* write(session, "msg-real", sinceMs + 60_000);
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.missing);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        [real],
      );
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-real"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
import * as NodeSqlite from "node:sqlite";

describe("openCodeUsageReader", () => {
  it.effect("scans canonical instance roots once, including XDG and home defaults", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-instances-test-" });
      const home = yield* fileSystem.realPath(temp);
      const defaultRoot = path.join(home, ".local", "share", "opencode");
      const instanceRoot = path.join(home, "instance");
      const dataHome = path.join(home, "xdg");
      const xdgRoot = path.join(dataHome, "opencode");
      const alias = path.join(home, "default-alias");
      for (const root of [defaultRoot, instanceRoot, xdgRoot]) {
        yield* fileSystem.makeDirectory(root, { recursive: true });
      }
      yield* fileSystem.symlink(defaultRoot, alias);
      const instances = [
        { id: "opencode", environment: {}, configured: false },
        {
          id: "opencode-list",
          environment: { OPENCODE_DATA_DIR: ` ${instanceRoot}, ${alias}, ${defaultRoot}, , ` },
          configured: true,
        },
        {
          id: "opencode-xdg",
          environment: { XDG_DATA_HOME: dataHome },
          configured: true,
        },
      ];
      if (openCodeUsageReader.kind !== "scan") throw new Error("Expected an OpenCode scan reader");
      const sources = yield* openCodeUsageReader
        .scan({
          instances: instances.map(({ id, environment, configured }) => ({
            instanceId: ProviderInstanceId.make(id),
            config: undefined,
            environment,
            configured,
          })),
          settings: DEFAULT_SERVER_SETTINGS,
          windowStartMs: 0,
          retentionCutoffMs: 0,
          awaitRefresh: true,
        })
        .pipe(
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
      assert.deepStrictEqual(
        sources.map((source) => source.dir).sort(),
        [defaultRoot, instanceRoot, xdgRoot].sort(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
