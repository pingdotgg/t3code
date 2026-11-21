import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import { kiloUsageReader } from "./kiloUsage.ts";

const settings = Schema.decodeSync(AcpRegistrySettings);

describe("kiloUsageReader", () => {
  it.effect("counts local Kilo messages once and ignores other ACP agents", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kilo-usage-test-" });
      const directory = path.join(home, ".local", "share", "kilo");
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const database = path.join(directory, "kilo.db");
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(database);
        db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
        const insert = db.prepare(
          "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
        );
        insert.run(
          "msg-1",
          "ses-1",
          1_000,
          JSON.stringify({
            role: "assistant",
            modelID: "example/model",
            providerID: "example",
            tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 20, write: 4 } },
            cost: 0,
          }),
        );
        insert.run(
          "msg-2",
          "ses-1",
          1_100,
          JSON.stringify({
            role: "assistant",
            modelID: "kilo-auto/free",
            providerID: "kilo",
            tokens: { output: 1 },
            cost: 0,
          }),
        );
        insert.run(
          "msg-3",
          "ses-1",
          1_200,
          JSON.stringify({ role: "user", tokens: { input: 100 } }),
        );
        insert.run(
          "msg-4",
          "ses-2",
          100,
          JSON.stringify({ role: "assistant", modelID: "old", tokens: { output: 100 } }),
        );
        db.close();
      });

      if (kiloUsageReader.kind !== "scan") throw new Error("Expected a scan reader");
      const instances = [
        { id: "kilo", config: settings({ source: "local", commandPath: "/bin/kilo" }) },
        { id: "kilo-duplicate", config: settings({ agentId: "kilo-code" }) },
        { id: "unrelated", config: settings({ source: "local", commandPath: "/bin/other" }) },
      ];
      const sources = yield* kiloUsageReader.scan({
        instances: instances.map(({ id, config }) => ({
          instanceId: ProviderInstanceId.make(id),
          config,
          environment: { KILO_DB: database },
          configured: true,
        })),
        settings: DEFAULT_SERVER_SETTINGS,
        windowStartMs: 500,
        retentionCutoffMs: 500,
        awaitRefresh: true,
      });
      expect(sources).toHaveLength(1);
      expect(sources[0]?.status).toBe("ok");
      expect(sources[0]?.files?.[0]?.records).toEqual([
        {
          provider: "kilo",
          timestampMs: 1_000,
          model: "example/model",
          sessionId: "ses-1",
          totals: {
            uncachedInputTokens: 10,
            cachedInputTokens: 20,
            cacheCreationTokens: 4,
            outputTokens: 5,
            reasoningTokens: 2,
          },
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: "kilo:msg-1",
        },
        {
          provider: "kilo",
          timestampMs: 1_100,
          model: "kilo-auto/free",
          sessionId: "ses-1",
          totals: {
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 1,
            reasoningTokens: 0,
          },
          reportedCostUsd: 0,
          speed: "standard",
          dedupeKey: "kilo:msg-2",
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
