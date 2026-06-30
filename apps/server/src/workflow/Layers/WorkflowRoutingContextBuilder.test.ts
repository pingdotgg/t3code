import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowProjectionPipeline } from "../Services/WorkflowProjectionPipeline.ts";
import { WorkflowRoutingContextBuilder } from "../Services/WorkflowRoutingContextBuilder.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { WorkflowProjectionPipelineLive } from "./WorkflowProjectionPipeline.ts";
import { WorkflowReadModelLive } from "./WorkflowReadModel.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

const layer = it.layer(
  WorkflowRoutingContextBuilderLive.pipe(
    Layer.provideMerge(WorkflowProjectionPipelineLive),
    Layer.provideMerge(WorkflowReadModelLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowRoutingContextBuilder", (it) => {
  it.effect("builds routing context from the pipeline-scoped read model", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const builder = yield* WorkflowRoutingContextBuilder;
      const base = {
        ticketId: "t-routing-context" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "routing-context-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-1" as never,
          title: "Routing context" as never,
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "PipelineStarted",
        eventId: "routing-context-b" as never,
        streamVersion: 1,
        payload: {
          pipelineRunId: "pr-routing-context" as never,
          laneKey: "implement" as never,
          laneEntryToken: "tok-routing-context" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "routing-context-c" as never,
        streamVersion: 2,
        payload: {
          pipelineRunId: "pr-routing-context" as never,
          stepRunId: "sr-routing-tests" as never,
          stepKey: "tests" as never,
          stepType: "script",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "ScriptStepStarted",
        eventId: "routing-context-d" as never,
        streamVersion: 3,
        payload: {
          scriptRunId: "script-routing-context" as never,
          stepRunId: "sr-routing-tests" as never,
          scriptThreadId: "workflow-script:script-routing-context" as never,
          terminalId: "script-routing-context" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "ScriptStepExited",
        eventId: "routing-context-e" as never,
        streamVersion: 4,
        payload: {
          scriptRunId: "script-routing-context" as never,
          exitCode: 1,
          signal: null,
          outcome: "exited",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepCompleted",
        eventId: "routing-context-f" as never,
        streamVersion: 5,
        payload: { stepRunId: "sr-routing-tests" as never },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "routing-context-g" as never,
        streamVersion: 6,
        payload: {
          pipelineRunId: "pr-routing-context" as never,
          stepRunId: "sr-routing-review" as never,
          stepKey: "review" as never,
          stepType: "agent",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepCompleted",
        eventId: "routing-context-h" as never,
        streamVersion: 7,
        payload: {
          stepRunId: "sr-routing-review" as never,
          output: { verdict: "block" },
        },
      } as never);

      // lane.runCount is computed over the ordered event log; mirror the
      // projected PipelineStarted there.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO workflow_events
          (event_id, ticket_id, stream_version, event_type, occurred_at, payload_json)
        VALUES (
          'routing-context-pipeline-started',
          't-routing-context',
          100,
          'PipelineStarted',
          '2026-06-07T00:00:00.000Z',
          '{"pipelineRunId":"pr-routing-context","laneKey":"implement","laneEntryToken":"tok-routing-context"}'
        )
      `;

      const context = yield* builder.build({
        ticketId: "t-routing-context" as never,
        pipelineRunId: "pr-routing-context" as never,
        result: "failure",
      });

      assert.deepEqual(context, {
        pipeline: { result: "failure" },
        lane: { runCount: 1 },
        status: "running",
        steps: {
          tests: { exitCode: 1, status: "completed", output: null },
          review: { exitCode: null, status: "completed", output: { verdict: "block" } },
        },
      });
    }),
  );
});
