import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const THREAD = ThreadId.make("thread-import");
const PROJECT = ProjectId.make("project-import");
const SESSION = "019f830c-68b1-7860-a771-aed585bb9579";
const NOW = "2026-01-01T00:00:00.000Z";

const seedReadModel = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(NOW), {
    sequence: 1,
    eventId: EventId.make("evt-project"),
    aggregateKind: "project",
    aggregateId: PROJECT,
    type: "project.created",
    occurredAt: NOW,
    commandId: CommandId.make("cmd-project"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project"),
    metadata: {},
    payload: {
      projectId: PROJECT,
      title: "Import",
      workspaceRoot: "/tmp/project-import",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("evt-thread"),
    aggregateKind: "thread",
    aggregateId: THREAD,
    type: "thread.created",
    occurredAt: NOW,
    commandId: CommandId.make("cmd-thread"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-thread"),
    metadata: {},
    payload: {
      threadId: THREAD,
      projectId: PROJECT,
      title: "Import",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
});

const importCommand = (
  commandId: string,
  sourceSessionId = SESSION,
): Extract<OrchestrationCommand, { type: "thread.history.import" }> => ({
  type: "thread.history.import",
  commandId: CommandId.make(commandId),
  threadId: THREAD,
  sourceSessionId,
  turns: [
    { role: "user", text: "Fix the login bug", createdAt: "2026-01-01T01:00:00.000Z" },
    { role: "assistant", text: "Fixed it", createdAt: "2026-01-01T01:00:05.000Z" },
  ],
  omittedTurnCount: 7,
  createdAt: NOW,
});

/** A read model whose thread already holds imported history from `sessionId`. */
const seedWithPriorImport = (sessionId: string) =>
  Effect.gen(function* () {
    let model = yield* seedReadModel;
    model = yield* projectEvent(model, {
      sequence: 100,
      eventId: EventId.make(`evt-prior-import-${sessionId}`),
      aggregateKind: "thread",
      aggregateId: THREAD,
      type: "thread.message-sent",
      occurredAt: NOW,
      commandId: CommandId.make("cmd-prior-import"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-prior-import"),
      metadata: {},
      payload: {
        threadId: THREAD,
        messageId: MessageId.make(`import:${sessionId}:000000`),
        role: "user",
        text: "the earlier conversation",
        turnId: TurnId.make(`import:${sessionId}`),
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    return model;
  });

it.layer(NodeServices.layer)("thread.history.import", (it) => {
  it.effect("replays each turn as a message in order", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: importCommand("cmd-import"),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events).toHaveLength(2);
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.message-sent",
      ]);
      const payloads = events.map((event) => event.payload as Record<string, unknown>);
      expect(payloads.map((payload) => payload["role"])).toEqual(["user", "assistant"]);
      expect(payloads.map((payload) => payload["text"])).toEqual(["Fix the login bug", "Fixed it"]);
      // createdAt is the real transcript time (for display); updatedAt is the
      // resume time, so the recency sort treats the resume as fresh activity
      // instead of dragging the project back to the old conversation's slot.
      expect(payloads[0]?.["createdAt"]).toBe("2026-01-01T01:00:00.000Z");
      expect(payloads.every((payload) => payload["updatedAt"] === NOW)).toBe(true);
      expect(payloads.every((payload) => payload["streaming"] === false)).toBe(true);
    }),
  );

  // The reported bug: a second /resume appended a new conversation under the old
  // one. The import must first clear the prior imported history.
  it.effect("clears prior imported history before replaying a new session", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithPriorImport("older-session");
      const decided = yield* decideOrchestrationCommand({
        command: importCommand("cmd-second", "newer-session"),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events[0]?.type).toBe("thread.imported-history-cleared");
      expect(events.slice(1).map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.message-sent",
      ]);
      // New session's ids, not the old one's.
      const messageIds = events
        .slice(1)
        .map((event) => (event.payload as Record<string, unknown>)["messageId"]);
      expect(messageIds).toEqual(["import:newer-session:000000", "import:newer-session:000001"]);
    }),
  );

  it.effect("does not clear when the thread has no prior imported history", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: importCommand("cmd-first"),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.some((event) => event.type === "thread.imported-history-cleared")).toBe(false);
    }),
  );

  // CheckpointReactor cuts a git baseline for any user message whose turnId is
  // null, so a null here would fire a checkpoint per imported message.
  it.effect("gives every imported message a non-null turn id", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: importCommand("cmd-import-turn"),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const turnIds = events.map((event) => (event.payload as Record<string, unknown>)["turnId"]);

      expect(turnIds.every((turnId) => turnId !== null && turnId !== undefined)).toBe(true);
      // One turn owns the whole import.
      expect(new Set(turnIds).size).toBe(1);
    }),
  );

  // Re-resuming the same session must not duplicate the thread. Ids derive from
  // the source session, and the projector upserts on message id.
  it.effect("derives stable message ids so a second import rewrites the same messages", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const idsFor = (decided: unknown): ReadonlyArray<unknown> =>
        (Array.isArray(decided) ? decided : [decided]).map(
          (event) => (event.payload as Record<string, unknown>)["messageId"],
        );

      const first = idsFor(
        yield* decideOrchestrationCommand({ command: importCommand("cmd-a"), readModel }),
      );
      const second = idsFor(
        yield* decideOrchestrationCommand({ command: importCommand("cmd-b"), readModel }),
      );

      expect(first).toEqual(second);
      expect(first[0]).toBe(`import:${SESSION}:000000`);
      expect(new Set(first).size).toBe(first.length);
    }),
  );

  it.effect("emits nothing for an empty transcript", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: { ...importCommand("cmd-empty"), turns: [], omittedTurnCount: 0 },
        readModel,
      });
      expect(Array.isArray(decided) ? decided : [decided]).toEqual([]);
    }),
  );

  it.effect("rejects importing into a thread that does not exist", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: { ...importCommand("cmd-missing"), threadId: ThreadId.make("nope") },
          readModel,
        }),
      );
      expect(error.message).toContain("nope");
    }),
  );
});
