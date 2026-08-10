import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("import-project");
const threadId = ThreadId.make("imported-thread");

const seedProject = projectEvent(createEmptyReadModel(now), {
  sequence: 1,
  eventId: EventId.make("project-created"),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make("create-project"),
  causationEventId: null,
  correlationId: CommandId.make("create-project"),
  metadata: {},
  payload: {
    projectId,
    title: "Import project",
    workspaceRoot: "/tmp/import-project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});

it.layer(NodeServices.layer)("thread.import decider", (it) => {
  it.effect("materializes one atomic created-plus-transcript event batch", () =>
    Effect.gen(function* () {
      const readModel = yield* seedProject;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.import",
          commandId: CommandId.make("import:deterministic-candidate"),
          threadId,
          projectId,
          title: "Imported transcript",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          messages: [
            {
              id: MessageId.make("imported-message-1"),
              role: "user",
              text: "Please review this",
              createdAt: now,
            },
            {
              id: MessageId.make("imported-message-2"),
              role: "assistant",
              text: "The transcript is ready.",
              createdAt: now,
            },
          ],
          createdAt: now,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
      ]);

      let projected = readModel;
      for (const [index, event] of events.entries()) {
        projected = yield* projectEvent(projected, { ...event, sequence: index + 2 });
      }
      const thread = projected.threads.find((candidate) => candidate.id === threadId);
      expect(thread?.messages.map((message) => message.text)).toEqual([
        "Please review this",
        "The transcript is ready.",
      ]);
    }),
  );
});
