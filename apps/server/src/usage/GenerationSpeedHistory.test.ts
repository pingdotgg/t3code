import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  UsageDay,
  type GenerationSpeedMeasurement,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GenerationSpeedHistory from "./GenerationSpeedHistory.ts";

const window: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-10-14"),
  untilDay: UsageDay.make("2026-10-14"),
  timeZone: "UTC",
};
const sample: GenerationSpeedMeasurement = {
  provider: "codex",
  model: "gpt-6.1",
  reasoningEffort: "high",
  startedAt: "2026-10-14T10:00:00.000Z",
  outputTokens: 200,
  durationMs: 4_000,
  responses: 1,
};

describe("generation speed history", () => {
  it("buckets in the reporting timezone and separates effort and service tier", () => {
    const buckets = GenerationSpeedHistory.aggregateGenerationSpeed(
      [
        { ...sample, startedAt: "2026-10-15T00:30:00.000Z" },
        { ...sample, startedAt: "2026-10-15T00:45:00.000Z", outputTokens: 400 },
        {
          ...sample,
          startedAt: "2026-10-15T00:45:00.000Z",
          reasoningEffort: "low",
          serviceTier: "fast",
        },
        { ...sample, startedAt: "2026-10-14T00:30:00.000Z" },
      ],
      { ...window, timeZone: "America/Los_Angeles" },
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      day: "2026-10-14",
      outputTokens: 600,
      durationMs: 8_000,
      responses: 2,
      reasoningEffort: "high",
    });
    expect(buckets[1]).toMatchObject({ reasoningEffort: "low", serviceTier: "fast" });
  });

  it("honors exact rolling-hour bounds without counting unmeasured token totals", () => {
    const buckets = GenerationSpeedHistory.aggregateGenerationSpeed(
      [
        { ...sample, startedAt: "2026-10-14T09:59:59.000Z" },
        sample,
        { ...sample, startedAt: "2026-10-14T10:30:00.000Z" },
        { ...sample, startedAt: "2026-10-14T11:00:00.000Z" },
        { ...sample, outputTokens: 100_000, durationMs: 0 },
      ],
      {
        ...window,
        resolution: "hour",
        sinceTime: "2026-10-14T10:00:00.000Z",
        untilTime: "2026-10-14T11:00:00.000Z",
      },
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      hourStart: "2026-10-14T10:00:00.000Z",
      outputTokens: 400,
      durationMs: 8_000,
    });
  });

  it.effect(
    "reads measurements from existing turn JSON and preserves the tracking start across restarts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-generation-speed-" });
        const layer = GenerationSpeedHistory.layer.pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), home)),
        );
        const first = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const insert = (
            id: string,
            generation: GenerationSpeedMeasurement | undefined,
            attemptId: string | null = "attempt",
          ) => sql`
        INSERT INTO orchestration_v2_projection_provider_turns
          (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, completed_at, payload_json)
        VALUES (${id}, 'thread', ${id}, 'node', ${attemptId}, 1, 'completed', '2026-10-14T10:00:00.000Z', '2026-10-14T10:02:00.000Z', ${JSON.stringify({ generationSpeed: generation })})
      `;
          yield* insert("measured", sample);
          yield* insert("legacy", undefined);
          yield* insert("child", sample, null);
          const history = yield* GenerationSpeedHistory.GenerationSpeedHistory;
          const result = yield* history.read(window);
          assert.isDefined(result);
          assert.equal(result.buckets.length, 1);
          assert.equal(result.buckets[0]?.outputTokens, 200);
          assert.equal(result.buckets[0]?.durationMs, 4_000);
          return result;
        }).pipe(Effect.provide(layer));
        const restarted = yield* Effect.gen(function* () {
          const history = yield* GenerationSpeedHistory.GenerationSpeedHistory;
          return yield* history.read(window);
        }).pipe(Effect.provide(Layer.fresh(layer)));
        assert.equal(restarted?.trackingStartedAt, first.trackingStartedAt);
        assert.equal(restarted?.sourceId, first.sourceId);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
