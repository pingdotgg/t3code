import {
  LaneEntryToken,
  MessageId,
  PipelineRunId,
  ScriptRunId,
  StepRunId,
  TicketId,
  WorkflowEventId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { WorkflowIds, type WorkflowIdsShape } from "../Services/WorkflowIds.ts";

export const DeterministicWorkflowIds = Layer.effect(
  WorkflowIds,
  Effect.gen(function* () {
    const counters = yield* Ref.make<Record<string, number>>({});
    const next = (prefix: string) =>
      Ref.modify(counters, (counters) => {
        const value = (counters[prefix] ?? 0) + 1;
        return [`${prefix}-${value}`, { ...counters, [prefix]: value }] as const;
      });

    return {
      ticketId: () => next("ticket").pipe(Effect.map(TicketId.make)),
      pipelineRunId: () => next("pipelinerun").pipe(Effect.map(PipelineRunId.make)),
      scriptRunId: () => next("scriptrun").pipe(Effect.map(ScriptRunId.make)),
      stepRunId: () => next("steprun").pipe(Effect.map(StepRunId.make)),
      messageId: () => next("message").pipe(Effect.map(MessageId.make)),
      eventId: () => next("evt").pipe(Effect.map(WorkflowEventId.make)),
      token: () => next("token").pipe(Effect.map(LaneEntryToken.make)),
      mappingId: () => next("mapping"),
    } satisfies WorkflowIdsShape;
  }),
);

export const WorkflowIdsLive = Layer.effect(
  WorkflowIds,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const next = (prefix: string) =>
      crypto.randomUUIDv4.pipe(
        Effect.orDie,
        Effect.map((uuid) => `${prefix}-${uuid}`),
      );

    return {
      ticketId: () => next("ticket").pipe(Effect.map(TicketId.make)),
      pipelineRunId: () => next("pipelinerun").pipe(Effect.map(PipelineRunId.make)),
      scriptRunId: () => next("scriptrun").pipe(Effect.map(ScriptRunId.make)),
      stepRunId: () => next("steprun").pipe(Effect.map(StepRunId.make)),
      messageId: () => next("message").pipe(Effect.map(MessageId.make)),
      eventId: () => next("evt").pipe(Effect.map(WorkflowEventId.make)),
      token: () => next("token").pipe(Effect.map(LaneEntryToken.make)),
      mappingId: () => next("mapping"),
    } satisfies WorkflowIdsShape;
  }),
);
