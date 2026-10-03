import { MessageId, ThreadId, type OrchestrationQueuedTurn } from "@t3tools/contracts";
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

function render(
  queuedTurns: ReadonlyArray<OrchestrationQueuedTurn>,
  policyBlocks?: ReadonlyMap<OrchestrationQueuedTurn["id"], string>,
) {
  return renderToStaticMarkup(
    <QueuedMessagesPanel
      queuedTurns={queuedTurns}
      queueHeldAt={null}
      policyBlocks={policyBlocks}
      editingQueuedTurnId={null}
      editingText=""
      onStartEditingQueuedTurn={() => {}}
      onCancelEditingQueuedTurn={() => {}}
      onSaveEditingQueuedTurn={() => {}}
      onDeleteQueuedTurn={() => {}}
      onMoveQueuedTurn={() => {}}
      onReleaseQueue={() => {}}
    />,
  );
}

function renderEditing(queuedTurn: OrchestrationQueuedTurn) {
  return renderToStaticMarkup(
    <QueuedMessagesPanel
      queuedTurns={[queuedTurn]}
      queueHeldAt={null}
      editingQueuedTurnId={queuedTurn.id}
      editingText={queuedTurn.message.text}
      onStartEditingQueuedTurn={() => {}}
      onCancelEditingQueuedTurn={() => {}}
      onSaveEditingQueuedTurn={() => {}}
      onDeleteQueuedTurn={() => {}}
      onMoveQueuedTurn={() => {}}
      onReleaseQueue={() => {}}
    />,
  );
}

describe("QueuedMessagesPanel", () => {
  it("leaves child updates to the dedicated follow-up surface", () => {
    const html = renderToStaticMarkup(
      <QueuedMessagesPanel
        queuedTurns={[
          queuedTurn("nudge", "Generated prompt", {
            kind: "child-nudge",
            updates: [
              {
                id: "update",
                childThreadId: ThreadId.make("child"),
                childTitle: "Migration helper",
                assignmentId: MessageId.make("assignment"),
                kind: "decision-needed",
                summary: "Choose a path",
              },
            ],
          }),
        ]}
        queueHeldAt={null}
        editingQueuedTurnId={null}
        editingText=""
        onStartEditingQueuedTurn={() => {}}
        onCancelEditingQueuedTurn={() => {}}
        onSaveEditingQueuedTurn={() => {}}
        onDeleteQueuedTurn={() => {}}
        onMoveQueuedTurn={() => {}}
        onReleaseQueue={() => {}}
      />,
    );
    expect(html).toBe("");
    expect(html).not.toContain("Edit queued message");
    expect(html).not.toContain("Up next");
    expect(html).not.toContain("Generated prompt");
  });

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

  it("shows edit actions without rendering a separate text box", () => {
    const html = renderEditing(queuedTurn("q-1", "Run the tests"));

    expect(html).toContain("Editing queued message");
    expect(html).toContain("Save");
    expect(html).not.toContain("<textarea");
  });

  it("keeps the full paused-feedback explanation readable", () => {
    const html = render([
      {
        ...queuedTurn("q-1", "PR feedback", undefined, "2026-01-01T00:00:05Z"),
        failureMessage:
          "Automatic PR feedback is paused. Review the session before enabling automatic delivery.",
      },
    ]);
    expect(html).toContain("Review the session before enabling automatic delivery.");
    expect(html).toContain("whitespace-pre-wrap break-words");
  });

  it("shows policy-blocked feedback as pending while explicit work is up next", () => {
    const feedback = queuedTurn("feedback", "PR feedback", {
      kind: "pull-request-monitor",
      repository: "acme/app",
      number: 42,
    });
    const html = render(
      [feedback, queuedTurn("explicit", "My next message")],
      new Map([[feedback.id, "Enable automatic PR feedback in Settings to resume."]]),
    );
    expect(html).toContain("Pending");
    expect(html).toContain("Up next");
    expect(html).toContain("Settings to resume.");
    expect(html).not.toContain("Paused");
    expect(html).not.toContain("bg-destructive/5");
  });
});
