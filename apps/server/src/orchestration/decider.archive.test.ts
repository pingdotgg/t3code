import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const PROJECT_ID = "project-archive";

async function seedThread(
  readModel: OrchestrationReadModel,
  input: { sequence: number; id: string; parentThreadId: string | null },
): Promise<OrchestrationReadModel> {
  const now = new Date().toISOString();
  return Effect.runPromise(
    projectEvent(readModel, {
      sequence: input.sequence,
      eventId: asEventId(`evt-thread-${input.id}`),
      aggregateKind: "thread",
      aggregateId: asThreadId(input.id),
      type: "thread.created",
      occurredAt: now,
      commandId: asCommandId(`cmd-thread-${input.id}`),
      causationEventId: null,
      correlationId: asCommandId(`cmd-thread-${input.id}`),
      metadata: {},
      payload: {
        threadId: asThreadId(input.id),
        projectId: asProjectId(PROJECT_ID),
        parentThreadId: input.parentThreadId ? asThreadId(input.parentThreadId) : null,
        title: `Thread ${input.id}`,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        pendingRuntimeMode: null,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function seedReadModel(): Promise<OrchestrationReadModel> {
  const now = new Date().toISOString();
  let readModel = createEmptyReadModel(now);
  readModel = await Effect.runPromise(
    projectEvent(readModel, {
      sequence: 1,
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: asProjectId(PROJECT_ID),
      type: "project.created",
      occurredAt: now,
      commandId: asCommandId("cmd-project-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: asProjectId(PROJECT_ID),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  // parent -> child -> grandchild, plus an unrelated root thread.
  readModel = await seedThread(readModel, { sequence: 2, id: "parent", parentThreadId: null });
  readModel = await seedThread(readModel, {
    sequence: 3,
    id: "child",
    parentThreadId: "parent",
  });
  readModel = await seedThread(readModel, {
    sequence: 4,
    id: "grandchild",
    parentThreadId: "child",
  });
  readModel = await seedThread(readModel, {
    sequence: 5,
    id: "unrelated",
    parentThreadId: null,
  });
  return readModel;
}

describe("decider archive cascade", () => {
  it("archives the target thread and every descendant, parents first", async () => {
    const readModel = await seedReadModel();

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-parent"),
          threadId: asThreadId("parent"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    expect(events.map((event) => event.type)).toEqual([
      "thread.archived",
      "thread.archived",
      "thread.archived",
    ]);
    expect(events.map((event) => event.payload.threadId)).toEqual([
      asThreadId("parent"),
      asThreadId("child"),
      asThreadId("grandchild"),
    ]);
  });

  it("does not archive unrelated threads", async () => {
    const readModel = await seedReadModel();

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-parent"),
          threadId: asThreadId("parent"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    expect(events.map((event) => event.payload.threadId)).not.toContain(asThreadId("unrelated"));
  });

  it("reaches active descendants through an already archived child", async () => {
    const now = new Date().toISOString();
    const readModel = await Effect.runPromise(
      projectEvent(await seedReadModel(), {
        sequence: 6,
        eventId: asEventId("evt-archive-child"),
        aggregateKind: "thread",
        aggregateId: asThreadId("child"),
        type: "thread.archived",
        occurredAt: now,
        commandId: asCommandId("cmd-archive-child"),
        causationEventId: null,
        correlationId: asCommandId("cmd-archive-child"),
        metadata: {},
        payload: {
          threadId: asThreadId("child"),
          archivedAt: now,
          updatedAt: now,
        },
      }),
    );

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-parent"),
          threadId: asThreadId("parent"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    expect(events.map((event) => event.payload.threadId)).toEqual([
      asThreadId("parent"),
      asThreadId("grandchild"),
    ]);
  });

  it("archives only the leaf when a child chat is archived directly", async () => {
    const readModel = await seedReadModel();

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-grandchild"),
          threadId: asThreadId("grandchild"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    expect(events.map((event) => event.payload.threadId)).toEqual([asThreadId("grandchild")]);
  });
});
