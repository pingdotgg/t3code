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
import { devinUsageReader, readDevinUsage } from "./devinUsage.ts";

const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

describe("readDevinUsage", () => {
  it.effect("counts each Devin inference once in the window and prices its base model", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "devin-usage-test-" });
      const filename = path.join(dir, "sessions.db");
      const db = yield* openDatabase(filename);
      yield* db.unsafe(
        "CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT)",
      );
      const sinceMs = Date.parse("2026-11-02T20:00:00Z");
      const assistant = (requestId: string, createdAt: string, model: string) =>
        JSON.stringify({
          role: "assistant",
          content: "",
          metadata: {
            request_id: requestId,
            created_at: createdAt,
            generation_model: model,
            metrics: {
              input_tokens: 2,
              output_tokens: 358,
              cache_read_tokens: 50794,
              cache_creation_tokens: 6031,
            },
          },
        });
      const insert = (chatMessage: string, createdAt: string) =>
        db.unsafe(
          "INSERT INTO message_nodes (session_id, chat_message, created_at) VALUES (?, ?, ?)",
          ["piquant-tungsten", chatMessage, Math.floor(Date.parse(createdAt) / 1000)],
        );
      const at = "2026-11-02T20:05:13.769583414Z";
      yield* insert(assistant("req-1", at, "claude-opus-5-5-high-fast"), at);
      // Devin stores one inference on several nodes with identical metrics.
      yield* insert(assistant("req-1", at, "claude-opus-5-5-high-fast"), at);
      yield* insert(assistant("req-2", at, "gpt-6-astra-medium"), at);
      yield* insert(
        assistant("req-old", "2026-11-01T10:00:00Z", "gpt-6-astra-medium"),
        "2026-11-01T10:00:00Z",
      );
      yield* insert(JSON.stringify({ role: "user", content: "hi" }), at);
      yield* insert("{invalid", at);

      const result = yield* readDevinUsage(filename, sinceMs);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.records.map(({ dedupeKey, model, rateModel, speed }) => ({
          dedupeKey,
          model,
          rateModel,
          speed,
        })),
        [
          {
            dedupeKey: "devin:req-1",
            model: "claude-opus-5-5-high-fast",
            rateModel: "claude-opus-5-5",
            speed: "fast",
          },
          {
            dedupeKey: "devin:req-2",
            model: "gpt-6-astra-medium",
            rateModel: "gpt-6-astra",
            speed: "standard",
          },
        ],
      );
      assert.deepStrictEqual(result.records[0]?.totals, {
        uncachedInputTokens: 2,
        cachedInputTokens: 50794,
        cacheCreationTokens: 6031,
        outputTokens: 358,
        reasoningTokens: 0,
      });
      assert.strictEqual(result.records[0]?.timestampMs, Date.parse(at));

      const missing = yield* readDevinUsage(path.join(dir, "absent.db"), sinceMs);
      assert.isTrue(missing.missing);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const decode = Schema.decodeUnknownSync(AcpRegistrySettings);

describe("devinUsageReader", () => {
  it.effect("scans only registry Devin instances", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instances = [
        { id: "acpRegistry", config: decode({}), dir: "/default" },
        { id: "acpRegistry_kimi", config: decode({ agentId: "kimi" }), dir: "/kimi" },
        {
          id: "acpRegistry_local",
          config: decode({ source: "local", agentId: "devin", commandPath: "devin" }),
          dir: "/local",
        },
        { id: "acpRegistry_devin", config: decode({ agentId: "devin" }), dir: "/devin" },
      ];
      if (devinUsageReader.kind !== "scan") throw new Error("Expected a Devin scan reader");
      const sources = yield* devinUsageReader
        .scan({
          instances: instances.map(({ id, config, dir }) => ({
            instanceId: ProviderInstanceId.make(id),
            config,
            environment: { DEVIN_SESSIONS_DIR: dir },
            configured: true,
          })),
          settings: DEFAULT_SERVER_SETTINGS,
          windowStartMs: 0,
          retentionCutoffMs: 0,
          awaitRefresh: true,
        })
        .pipe(Effect.provideService(HostProcess.HomeDirectory, "/home/test"));
      assert.deepStrictEqual(
        sources.map((source) => source.dir),
        [path.resolve("/devin")],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
