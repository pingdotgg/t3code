import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-history-import");
const THREAD_ID = ThreadId.make("thread-history-import");

const seedReadModel = projectEvent(createEmptyReadModel(NOW), {
  sequence: 1,
  eventId: EventId.make("evt-project-history-import"),
  aggregateKind: "project",
  aggregateId: PROJECT_ID,
  type: "project.created",
  occurredAt: NOW,
  commandId: CommandId.make("cmd-project-history-import"),
  causationEventId: null,
  correlationId: CommandId.make("cmd-project-history-import"),
  metadata: {},
  payload: {
    projectId: PROJECT_ID,
    title: "History Import",
    workspaceRoot: "/tmp/history-import",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  },
});

it.layer(NodeServices.layer)("history import decider", (it) => {
  it.effect("creates a non-running thread and projects its text snapshot in order", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const command = {
        type: "thread.history.import",
        commandId: CommandId.make("cmd-history-import"),
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Codex conversation",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: NOW,
        messages: [
          {
            messageId: MessageId.make("message-history-user"),
            role: "user",
            text: "Please inspect this project.",
            turnId: null,
            createdAt: "2026-01-01T00:01:00.000Z",
          },
          {
            messageId: MessageId.make("message-history-assistant"),
            role: "assistant",
            text: "I found the relevant files.",
            turnId: null,
            createdAt: "2026-01-01T00:02:00.000Z",
          },
        ],
      } satisfies OrchestrationCommand;

      const result = yield* decideOrchestrationCommand({ command, readModel });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
      ]);
      const created = events[0];
      expect(created?.type).toBe("thread.created");
      if (created?.type === "thread.created") {
        expect(created.payload.branch).toBeNull();
        expect(created.payload.worktreePath).toBeNull();
      }
      const messages = events.filter(
        (event): event is Extract<OrchestrationEvent, { type: "thread.message-sent" }> =>
          event.type === "thread.message-sent",
      );
      expect(messages.map((event) => event.payload.text)).toEqual([
        "Please inspect this project.",
        "I found the relevant files.",
      ]);
      expect(messages.every((event) => event.payload.streaming === false)).toBe(true);

      let projected = readModel;
      for (const [index, event] of events.entries()) {
        projected = yield* projectEvent(projected, { ...event, sequence: index + 2 });
      }
      const thread = projected.threads.find((entry) => entry.id === THREAD_ID);
      expect(thread?.session).toBeNull();
      expect(thread?.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Please inspect this project."],
        ["assistant", "I found the relevant files."],
      ]);
    }),
  );
});
