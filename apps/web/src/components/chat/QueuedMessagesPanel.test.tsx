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

/**
 * The reorder handler permutes the *full* thread queue, so the panel's move
 * bounds must be expressed against that same list. When a healthy workspace
 * handoff is hidden, the rendered list is shorter than the queue the handler
 * reorders, and bounds taken from the rendered list render an enabled button
 * whose click silently does nothing.
 */
/**
 * Whether each move button carries the `disabled` attribute, in render order.
 *
 * The class attribute is stripped first: the button variant ships
 * `disabled:pointer-events-none disabled:opacity-64`, so a naive substring
 * check reports every button as disabled.
 */
function moveButtonStates(html: string, direction: "up" | "down"): boolean[] {
  const label = direction === "up" ? "Move queued message up" : "Move queued message down";
  return [...html.matchAll(/<button[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes(`aria-label="${label}"`))
    .map((tag) => /\sdisabled(?:=""|\s|>)/.test(tag.replace(/\sclass="[^"]*"/, "")));
}

/**
 * Crash recovery holds queues whose only turns are hidden ones — a child nudge,
 * or a healthy workspace-handoff continuation. Those live on dedicated surfaces
 * with no resume control, so this panel is the only place the hold can be
 * released. Returning null when no rows are visible left such a queue stuck.
 */
describe("QueuedMessagesPanel hold banner", () => {
  const healthyHandoffOrigin = {
    kind: "workspace-handoff",
    role: "continuation",
    branch: "feature/handoff",
    worktreePath: "/tmp/handoff",
  } as OrchestrationQueuedTurn["origin"];

  function renderHeld(queuedTurns: ReadonlyArray<OrchestrationQueuedTurn>) {
    return renderToStaticMarkup(
      <QueuedMessagesPanel
        queuedTurns={queuedTurns}
        queueHeldAt="2026-01-01T00:00:05.000Z"
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

  it("offers resume when the only queued turn is a hidden handoff", () => {
    const html = renderHeld([queuedTurn("handoff", "Continue", healthyHandoffOrigin)]);

    expect(html).toContain("Queue held after restart");
    expect(html).toContain("Resume queue");
  });

  it("offers resume when the only queued turn is a child nudge", () => {
    const html = renderHeld([
      queuedTurn("nudge", "Generated prompt", { kind: "child-nudge" } as never),
    ]);

    expect(html).toContain("Queue held after restart");
    expect(html).toContain("Resume queue");
  });

  it("still renders nothing when unheld and every turn is hidden", () => {
    const html = renderToStaticMarkup(
      <QueuedMessagesPanel
        queuedTurns={[queuedTurn("handoff", "Continue", healthyHandoffOrigin)]}
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
  });
});

describe("QueuedMessagesPanel reorder bounds", () => {
  const hiddenHandoffOrigin = {
    kind: "workspace-handoff",
    role: "continuation",
    branch: "feature/handoff",
    worktreePath: "/tmp/handoff",
  } as OrchestrationQueuedTurn["origin"];

  function renderWithHiddenHandoff() {
    return renderToStaticMarkup(
      <QueuedMessagesPanel
        queuedTurns={[
          queuedTurn("first", "First message"),
          // Hidden: a healthy handoff continuation is not a user message.
          queuedTurn("handoff", "Continue", hiddenHandoffOrigin),
          queuedTurn("last", "Last message"),
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
  }

  it("disables move-down on the last turn of the full queue, not the rendered list", () => {
    const html = renderWithHiddenHandoff();

    // The hidden handoff must not appear at all.
    expect(html).not.toContain("Continue");

    // "Last message" is rendered last and is index 2 of a 3-turn queue, so its
    // move-down is the only disabled one. Two rendered rows against a three-turn
    // queue is exactly the case that used to render an enabled no-op button.
    expect(moveButtonStates(html, "down")).toEqual([false, true]);
  });

  it("disables move-up only on the first turn of the full queue", () => {
    const html = renderWithHiddenHandoff();

    expect(moveButtonStates(html, "up")).toEqual([true, false]);
  });
});

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
