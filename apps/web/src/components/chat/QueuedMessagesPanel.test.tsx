import type { OrchestrationQueuedTurn } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueuedMessagesPanel } from "./QueuedMessagesPanel";

function queuedTurn(
  id: string,
  text: string,
  origin?: OrchestrationQueuedTurn["origin"],
  failedAt: string | null = null,
): OrchestrationQueuedTurn {
  return {
    id: id as never,
    threadId: "thread-1" as never,
    message: {
      messageId: `${id}-message` as never,
      role: "user",
      text,
      attachments: [],
    },
    origin,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    failedAt,
    failureMessage: null,
  };
}

const handoffOrigin = {
  kind: "workspace-handoff",
  role: "continuation",
  branch: "feature/handoff",
  worktreePath: "/tmp/handoff",
} as OrchestrationQueuedTurn["origin"];

function render(queuedTurns: ReadonlyArray<OrchestrationQueuedTurn>) {
  return renderToStaticMarkup(
    <QueuedMessagesPanel
      queuedTurns={queuedTurns}
      onUpdateQueuedTurn={() => {}}
      onDeleteQueuedTurn={() => {}}
    />,
  );
}

describe("QueuedMessagesPanel", () => {
  it("hides a healthy workspace handoff continuation", () => {
    const html = render([queuedTurn("q-1", "Continue the task", handoffOrigin)]);

    expect(html).toBe("");
  });

  it("labels the first visible turn by its real queue position", () => {
    // The hidden continuation is always dispatched first, so the user's own
    // queued message is not actually "Up next".
    const html = render([
      queuedTurn("q-1", "Continue the task", handoffOrigin),
      queuedTurn("q-2", "Then run the tests"),
    ]);

    expect(html).toContain("Then run the tests");
    expect(html).not.toContain("Up next");
    expect(html).toContain("Queued 2");
  });

  it("keeps a failed handoff continuation visible and actionable", () => {
    const html = render([
      queuedTurn("q-1", "Continue the task", handoffOrigin, "2026-01-01T00:00:05Z"),
    ]);

    expect(html).toContain("Continue in feature/handoff");
    expect(html).toContain("Paused");
    expect(html).toContain("Delete queued message");
  });
});
