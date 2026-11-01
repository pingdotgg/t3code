import {
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const database = SqlitePersistence.layerMemory;
const eventStore = EventStore.layer.pipe(Layer.provideMerge(database));
const projectionStore = ProjectionStore.layer.pipe(Layer.provideMerge(database));
const stores = Layer.mergeAll(database, eventStore, projectionStore);

export const layerTest = Layer.mergeAll(
  stores,
  OrchestrationEventStore.layer.pipe(Layer.provideMerge(database)),
  EventSink.layer.pipe(Layer.provide(stores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
);

export const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

export function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: "Event history retention",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function createdEvent(thread: OrchestrationV2AppThread, now: DateTime.Utc) {
  return {
    id: EventId.make(`event:${thread.id}:created`),
    type: "thread.created",
    threadId: thread.id,
    providerInstanceId,
    occurredAt: now,
    payload: thread,
  } satisfies OrchestrationV2DomainEvent;
}

export function metadataUpdatedEvent(
  thread: OrchestrationV2AppThread,
  suffix: string,
  title: string,
  now: DateTime.Utc,
) {
  return {
    id: EventId.make(`event:${thread.id}:metadata:${suffix}`),
    type: "thread.metadata-updated",
    threadId: thread.id,
    providerInstanceId,
    occurredAt: now,
    payload: { ...thread, title, updatedAt: now },
  } satisfies OrchestrationV2DomainEvent;
}

export function visitedEvent(thread: OrchestrationV2AppThread, suffix: string, now: DateTime.Utc) {
  return {
    id: EventId.make(`event:${thread.id}:visit:${suffix}`),
    type: "thread.visited",
    threadId: thread.id,
    providerInstanceId,
    occurredAt: now,
    payload: { ...thread, updatedAt: now, lastVisitedAt: now },
  } satisfies OrchestrationV2DomainEvent;
}

export function messageEvent(threadId: ThreadId, suffix: string, now: DateTime.Utc) {
  return {
    id: EventId.make(`event:${threadId}:message:${suffix}`),
    type: "message.updated",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: MessageId.make(`message:${threadId}:${suffix}`),
      threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text: suffix,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  } satisfies OrchestrationV2DomainEvent;
}

export function runningEvent(
  threadId: ThreadId,
  run: OrchestrationV2Run,
  suffix: string,
  now: DateTime.Utc,
) {
  return {
    id: EventId.make(`event:${threadId}:run:${suffix}`),
    type: "run.updated",
    threadId,
    runId: run.id,
    occurredAt: now,
    payload: run,
  } satisfies OrchestrationV2DomainEvent;
}

export function promptEvents(threadId: ThreadId, now: DateTime.Utc, revision: number) {
  const id = NodeId.make(`subagent:${threadId}:retention`);
  const prompt = revision === 0 ? "Prompt A. ".repeat(40) : "Prompt B. ".repeat(40);
  const progress = `Review progress ${revision}`;
  return [
    {
      id: EventId.make(`event:${threadId}:subagent:${revision}`),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: null,
        parentNodeId: NodeId.make(`node:${threadId}:parent`),
        origin: "provider_native",
        createdBy: "agent",
        driver: providerDriver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: { driver: providerDriver, nativeId: "retention-review", strength: "strong" },
        prompt,
        progress,
        title: "Review",
        model: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    },
    {
      id: EventId.make(`event:${threadId}:subagent-item:${revision}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`turn-item:${threadId}:subagent`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: "Review",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId: id,
        origin: "provider_native",
        driver: providerDriver,
        providerInstanceId,
        childThreadId: null,
        prompt,
        progress,
        result: null,
      },
    },
  ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
}
