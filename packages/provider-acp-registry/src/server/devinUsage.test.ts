import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AcpRegistrySettings } from "../settings.ts";
import * as DevinUsageModule from "./devinUsage.ts";
import {
  decodeDevinDirCaches,
  DevinUsage,
  devinUsageReader,
  encodeDevinDirCaches,
  parseDevinModelRates,
  readDevinUsage,
} from "./devinUsage.ts";

const timestamp = "2026-11-03T10:00:00Z";
const sinceMs = Date.parse(timestamp);
const decodeSettings = Schema.decodeEffect(AcpRegistrySettings);

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "devin-usage-" });
  const dir = path.join(home, "devin", "cli");
  yield* fs.makeDirectory(dir, { recursive: true });
  const filename = path.join(dir, "sessions.db");
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* sql.unsafe("PRAGMA journal_mode=WAL");
  yield* sql.unsafe("PRAGMA wal_autocheckpoint=0");
  yield* sql.unsafe(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, last_activity_at INTEGER)",
  );
  yield* sql.unsafe(
    "CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, node_id INTEGER, chat_message TEXT, created_at INTEGER, UNIQUE(session_id, node_id))",
  );
  yield* sql.unsafe("CREATE INDEX idx_message_nodes_session ON message_nodes(session_id)");
  yield* sql.unsafe("INSERT INTO sessions VALUES (?, ?, ?)", [
    "fusion-session",
    "fusion-opus-sidekick-swe",
    sinceMs / 1000,
  ]);
  const insert = (nodeId: number, message: unknown, sessionId = "fusion-session") =>
    sql.unsafe(
      "INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)",
      [sessionId, nodeId, JSON.stringify(message), sinceMs / 1000],
    );
  return { dir, home, sql, insert };
});

const providerHostLayer = (stateDir: string) =>
  Layer.mock(ProviderHost.ProviderHost)({
    paths: {
      cwd: stateDir,
      baseDir: stateDir,
      stateDir,
      providerStatusCacheDir: stateDir,
      attachmentsDir: stateDir,
    },
    settings: {
      get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    resolveAttachmentPath: () => null,
  });

const makeService = Effect.fnUntraced(function* (stateDir: string) {
  const context = yield* Layer.build(
    DevinUsageModule.layer.pipe(Layer.provide(providerHostLayer(stateDir))),
  );
  return Context.get(context, DevinUsage);
});

const assistant = (requestId: string, model = "swe-2-high") => ({
  role: "assistant",
  metadata: {
    request_id: requestId,
    generation_model: model,
    created_at: timestamp,
    metrics: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 300,
      cache_creation_tokens: 50,
    },
  },
});

describe("Devin usage", () => {
  it.effect("publishes completed sessions before the first full scan finishes", () =>
    Effect.gen(function* () {
      const { dir, home, sql, insert } = yield* setup;
      yield* insert(1, assistant("first"));
      yield* sql.unsafe("INSERT INTO sessions VALUES (?, ?, ?)", [
        "later-session",
        "swe-2-high",
        sinceMs / 1000,
      ]);
      yield* insert(1, assistant("later"), "later-session");
      const service = yield* makeService(home);
      const input = { dir, sinceMs, awaitRefresh: true };
      const progress = yield* service.history(input);
      assert.strictEqual(progress.refreshing, true);
      assert.strictEqual(progress.files.flatMap((file) => file.records).length, 1);
      const completed = yield* service.history(input);
      assert.strictEqual(completed.refreshing, undefined);
      assert.strictEqual(completed.files.flatMap((file) => file.records).length, 2);
      yield* service.awaitPersisted;
      const restarted = yield* makeService(home);
      const restored = yield* restarted.history({ ...input, awaitRefresh: false });
      assert.strictEqual(restored.files.flatMap((file) => file.records).length, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "returns immediately during a history scan and reuses completed reads until the WAL changes",
    () =>
      Effect.gen(function* () {
        const { dir, home, insert } = yield* setup;
        yield* insert(1, assistant("first"));
        const service = yield* makeService(home);
        const input = { dir, sinceMs, awaitRefresh: false };
        const initial = yield* service.history(input);
        assert.strictEqual(initial.refreshing, true);
        assert.deepStrictEqual(initial.files, []);
        const completed = yield* service.history({ ...input, awaitRefresh: true });
        assert.isFalse(completed.error);
        assert.strictEqual(completed.files.flatMap((file) => file.records).length, 1);
        assert.strictEqual(yield* service.history(input), completed);
        yield* insert(2, assistant("second"));
        const stale = yield* service.history(input);
        assert.strictEqual(stale.refreshing, true);
        assert.strictEqual(stale.files.flatMap((file) => file.records).length, 1);
        const refreshed = yield* service.history({ ...input, awaitRefresh: true });
        assert.strictEqual(refreshed.files.flatMap((file) => file.records).length, 2);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "uses Windows APPDATA once for shared Devin instances and ignores other registry agents",
    () =>
      Effect.gen(function* () {
        const { home, dir, insert } = yield* setup;
        yield* insert(1, assistant("request"));
        const config = yield* decodeSettings({ agentId: "devin" });
        const otherConfig = yield* decodeSettings({
          agentId: "goose",
        });
        const historyService = yield* makeService(home);
        const instances = ["first", "second"].map((id) => ({
          instanceId: ProviderInstanceId.make(id),
          configured: true,
          config,
          environment: { APPDATA: home },
        }));
        const scans = yield* devinUsageReader
          .scan({
            instances: [
              ...instances,
              {
                instanceId: ProviderInstanceId.make("other"),
                configured: true,
                config: otherConfig,
                environment: { APPDATA: `${home}/other` },
              },
            ],
            settings: DEFAULT_SERVER_SETTINGS,
            windowStartMs: sinceMs,
            retentionCutoffMs: sinceMs,
            awaitRefresh: false,
          })
          .pipe(
            Effect.provideService(HostProcess.Platform, "win32"),
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.provideService(DevinUsage, {
              history: historyService.history,
              prices: () => Effect.succeed(new Map()),
              awaitPersisted: Effect.void,
            }),
            Effect.provide(providerHostLayer(home)),
          );
        assert.strictEqual(scans.length, 1);
        assert.strictEqual(scans[0]?.dir, dir);
        assert.strictEqual(scans[0]?.refreshing, true);
        assert.deepStrictEqual(scans[0]?.files, []);
        const completed = yield* historyService.history({ dir, sinceMs, awaitRefresh: true });
        assert.strictEqual(completed.files.flatMap((file) => file.records).length, 1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads Fusion models once per request across pages and sessions, including new WAL writes",
    () =>
      Effect.gen(function* () {
        const { dir, sql, insert } = yield* setup;
        for (let index = 0; index < 270; index++) {
          yield* insert(index * 2, assistant(`request-${index}`));
          yield* insert(index * 2 + 1, assistant(`request-${index}`));
        }
        yield* insert(550, {
          message_id: "a533966b-58be-42eb-bfa8-c57c922788ed",
          ...assistant("opus", "claude-opus-5-5-medium"),
          tool_calls: [{ role: "tool" }],
        });
        yield* insert(551, { role: "user", metadata: assistant("user").metadata });
        yield* insert(552, { role: "assistant", metadata: { metrics: null } });
        yield* insert(556, {
          message_id: "a533966b-58be-42eb-bfa8-c57c922788ed",
          role: "tool",
          content: "x".repeat(100_000),
          metadata: assistant("tool").metadata,
        });
        yield* sql.unsafe(
          "INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)",
          ["fusion-session", 553, "{invalid", sinceMs / 1000],
        );
        yield* insert(554, {
          ...assistant("old"),
          metadata: { ...assistant("old").metadata, created_at: "2026-11-02T23:59:59Z" },
        });
        yield* sql.unsafe("INSERT INTO sessions VALUES (?, ?, ?)", [
          "fork",
          "swe-2-high",
          sinceMs / 1000,
        ]);
        yield* insert(0, assistant("request-0"), "fork");
        const first = yield* readDevinUsage({ dir, sinceMs });
        assert.isFalse(first.result.error);
        assert.isFalse(first.result.missing);
        const records = first.result.files.flatMap((file) => file.records);
        assert.strictEqual(records.length, 271);
        assert.deepStrictEqual(records[0]?.totals, {
          uncachedInputTokens: 100,
          cachedInputTokens: 300,
          cacheCreationTokens: 50,
          outputTokens: 20,
          reasoningTokens: 0,
        });
        assert.deepStrictEqual(
          new Set(records.map((record) => record.model)),
          new Set(["swe-2-high", "claude-opus-5-5-medium"]),
        );
        assert.strictEqual(records[0]?.rateModel, "devin/swe-2-high");
        assert.strictEqual(records[0]?.reportedCostUsd, null);
        const cached = yield* readDevinUsage({ dir, sinceMs, cache: first.cache });
        assert.strictEqual(cached.rowsRead, 0);
        assert.deepStrictEqual(cached.result.files, first.result.files);
        yield* insert(555, assistant("new-request"));
        const next = yield* readDevinUsage({ dir, sinceMs, cache: cached.cache });
        assert.strictEqual(next.rowsRead, 1);
        assert.strictEqual(next.result.files.flatMap((file) => file.records).length, 272);
        yield* insert(10, assistant("request-269"), "fork");
        const duped = yield* readDevinUsage({ dir, sinceMs, cache: next.cache });
        assert.strictEqual(duped.rowsRead, 1);
        const deduped = duped.result.files.flatMap((file) => file.records);
        assert.strictEqual(deduped.length, 272);
        assert.strictEqual(
          deduped.find((record) => record.dedupeKey === "devin:request-269")?.sessionId,
          "fork",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restores persisted history before refreshing, and survives a corrupt cache", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, home, insert } = yield* setup;
      yield* insert(1, assistant("persisted"));
      const stateDir = path.join(home, "state");
      const first = yield* makeService(stateDir);
      const completed = yield* first.history({ dir, sinceMs, awaitRefresh: true });
      assert.strictEqual(completed.files.flatMap((file) => file.records).length, 1);
      yield* first.awaitPersisted;
      const restarted = yield* makeService(stateDir);
      const immediate = yield* restarted.history({ dir, sinceMs, awaitRefresh: false });
      assert.strictEqual(immediate.refreshing, true);
      assert.strictEqual(immediate.files.flatMap((file) => file.records).length, 1);
      const settled = yield* restarted.history({ dir, sinceMs, awaitRefresh: true });
      assert.strictEqual(settled.files.flatMap((file) => file.records).length, 1);
      const corruptDir = path.join(home, "corrupt-state");
      yield* fs.makeDirectory(corruptDir, { recursive: true });
      yield* fs.writeFileString(path.join(corruptDir, "devin-usage-cache.json"), "not json");
      const corrupt = yield* makeService(corruptDir);
      const empty = yield* corrupt.history({ dir, sinceMs, awaitRefresh: false });
      assert.deepStrictEqual(empty.files, []);
      const recovered = yield* corrupt.history({ dir, sinceMs, awaitRefresh: true });
      assert.strictEqual(recovered.files.flatMap((file) => file.records).length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("serves a persisted cache without rereading rows", () =>
    Effect.gen(function* () {
      const { dir, insert } = yield* setup;
      yield* insert(1, assistant("round-trip"));
      const first = yield* readDevinUsage({ dir, sinceMs });
      const restored = decodeDevinDirCaches(
        encodeDevinDirCaches(new Map([[dir, first.cache]])),
      ).get(dir);
      const reread = yield* readDevinUsage({ dir, sinceMs, cache: restored });
      assert.strictEqual(reread.rowsRead, 0);
      assert.deepStrictEqual(reread.result.files, first.result.files);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reflects rewritten and deleted rows without rereading unchanged rows", () =>
    Effect.gen(function* () {
      const { dir, sql, insert } = yield* setup;
      yield* insert(1, assistant("first"));
      yield* insert(2, assistant("second"));
      const first = yield* readDevinUsage({ dir, sinceMs });
      yield* sql.unsafe("DELETE FROM message_nodes WHERE session_id=? AND node_id=?", [
        "fusion-session",
        1,
      ]);
      yield* insert(1, {
        role: "assistant",
        metadata: {
          request_id: "first",
          generation_model: "swe-2-high",
          created_at: timestamp,
          metrics: {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
        },
      });
      const next = yield* readDevinUsage({ dir, sinceMs, cache: first.cache });
      assert.strictEqual(next.rowsRead, 1);
      const records = next.result.files.flatMap((file) => file.records);
      assert.strictEqual(records.length, 2);
      assert.strictEqual(
        records.find((record) => record.dedupeKey === "devin:first")?.totals.uncachedInputTokens,
        7,
      );
      yield* sql.unsafe("DELETE FROM message_nodes WHERE session_id=?", ["fusion-session"]);
      yield* sql.unsafe("DELETE FROM sessions WHERE id=?", ["fusion-session"]);
      const emptied = yield* readDevinUsage({ dir, sinceMs, cache: next.cache });
      assert.strictEqual(emptied.rowsRead, 0);
      assert.deepStrictEqual(emptied.result.files, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("widens and narrows the window from cached rows without rereads", () =>
    Effect.gen(function* () {
      const { dir, sql, insert } = yield* setup;
      const ancientTimestamp = "2026-11-02T08:00:00Z";
      const ancientMs = Date.parse(ancientTimestamp);
      yield* sql.unsafe("INSERT INTO sessions VALUES (?, ?, ?)", [
        "old-session",
        "old-model",
        Math.floor(ancientMs / 1000),
      ]);
      yield* insert(1, assistant("current"));
      yield* insert(
        1,
        {
          role: "assistant",
          metadata: {
            request_id: "ancient",
            generation_model: "swe-2-high",
            created_at: ancientTimestamp,
            metrics: {
              input_tokens: 5,
              output_tokens: 2,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
            },
          },
        },
        "old-session",
      );
      const narrow = yield* readDevinUsage({ dir, sinceMs });
      assert.strictEqual(narrow.result.files.flatMap((file) => file.records).length, 1);
      const wide = yield* readDevinUsage({ dir, sinceMs: ancientMs - 1, cache: narrow.cache });
      assert.strictEqual(wide.rowsRead, 1);
      assert.strictEqual(wide.result.files.flatMap((file) => file.records).length, 2);
      const narrowed = yield* readDevinUsage({ dir, sinceMs, cache: wide.cache });
      assert.strictEqual(narrowed.rowsRead, 0);
      assert.strictEqual(narrowed.result.files.flatMap((file) => file.records).length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resets the cache when the database is replaced", () =>
    Effect.gen(function* () {
      const first = yield* setup;
      for (let index = 0; index < 8; index++) {
        yield* first.insert(index, assistant(`stale-${index}`));
      }
      const stale = yield* readDevinUsage({ dir: first.dir, sinceMs });
      const second = yield* setup;
      yield* second.insert(1, assistant("fresh"));
      const next = yield* readDevinUsage({
        dir: second.dir,
        sinceMs,
        cache: stale.cache,
      });
      assert.isFalse(next.result.error);
      const records = next.result.files.flatMap((file) => file.records);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.dedupeKey, "devin:fresh");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns stale history with an error after the database becomes unreadable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, home, insert } = yield* setup;
      yield* insert(1, assistant("stable"));
      const stateDir = path.join(home, "state");
      const service = yield* makeService(stateDir);
      const first = yield* service.history({ dir, sinceMs, awaitRefresh: true });
      assert.strictEqual(first.files.flatMap((file) => file.records).length, 1);
      const read = yield* readDevinUsage({ dir, sinceMs });
      yield* fs.writeFileString(path.join(dir, "sessions.db"), "not a database");
      yield* fs.writeFileString(path.join(dir, "sessions.db-wal"), "not a database");
      const failed = yield* readDevinUsage({ dir, sinceMs, cache: read.cache });
      assert.isTrue(failed.result.error);
      assert.deepStrictEqual(failed.cache, read.cache);
      const stale = yield* service.history({ dir, sinceMs, awaitRefresh: true });
      assert.isTrue(stale.error);
      assert.strictEqual(stale.files.flatMap((file) => file.records).length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("distinguishes absent history from an unreadable database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "devin-usage-missing-" });
      const missing = yield* readDevinUsage({ dir, sinceMs: 0 });
      assert.deepStrictEqual(missing.result, {
        files: [],
        missing: true,
        error: false,
      });
      assert.strictEqual(missing.rowsRead, 0);
      assert.isFalse(yield* fs.exists(path.join(dir, "sessions.db")));
      yield* fs.writeFileString(path.join(dir, "sessions.db"), "not a database");
      assert.isTrue((yield* readDevinUsage({ dir, sinceMs: 0 })).result.error);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("parses Devin prices without treating unknown rates as free", () => {
    const rates = parseDevinModelRates({
      families: [
        {
          variants: [
            {
              model_uid: "opus",
              cost_summary: "$4 / 1M Input · $0.2 / 1M Cached input · $20 / 1M Output",
            },
            { model_uid: "free", cost_tier: "Free" },
            { model_uid: "unknown", cost_tier: "High cost" },
            { model_uid: "bad", cost_summary: "$4 / 1M Input" },
          ],
        },
      ],
    });
    assert.deepStrictEqual(rates.get("devin/opus"), {
      inputCostPerToken: 4e-6,
      outputCostPerToken: 20e-6,
      cacheReadCostPerToken: 0.2 / 1e6,
      cacheCreationCostPerToken: 4e-6,
    });
    assert.strictEqual(rates.get("devin/free")?.inputCostPerToken, 0);
    assert.isFalse(rates.has("devin/unknown"));
    assert.isFalse(rates.has("devin/bad"));
    assert.strictEqual(parseDevinModelRates({ families: "invalid" }).size, 0);
  });
});
