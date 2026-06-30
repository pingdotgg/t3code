import { LaneKey, PipelineRunId, StepKey, TicketId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { StepOutputHandoffReader } from "../Services/StepOutputHandoffReader.ts";
import { StepOutputHandoffReaderLive } from "./StepOutputHandoffReader.ts";

const readerLayer = it.layer(
  StepOutputHandoffReaderLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const seedPipelineRun = (input: {
  readonly pipelineRunId: PipelineRunId;
  readonly ticketId: TicketId;
  readonly laneKey: LaneKey;
  readonly status: string;
  readonly finishedAt: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_pipeline_run
        (pipeline_run_id, ticket_id, lane_key, lane_entry_token, status, started_at, finished_at)
      VALUES
        (${String(input.pipelineRunId)}, ${String(input.ticketId)}, ${String(input.laneKey)},
         ${"tok"}, ${input.status}, ${"2020-01-01T00:00:00.000Z"}, ${input.finishedAt})
    `;
  });

const seedStepRun = (input: {
  readonly stepRunId: string;
  readonly pipelineRunId: PipelineRunId;
  readonly ticketId: TicketId;
  readonly stepKey: StepKey;
  readonly status: string;
  readonly finishedAt: string | null;
  readonly output: unknown;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outputJson =
      input.output === undefined
        ? null
        : yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(input.output);
    yield* sql`
      INSERT INTO projection_step_run
        (step_run_id, pipeline_run_id, ticket_id, step_key, step_type, status, started_at, finished_at, output_json)
      VALUES
        (${input.stepRunId}, ${String(input.pipelineRunId)}, ${String(input.ticketId)},
         ${String(input.stepKey)}, ${"agent"}, ${input.status}, ${"2020-01-01T00:00:00.000Z"},
         ${input.finishedAt}, ${outputJson})
    `;
  });

readerLayer("StepOutputHandoffReader", (it) => {
  it.effect("latestCompletedOutput returns the newest completed output by finished_at", () =>
    Effect.gen(function* () {
      const reader = yield* StepOutputHandoffReader;
      const ticketId = TicketId.make("ticket-1");
      const laneKey = LaneKey.make("implement");
      const stepKey = StepKey.make("review");
      const runId = PipelineRunId.make("run-1");

      yield* seedPipelineRun({
        pipelineRunId: runId,
        ticketId,
        laneKey,
        status: "completed",
        finishedAt: "2020-01-01T00:05:00.000Z",
      });
      yield* seedStepRun({
        stepRunId: "step-old",
        pipelineRunId: runId,
        ticketId,
        stepKey,
        status: "completed",
        finishedAt: "2020-01-01T00:01:00.000Z",
        output: { verdict: "old" },
      });
      yield* seedStepRun({
        stepRunId: "step-new",
        pipelineRunId: runId,
        ticketId,
        stepKey,
        status: "completed",
        finishedAt: "2020-01-01T00:02:00.000Z",
        output: { verdict: "new" },
      });

      const output = yield* reader.latestCompletedOutput(ticketId, laneKey, stepKey);
      assert.deepEqual(output, { verdict: "new" });
    }),
  );

  it.effect("latestCompletedOutput is loop-aware across pipeline runs", () =>
    Effect.gen(function* () {
      const reader = yield* StepOutputHandoffReader;
      const ticketId = TicketId.make("ticket-2");
      const laneKey = LaneKey.make("implement");
      const stepKey = StepKey.make("review");
      const firstRun = PipelineRunId.make("run-2a");
      const secondRun = PipelineRunId.make("run-2b");

      yield* seedPipelineRun({
        pipelineRunId: firstRun,
        ticketId,
        laneKey,
        status: "completed",
        finishedAt: "2020-01-01T00:05:00.000Z",
      });
      yield* seedPipelineRun({
        pipelineRunId: secondRun,
        ticketId,
        laneKey,
        status: "completed",
        finishedAt: "2020-01-01T00:10:00.000Z",
      });
      yield* seedStepRun({
        stepRunId: "step-pass1",
        pipelineRunId: firstRun,
        ticketId,
        stepKey,
        status: "completed",
        finishedAt: "2020-01-01T00:03:00.000Z",
        output: { pass: 1 },
      });
      yield* seedStepRun({
        stepRunId: "step-pass2",
        pipelineRunId: secondRun,
        ticketId,
        stepKey,
        status: "completed",
        finishedAt: "2020-01-01T00:08:00.000Z",
        output: { pass: 2 },
      });

      const output = yield* reader.latestCompletedOutput(ticketId, laneKey, stepKey);
      assert.deepEqual(output, { pass: 2 });
    }),
  );

  it.effect("latestCompletedOutput ignores non-completed and other-lane rows", () =>
    Effect.gen(function* () {
      const reader = yield* StepOutputHandoffReader;
      const ticketId = TicketId.make("ticket-3");
      const laneKey = LaneKey.make("implement");
      const otherLane = LaneKey.make("review-lane");
      const stepKey = StepKey.make("review");

      const matchRun = PipelineRunId.make("run-3-match");
      const runningRun = PipelineRunId.make("run-3-running");
      const otherLaneRun = PipelineRunId.make("run-3-otherlane");

      yield* seedPipelineRun({
        pipelineRunId: matchRun,
        ticketId,
        laneKey,
        status: "completed",
        finishedAt: "2020-01-01T00:05:00.000Z",
      });
      yield* seedPipelineRun({
        pipelineRunId: runningRun,
        ticketId,
        laneKey,
        status: "running",
        finishedAt: null,
      });
      yield* seedPipelineRun({
        pipelineRunId: otherLaneRun,
        ticketId,
        laneKey: otherLane,
        status: "completed",
        finishedAt: "2020-01-01T00:20:00.000Z",
      });

      // The only completed step in the right lane.
      yield* seedStepRun({
        stepRunId: "step-match",
        pipelineRunId: matchRun,
        ticketId,
        stepKey,
        status: "completed",
        finishedAt: "2020-01-01T00:04:00.000Z",
        output: { verdict: "match" },
      });
      // Newer finished_at but not completed → ignored.
      yield* seedStepRun({
        stepRunId: "step-running",
        pipelineRunId: runningRun,
        ticketId,
        stepKey,
        status: "running",
        finishedAt: "2020-01-01T00:09:00.000Z",
        output: { verdict: "running" },
      });
      // Newer finished_at but a different lane → ignored.
      yield* seedStepRun({
        stepRunId: "step-otherlane",
        pipelineRunId: otherLaneRun,
        ticketId,
        stepKey,
        status: "completed",
        finishedAt: "2020-01-01T00:19:00.000Z",
        output: { verdict: "otherlane" },
      });

      const output = yield* reader.latestCompletedOutput(ticketId, laneKey, stepKey);
      assert.deepEqual(output, { verdict: "match" });
    }),
  );

  it.effect("latestCompletedOutput returns null when there is no completed output", () =>
    Effect.gen(function* () {
      const reader = yield* StepOutputHandoffReader;
      const output = yield* reader.latestCompletedOutput(
        TicketId.make("ticket-missing"),
        LaneKey.make("implement"),
        StepKey.make("review"),
      );
      assert.isNull(output);
    }),
  );

  it.effect("currentPassOutput returns this pass's output for the step key", () =>
    Effect.gen(function* () {
      const reader = yield* StepOutputHandoffReader;
      const ticketId = TicketId.make("ticket-4");
      const laneKey = LaneKey.make("implement");
      const stepKey = StepKey.make("implement");
      const thisRun = PipelineRunId.make("run-4-this");
      const otherRun = PipelineRunId.make("run-4-other");

      yield* seedPipelineRun({
        pipelineRunId: thisRun,
        ticketId,
        laneKey,
        status: "running",
        finishedAt: null,
      });
      yield* seedPipelineRun({
        pipelineRunId: otherRun,
        ticketId,
        laneKey,
        status: "completed",
        finishedAt: "2020-01-01T00:05:00.000Z",
      });
      yield* seedStepRun({
        stepRunId: "step-this",
        pipelineRunId: thisRun,
        ticketId,
        stepKey,
        status: "completed",
        finishedAt: "2020-01-01T00:02:00.000Z",
        output: { from: "this-pass" },
      });
      // Same step key in a different pipeline run → not returned by currentPassOutput.
      yield* seedStepRun({
        stepRunId: "step-other",
        pipelineRunId: otherRun,
        ticketId,
        stepKey,
        status: "completed",
        finishedAt: "2020-01-01T00:04:00.000Z",
        output: { from: "other-pass" },
      });

      const output = yield* reader.currentPassOutput(thisRun, stepKey);
      assert.deepEqual(output, { from: "this-pass" });
    }),
  );

  it.effect("currentPassOutput returns null when this pass has no completed step", () =>
    Effect.gen(function* () {
      const reader = yield* StepOutputHandoffReader;
      const output = yield* reader.currentPassOutput(
        PipelineRunId.make("run-missing"),
        StepKey.make("implement"),
      );
      assert.isNull(output);
    }),
  );
});
