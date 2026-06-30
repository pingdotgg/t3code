import { CheckpointRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CheckpointStore } from "../../checkpointing/CheckpointStore.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  TicketCheckpointService,
  type TicketCheckpointServiceShape,
} from "../Services/TicketCheckpointService.ts";
import { ticketBaseRef, ticketStepRef } from "../ticketRefs.ts";

const toCheckpointError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "checkpoint op failed", cause });

const wrap = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(toCheckpointError));

const make = Effect.gen(function* () {
  const checkpoints = yield* CheckpointStore;

  const captureBaseline: TicketCheckpointServiceShape["captureBaseline"] = (ticketId, cwd) =>
    Effect.gen(function* () {
      const ref = ticketBaseRef(ticketId);
      yield* wrap(
        checkpoints.captureCheckpoint({
          cwd,
          checkpointRef: CheckpointRef.make(ref),
        }),
      );
      return ref;
    });

  const hasBaseline: TicketCheckpointServiceShape["hasBaseline"] = (ticketId, cwd) =>
    wrap(
      checkpoints.hasCheckpointRef({
        cwd,
        checkpointRef: CheckpointRef.make(ticketBaseRef(ticketId)),
      }),
    );

  const captureStep: TicketCheckpointServiceShape["captureStep"] = (
    ticketId,
    stepRunId,
    cwd,
    kind,
  ) =>
    Effect.gen(function* () {
      const ref = ticketStepRef(ticketId, stepRunId, kind);
      yield* wrap(
        checkpoints.captureCheckpoint({
          cwd,
          checkpointRef: CheckpointRef.make(ref),
        }),
      );
      return ref;
    });

  return { captureBaseline, hasBaseline, captureStep } satisfies TicketCheckpointServiceShape;
});

export const TicketCheckpointServiceLive = Layer.effect(TicketCheckpointService, make);
