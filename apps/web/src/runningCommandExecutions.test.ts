import { EventId, type OrchestrationThreadActivity, type TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { deriveRunningCommandExecutions } from "./runningCommandExecutions";
import type { ThreadSession } from "./types";

function asEventId(value: string) {
  return EventId.makeUnsafe(value);
}

function makeActivity(
  input: Partial<OrchestrationThreadActivity> & Pick<OrchestrationThreadActivity, "id" | "createdAt">,
): OrchestrationThreadActivity {
  return {
    tone: "tool",
    kind: "tool.started",
    summary: "Command run started",
    payload: {},
    turnId: "turn-1" as TurnId,
    ...input,
  };
}

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    provider: "codex",
    status: "running",
    orchestrationStatus: "running",
    activeTurnId: "turn-1" as TurnId,
    createdAt: "2026-03-07T10:00:00.000Z",
    updatedAt: "2026-03-07T10:00:00.000Z",
    ...overrides,
  };
}

describe("deriveRunningCommandExecutions", () => {
  it("returns running command executions for the active turn", () => {
    const commands = deriveRunningCommandExecutions(
      [
        makeActivity({
          id: asEventId("activity-1"),
          createdAt: "2026-03-07T10:00:01.000Z",
          payload: {
            runtimeItemId: "item-1",
            itemType: "command_execution",
            command: "bun run dev",
            detail: "bun run dev",
          },
        }),
      ],
      makeSession(),
    );

    expect(commands).toEqual([
      {
        itemId: "item-1",
        turnId: "turn-1",
        command: "bun run dev",
        detail: "bun run dev",
        startedAt: "2026-03-07T10:00:01.000Z",
        updatedAt: "2026-03-07T10:00:01.000Z",
      },
    ]);
  });

  it("collapses updates for the same runtime item", () => {
    const commands = deriveRunningCommandExecutions(
      [
        makeActivity({
          id: asEventId("activity-1"),
          createdAt: "2026-03-07T10:00:01.000Z",
          payload: {
            runtimeItemId: "item-1",
            itemType: "command_execution",
            command: "bun run dev",
          },
        }),
        makeActivity({
          id: asEventId("activity-2"),
          createdAt: "2026-03-07T10:00:05.000Z",
          kind: "tool.updated",
          payload: {
            runtimeItemId: "item-1",
            itemType: "command_execution",
            command: "bun run dev",
            detail: "watching for changes",
          },
        }),
      ],
      makeSession(),
    );

    expect(commands).toEqual([
      {
        itemId: "item-1",
        turnId: "turn-1",
        command: "bun run dev",
        detail: "watching for changes",
        startedAt: "2026-03-07T10:00:01.000Z",
        updatedAt: "2026-03-07T10:00:05.000Z",
      },
    ]);
  });

  it("removes completed command executions", () => {
    const commands = deriveRunningCommandExecutions(
      [
        makeActivity({
          id: asEventId("activity-1"),
          createdAt: "2026-03-07T10:00:01.000Z",
          payload: {
            runtimeItemId: "item-1",
            itemType: "command_execution",
            command: "bun run dev",
          },
        }),
        makeActivity({
          id: asEventId("activity-2"),
          createdAt: "2026-03-07T10:00:04.000Z",
          kind: "tool.completed",
          summary: "Command run complete",
          payload: {
            runtimeItemId: "item-1",
            itemType: "command_execution",
            command: "bun run dev",
          },
        }),
      ],
      makeSession(),
    );

    expect(commands).toEqual([]);
  });

  it("ignores non-command tool activity", () => {
    const commands = deriveRunningCommandExecutions(
      [
        makeActivity({
          id: asEventId("activity-1"),
          createdAt: "2026-03-07T10:00:01.000Z",
          payload: {
            runtimeItemId: "item-1",
            itemType: "file_change",
            detail: "apps/web/src/ChatView.tsx",
          },
        }),
      ],
      makeSession(),
    );

    expect(commands).toEqual([]);
  });

  it("clears stale entries when the thread is no longer running the turn", () => {
    const commands = deriveRunningCommandExecutions(
      [
        makeActivity({
          id: asEventId("activity-1"),
          createdAt: "2026-03-07T10:00:01.000Z",
          payload: {
            runtimeItemId: "item-1",
            itemType: "command_execution",
            command: "bun run dev",
          },
        }),
      ],
      makeSession({ orchestrationStatus: "ready" }),
    );

    expect(commands).toEqual([]);
  });
});
