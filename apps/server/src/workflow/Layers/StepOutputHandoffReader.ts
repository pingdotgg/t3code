import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  StepOutputHandoffReader,
  type StepOutputHandoffReaderShape,
} from "../Services/StepOutputHandoffReader.ts";

const decodeOutputJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const toReaderError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrap = <A>(message: string, effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toReaderError(message)));

const parseOutput = (outputJson: string | null) =>
  outputJson === null
    ? Effect.succeed(null)
    : decodeOutputJson(outputJson).pipe(
        Effect.mapError(toReaderError("handoff output decode failed")),
      );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const latestCompletedOutput: StepOutputHandoffReaderShape["latestCompletedOutput"] = (
    ticketId,
    laneKey,
    stepKey,
  ) =>
    Effect.gen(function* () {
      const rows = yield* wrap(
        "StepOutputHandoffReader.latestCompletedOutput",
        sql<{ readonly outputJson: string | null }>`
          SELECT sr.output_json AS "outputJson"
          FROM projection_step_run AS sr
          JOIN projection_pipeline_run AS pr
            ON pr.pipeline_run_id = sr.pipeline_run_id
          WHERE sr.ticket_id = ${String(ticketId)}
            AND pr.lane_key = ${String(laneKey)}
            AND sr.step_key = ${String(stepKey)}
            AND sr.status = 'completed'
          ORDER BY sr.finished_at DESC
          LIMIT 1
        `,
      );
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return yield* parseOutput(row.outputJson);
    });

  const currentPassOutput: StepOutputHandoffReaderShape["currentPassOutput"] = (
    pipelineRunId,
    stepKey,
  ) =>
    Effect.gen(function* () {
      const rows = yield* wrap(
        "StepOutputHandoffReader.currentPassOutput",
        sql<{ readonly outputJson: string | null }>`
          SELECT output_json AS "outputJson"
          FROM projection_step_run
          WHERE pipeline_run_id = ${String(pipelineRunId)}
            AND step_key = ${String(stepKey)}
            AND status = 'completed'
          ORDER BY finished_at DESC
          LIMIT 1
        `,
      );
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return yield* parseOutput(row.outputJson);
    });

  return { latestCompletedOutput, currentPassOutput } satisfies StepOutputHandoffReaderShape;
});

export const StepOutputHandoffReaderLive = Layer.effect(StepOutputHandoffReader, make);
