import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

describe("decider project scripts", () => {
  it("emits empty scripts on project.create", async () => {
    const now = new Date().toISOString();
    const readModel = createEmptyReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: "cmd-project-create-scripts",
          projectId: "project-scripts",
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.created");
    expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
  });

  it("propagates scripts in project.meta.update payload", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const readModel = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: "evt-project-create-scripts",
        aggregateType: "project",
        aggregateId: "project-scripts",
        type: "project.created",
        occurredAt: now,
        commandId: "cmd-project-create-scripts",
        causationEventId: null,
        correlationId: "cmd-project-create-scripts",
        metadata: {},
        payload: {
          projectId: "project-scripts",
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const scripts = [
      {
        id: "lint",
        name: "Lint",
        command: "bun run lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      },
    ] as const;

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: "cmd-project-update-scripts",
          projectId: "project-scripts",
          scripts: Array.from(scripts),
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
    expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);
  });

  it("emits user message and turn-start-requested events for thread.turn.start", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: "evt-project-create",
        aggregateType: "project",
        aggregateId: "project-1",
        type: "project.created",
        occurredAt: now,
        commandId: "cmd-project-create",
        causationEventId: null,
        correlationId: "cmd-project-create",
        metadata: {},
        payload: {
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: "evt-thread-create",
        aggregateType: "thread",
        aggregateId: "thread-1",
        type: "thread.created",
        occurredAt: now,
        commandId: "cmd-thread-create",
        causationEventId: null,
        correlationId: "cmd-thread-create",
        metadata: {},
        payload: {
          threadId: "thread-1",
          projectId: "project-1",
          title: "Thread",
          model: "gpt-5-codex",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: "cmd-turn-start",
          threadId: "thread-1",
          message: {
            messageId: "message-user-1",
            role: "user",
            text: "hello",
            attachments: [],
          },
          model: "gpt-5",
          effort: "high",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.message-sent");
    expect(events[1]?.type).toBe("thread.turn-start-requested");
    expect(events[1]?.causationEventId).toBe(events[0]?.eventId ?? null);
  });
});
