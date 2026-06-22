import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);

const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T00:00:01.000Z";

// Read model with the fork (target) thread present — fork.seed requires it.
const seedReadModel = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: asEventId("evt-project"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-fork"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-fork"),
      title: "Project Fork",
      workspaceRoot: "/tmp/project-fork",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread"),
    aggregateKind: "thread",
    aggregateId: asThreadId("fork-thread"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread"),
    metadata: {},
    payload: {
      threadId: asThreadId("fork-thread"),
      projectId: asProjectId("project-fork"),
      title: "Fork: Source",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

const forkSeedCommand = (
  threadId: ThreadId,
): Extract<OrchestrationCommand, { type: "thread.fork.seed" }> => ({
  type: "thread.fork.seed",
  commandId: asCommandId("cmd-fork-seed"),
  threadId,
  messages: [
    {
      id: asMessageId("src-msg-user"),
      role: "user",
      text: "Hello",
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: asMessageId("src-msg-assistant"),
      role: "assistant",
      text: "Hi there",
      turnId: null,
      streaming: false,
      createdAt: later,
      updatedAt: later,
    },
  ],
  createdAt: now,
});

it.layer(NodeServices.layer)("decider thread.fork.seed", (it) => {
  it.effect("re-emits a finalized message-sent per copied message", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: forkSeedCommand(asThreadId("fork-thread")),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      // One event per source message, all targeted at the fork thread.
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.type === "thread.message-sent")).toBe(true);
      const payloads = events.map((event) => event.payload as Record<string, unknown>);
      expect(payloads.map((payload) => payload.role)).toEqual(["user", "assistant"]);
      expect(payloads.map((payload) => payload.text)).toEqual(["Hello", "Hi there"]);
      expect(payloads.every((payload) => payload.threadId === asThreadId("fork-thread"))).toBe(
        true,
      );
      // Copied messages are finalized and detached from any source turn.
      expect(payloads.every((payload) => payload.streaming === false)).toBe(true);
      expect(payloads.every((payload) => payload.turnId === null)).toBe(true);
      // Original timestamps preserved so ordering matches the source.
      expect(payloads.map((payload) => payload.createdAt)).toEqual([now, later]);
      // Fresh message ids (not the source ids) to avoid cross-thread collisions.
      const messageIds = payloads.map((payload) => payload.messageId);
      expect(messageIds).not.toContain(asMessageId("src-msg-user"));
      expect(new Set(messageIds).size).toBe(2);
    }),
  );

  it.effect("rejects seeding a thread that does not exist", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: forkSeedCommand(asThreadId("missing-thread")),
          readModel,
        }),
      );
      expect(error.message).toContain("does not exist");
    }),
  );
});
