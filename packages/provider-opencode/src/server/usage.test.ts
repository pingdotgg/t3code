import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderUsageInstance } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import type { OpenCodeSettings } from "../settings.ts";
import { openCodeUsageReader, readOpenCodeUsage } from "./usage.ts";

/** A writable connection that stays open until the test's scope closes. */
const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

const seedHistory = Effect.fn("seedHistory")(function* (root: string, id: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(root, { recursive: true });
  const db = yield* openDatabase(path.join(root, "opencode.db"));
  yield* db.unsafe("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
  yield* db.unsafe("INSERT INTO message VALUES (?, ?, ?)", [
    id,
    "session-1",
    JSON.stringify({
      role: "assistant",
      modelID: "claude-sonnet-4-5",
      time: { created: 1780000000000 },
      tokens: { input: 100, output: 20 },
    }),
  ]);
});

const usageInstance = (id: string, environment: NodeJS.ProcessEnv, configured = true) => ({
  instanceId: ProviderInstanceId.make(id),
  config: undefined,
  environment,
  configured,
});

const scanUsage = (instances: readonly ProviderUsageInstance<OpenCodeSettings>[]) => {
  if (openCodeUsageReader.kind !== "scan") throw new Error("Expected an OpenCode scan reader");
  return openCodeUsageReader.scan({
    instances,
    settings: DEFAULT_SERVER_SETTINGS,
    windowStartMs: 0,
    retentionCutoffMs: 0,
    awaitRefresh: true,
  });
};

describe("readOpenCodeUsage", () => {
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
});

describe("openCodeUsageReader", () => {
  it.effect("reads histories from each instance's environment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-instances-test-" });
      const home = yield* fileSystem.realPath(temp);
      const first = path.join(home, "first");
      const dataHome = path.join(home, "second");
      const second = path.join(dataHome, "opencode");
      yield* seedHistory(first, "msg-first");
      yield* seedHistory(second, "msg-second");

      const sources = yield* scanUsage([
        usageInstance("opencode-first", {
          OPENCODE_DATA_DIR: " ~/first, , ",
          XDG_DATA_HOME: path.join(home, "unused"),
        }),
        usageInstance("opencode-second", { XDG_DATA_HOME: ` ${dataHome} ` }),
      ]).pipe(
        Effect.provideService(HostProcess.Environment, {
          OPENCODE_DATA_DIR: path.join(home, "host"),
        }),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );

      assert.deepStrictEqual(
        sources.map((source) => source.dir),
        [first, second],
      );
      assert.deepStrictEqual(
        sources.map((source) => source.status),
        ["ok", "ok"],
      );
      const records = sources.flatMap(
        (source) => source.files?.flatMap((file) => file.records) ?? [],
      );
      assert.deepStrictEqual(
        records.map((record) => record.dedupeKey),
        ["opencode:msg-first", "opencode:msg-second"],
      );
      assert.strictEqual(
        records.reduce((sum, record) => sum + record.totals.uncachedInputTokens, 0),
        200,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { dataHome: "absolute", dataDirs: undefined },
    { dataHome: "relative", dataDirs: " , " },
    { dataHome: "absent", dataDirs: undefined },
  ])("retains the implicit host default for $dataHome XDG_DATA_HOME", ({ dataHome, dataDirs }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-default-test-" });
      const home = yield* fileSystem.realPath(temp);
      const root = path.join(home, dataHome === "absolute" ? "xdg" : ".local/share", "opencode");
      const environment = {
        OPENCODE_DATA_DIR: dataDirs,
        XDG_DATA_HOME:
          dataHome === "absolute"
            ? path.join(home, "xdg")
            : dataHome === "relative"
              ? "relative"
              : undefined,
      };
      yield* seedHistory(root, "msg-default");

      const sources = yield* scanUsage([usageInstance("opencode", environment, false)]).pipe(
        Effect.provideService(HostProcess.Environment, environment),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      assert.deepStrictEqual(
        sources.map((source) => source.dir),
        [root],
      );
      assert.deepStrictEqual(
        sources.flatMap(
          (source) =>
            source.files?.flatMap((file) => file.records.map((record) => record.dedupeKey)) ?? [],
        ),
        ["opencode:msg-default"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
