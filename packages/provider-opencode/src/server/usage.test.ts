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

import {
  openCodeForkContinuationSessionId,
  openCodeForkMessages,
  openCodeForkSchema,
  openCodeForkSessions,
  openCodeForkSourceAssistantId,
  openCodeForkSourceSessionId,
} from "./usage.fixture.ts";
import { openCodeUsageReader, readOpenCodeUsage } from "./usage.ts";

const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

const recordedForkDatabase = Effect.fn(function* (
  sessions: ReadonlyArray<{
    readonly id: string;
    readonly project_id: string;
    readonly fork_session_id: string | null;
    readonly fork_boundary: string | null;
    readonly slug: string;
    readonly directory: string;
    readonly version: string;
    readonly time_created: number;
    readonly time_updated: number;
  }>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-fork-test-" });
  const db = yield* openDatabase(path.join(dir, "opencode.db"));
  for (const statement of openCodeForkSchema) yield* db.unsafe(statement);
  for (const session of sessions) {
    yield* db.unsafe(
      "INSERT INTO session_v2 (id, project_id, fork_session_id, fork_boundary, slug, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        session.id,
        session.project_id,
        session.fork_session_id,
        session.fork_boundary,
        session.slug,
        session.directory,
        session.version,
        session.time_created,
        session.time_updated,
      ],
    );
  }
  for (const message of openCodeForkMessages) {
    yield* db.unsafe(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        message.id,
        message.session_id,
        message.type,
        message.seq,
        message.time_created,
        message.time_updated,
        message.data,
      ],
    );
  }
  return { dir, db };
});

describe("readOpenCodeUsage", () => {
  it.effect("bounds raw history allocations while counting every eligible message once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-large-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
      );
      const sinceMs = 1780000000000;
      const message = {
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        time: { created: sinceMs },
        tokens: { input: 100, output: 20 },
        body: "x".repeat(64 * 1024),
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
      yield* insert(302, "invalid", "{invalid");
      yield* insert(303, "msg-0", data);

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
      assert.isAbove(largestRawResult, 0);
      assert.isBelow(largestRawResult, 6 * 1024 * 1024);
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
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts an OpenCode reply once across the sessions forked from it", () =>
    Effect.gen(function* () {
      const { dir, db } = yield* recordedForkDatabase(openCodeForkSessions);
      // A reply sent after the second fork is a new provider request.
      yield* db.unsafe(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          "msg_continuationassistant00001",
          openCodeForkContinuationSessionId,
          "assistant",
          8,
          1792620090000,
          1792620090500,
          JSON.stringify({
            time: { created: 1792620090000, completed: 1792620090500 },
            agent: "build",
            model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
            content: [{ type: "text", text: "continued" }],
            finish: "stop",
            cost: 0.02,
            tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 1500, write: 0 } },
          }),
        ],
      );

      const result = yield* readOpenCodeUsage(dir, 0);
      assert.isFalse(result.error);
      const records = result.files.flatMap((file) => file.records);
      assert.deepStrictEqual(
        records.map((record) => [record.dedupeKey, record.sessionId]),
        [
          [`opencode:${openCodeForkSourceAssistantId}`, openCodeForkSourceSessionId],
          ["opencode:msg_continuationassistant00001", openCodeForkContinuationSessionId],
        ],
      );
      assert.deepStrictEqual(records[0]?.totals, {
        uncachedInputTokens: 1000,
        cachedInputTokens: 300,
        cacheCreationTokens: 0,
        outputTokens: 200,
        reasoningTokens: 0,
      });
      assert.strictEqual(records[0]?.reportedCostUsd, 0.01);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts each OpenCode fork's own replies after its boundary", () =>
    Effect.gen(function* () {
      const [source, fork] = openCodeForkSessions;
      const sibling = { ...fork, id: "ses_siblingfork00000000000000", slug: "quiet-river" };
      const { dir, db } = yield* recordedForkDatabase([...openCodeForkSessions, sibling]);
      const insert = (id: string, sessionId: string, seq: number, created: number, data: string) =>
        db.unsafe(
          "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', ?, ?, ?, ?)",
          [id, sessionId, seq, created, created, data],
        );
      const copied = openCodeForkMessages.find(
        (message) => message.id === openCodeForkSourceAssistantId,
      )!;
      yield* insert("msg_siblingcopy_2", sibling.id, copied.seq, copied.time_created, copied.data);
      // Sibling forks send identical replies at the same seq and millisecond.
      const created = 1792620090000;
      const reply = JSON.stringify({ ...JSON.parse(copied.data), time: { created } });
      yield* insert("msg_forkreply000000000000003", fork.id, 3, created, reply);
      yield* insert("msg_siblingreply0000000000003", sibling.id, 3, created, reply);

      const records = (yield* readOpenCodeUsage(dir, 0)).files.flatMap((file) => file.records);
      assert.deepStrictEqual(
        records.map((record) => record.sessionId),
        [source.id, fork.id, sibling.id],
      );

      // Deleting the source leaves the first fork holding the only copy.
      yield* db.unsafe("DELETE FROM session_message WHERE session_id = ?", [source.id]);
      yield* db.unsafe("DELETE FROM session_v2 WHERE id = ?", [source.id]);
      const remaining = (yield* readOpenCodeUsage(dir, 0)).files.flatMap((file) => file.records);
      assert.includeMembers(
        remaining.map((record) => record.dedupeKey),
        ["opencode:msg_1607ab38e001GxURO0NU4GY4Az_2", "opencode:msg_forkreply000000000000003"],
      );
      assert.notInclude(
        remaining.map((record) => record.dedupeKey),
        "opencode:msg_1607b8a6d001MA7a5GgmyUywMf_2",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts identical OpenCode replies in sessions that were not forked", () =>
    Effect.gen(function* () {
      const { dir } = yield* recordedForkDatabase(
        openCodeForkSessions.map((session) => ({
          ...session,
          fork_session_id: null,
          fork_boundary: null,
        })),
      );

      const result = yield* readOpenCodeUsage(dir, 0);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.sessionId),
        openCodeForkSessions.map((session) => session.id),
      );
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
