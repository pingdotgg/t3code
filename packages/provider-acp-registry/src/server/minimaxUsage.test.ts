import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect, it } from "@effect/vitest";
import { miniMaxRateModel, minimaxUsageReader, readMiniMaxHistory } from "./minimaxUsage.ts";

it.effect("reads per-model totals without duplicating the session total or inventing costs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const path = pathService.join(dir, "state.db");
    const db = new NodeSqlite.DatabaseSync(path);
    db.exec(`CREATE TABLE sessions (id TEXT, started_at REAL);
    CREATE TABLE session_model_usage (session_id TEXT, model TEXT, first_seen REAL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, reasoning_tokens INTEGER, cost_status TEXT, actual_cost_usd REAL);
    INSERT INTO sessions VALUES ('s', 100);
    INSERT INTO session_model_usage VALUES ('s', 'MiniMax-M3', NULL, 10, 20, 30, 4, 5, 'unknown', 0);
    INSERT INTO session_model_usage VALUES ('s', 'other-model', NULL, 99, 99, 0, 0, 0, 'actual', 2);`);
    db.close();
    {
      const records = readMiniMaxHistory(path);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        model: "MiniMax-M3",
        rateModel: "minimax/MiniMax-M3",
        timestampMs: 100000,
        reportedCostUsd: null,
        totals: {
          uncachedInputTokens: 10,
          outputTokens: 20,
          cachedInputTokens: 30,
          cacheCreationTokens: 4,
          reasoningTokens: 5,
        },
      });
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("prices MiniMax models at their first-party rate entry", () => {
  expect(miniMaxRateModel("MiniMax-M3")).toBe("minimax/MiniMax-M3");
  expect(miniMaxRateModel("MiniMax-M2.5")).toBe("minimax/MiniMax-M2.5");
  expect(miniMaxRateModel("minimax-m2")).toBe("minimax/minimax-m2");
  // LiteLLM has no M2.7 entry; M2.7 shares M3's published rates.
  expect(miniMaxRateModel("MiniMax-M2.7")).toBe("minimax/MiniMax-M3");
  expect(miniMaxRateModel("claude-fable-5-1")).toBe("claude-fable-5-1");
});

it.effect("reads no history when no ACP registry instance is configured", () =>
  Effect.gen(function* () {
    const reader = minimaxUsageReader as Extract<typeof minimaxUsageReader, { kind: "scan" }>;
    const instance = (configured: boolean) => ({
      instanceId: "acpRegistry_hermes" as never,
      config: undefined,
      environment: {},
      configured,
    });
    const input = (configured: boolean) =>
      ({
        instances: [instance(configured)],
        settings: {} as never,
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: false,
      }) as never;

    // An unconfigured driver must not pick up the host's own ~/.hermes directory.
    expect(yield* reader.scan(input(false))).toHaveLength(0);
    expect(yield* reader.scan(input(true))).not.toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
