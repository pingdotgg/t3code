/**
 * HandoffService — creates the child thread for an agent-driven handoff.
 *
 * The live agent composed the child's name and summary; this service turns
 * them into a first-class thread: create it in the parent's project (carrying
 * the parent's model/permission/interaction mode — never branch or worktree),
 * seed it with the summary as its first user turn, and record lineage as
 * `handoff.created` / `handoff.received` activities on both sides. The parent
 * thread is otherwise left untouched (ADR 0002).
 *
 * @module handoff/HandoffService
 */
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  HANDOFF_CREATED_ACTIVITY_KIND,
  HANDOFF_RECEIVED_ACTIVITY_KIND,
  type HandoffRequest,
} from "./protocol.ts";

export class HandoffParentNotFoundError extends Schema.TaggedErrorClass<HandoffParentNotFoundError>()(
  "HandoffParentNotFoundError",
  {
    parentThreadId: ThreadId,
  },
) {}

export class HandoffDispatchError extends Schema.TaggedErrorClass<HandoffDispatchError>()(
  "HandoffDispatchError",
  {
    parentThreadId: ThreadId,
    stage: Schema.Literals(["create", "turn-start", "lineage"]),
    cause: Schema.Defect(),
  },
) {}

export interface HandoffResult {
  readonly threadId: ThreadId;
  readonly title: string;
}

const isHandoffableParent = (thread: OrchestrationThreadShell): boolean =>
  thread.archivedAt === null;

/**
 * Create, seed, and start the handed-off child thread.
 *
 * The child is created and its seed turn started as one logical operation:
 * if the turn start fails the freshly created thread is deleted again
 * (mirroring the ws bootstrap compensation), so a failed handoff never
 * leaves an empty husk in the sidebar. Lineage activities append after the
 * child is running; a failure there fails the request loudly but does not
 * roll the child back.
 */
export const performHandoff = Effect.fn("performHandoff")(function* (input: {
  readonly parentThreadId: ThreadId;
  readonly request: HandoffRequest;
}) {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:handoff-${tag}:${uuid}`)));

  const parent = yield* projectionSnapshotQuery.getThreadShellById(input.parentThreadId).pipe(
    Effect.mapError(
      (cause) =>
        new HandoffDispatchError({
          parentThreadId: input.parentThreadId,
          stage: "create",
          cause,
        }),
    ),
  );
  if (Option.isNone(parent) || !isHandoffableParent(parent.value)) {
    return yield* new HandoffParentNotFoundError({ parentThreadId: input.parentThreadId });
  }
  const parentThread = parent.value;

  const childThreadId = ThreadId.make(yield* randomUUID);
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const dispatchStage = (
    stage: "create" | "turn-start" | "lineage",
    command: OrchestrationCommand,
  ) =>
    orchestrationEngine.dispatch(command).pipe(
      Effect.mapError(
        (cause) =>
          new HandoffDispatchError({
            parentThreadId: input.parentThreadId,
            stage,
            cause,
          }),
      ),
    );

  yield* dispatchStage("create", {
    type: "thread.create",
    commandId: yield* commandId("thread-create"),
    threadId: childThreadId,
    projectId: parentThread.projectId,
    title: input.request.name,
    modelSelection: parentThread.modelSelection,
    runtimeMode: parentThread.runtimeMode,
    interactionMode: parentThread.interactionMode,
    branch: null,
    worktreePath: null,
    createdAt,
  });

  const deleteChildThread = Effect.suspend(() =>
    dispatchStage("create", {
      type: "thread.delete",
      commandId: CommandId.make(`server:handoff-compensate:${childThreadId}`),
      threadId: childThreadId,
    }),
  ).pipe(Effect.ignoreCause({ log: true }));

  // No titleSeed on the seed turn: the model-chosen name IS the title, and
  // canReplaceThreadTitle never overwrites a non-default title without a
  // matching seed — so the auto-titler leaves it alone.
  yield* dispatchStage("turn-start", {
    type: "thread.turn.start",
    commandId: yield* commandId("turn-start"),
    threadId: childThreadId,
    message: {
      messageId: MessageId.make(yield* randomUUID),
      role: "user",
      text: input.request.summary,
      attachments: [],
    },
    modelSelection: parentThread.modelSelection,
    runtimeMode: parentThread.runtimeMode,
    interactionMode: parentThread.interactionMode,
    createdAt,
  }).pipe(Effect.onError(() => deleteChildThread));

  yield* dispatchStage("lineage", {
    type: "thread.activity.append",
    commandId: yield* commandId("created-activity"),
    threadId: input.parentThreadId,
    activity: {
      id: EventId.make(yield* randomUUID),
      tone: "info",
      kind: HANDOFF_CREATED_ACTIVITY_KIND,
      summary: `Handed off to "${input.request.name}"`,
      payload: {
        childThreadId,
        childTitle: input.request.name,
      },
      turnId: null,
      createdAt,
    },
    createdAt,
  });

  yield* dispatchStage("lineage", {
    type: "thread.activity.append",
    commandId: yield* commandId("received-activity"),
    threadId: childThreadId,
    activity: {
      id: EventId.make(yield* randomUUID),
      tone: "info",
      kind: HANDOFF_RECEIVED_ACTIVITY_KIND,
      summary: `Handed off from "${parentThread.title}"`,
      payload: {
        parentThreadId: input.parentThreadId,
        parentTitle: parentThread.title,
      },
      turnId: null,
      createdAt,
    },
    createdAt,
  });

  return {
    threadId: childThreadId,
    title: input.request.name,
  } satisfies HandoffResult;
});
