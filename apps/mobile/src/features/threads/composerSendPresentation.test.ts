import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSendPresentation } from "./composerSendPresentation";

const idle = {
  editingQueuedMessage: false,
  isDraft: false,
  replyingToApproval: false,
  running: false,
  canSteer: false,
  localCommand: null,
  followUpBehavior: "queue",
  deliveryDeferred: false,
} as const;

describe("resolveComposerSendPresentation", () => {
  it("shows the outbox action when delivery is deferred", () => {
    const presentation = resolveComposerSendPresentation({ ...idle, deliveryDeferred: true });
    expect(presentation.label).toBe("Queue");
    expect(presentation.icon).toBe("tray.and.arrow.up");
    expect(resolveComposerSendPresentation(idle).icon).toBe("arrow.up");
  });

  it.each([
    ["side-chat", "Start side chat"],
    ["clear", "Start fresh session"],
    ["feedback", "Submit feedback"],
    ["usage-limits", "Show usage limits"],
  ] as const)(
    "runs a %s command without queueing or steering the running turn",
    (localCommand, label) => {
      const presentation = resolveComposerSendPresentation({
        ...idle,
        running: true,
        canSteer: true,
        localCommand,
        followUpBehavior: "queue",
      });

      expect(presentation.label).toBe(label);
      expect(presentation.icon).toBe("arrow.up");
      expect(presentation.action).toBeNull();
      expect(presentation.alternate).toBeNull();
      expect(presentation.offersFollowUpChoice).toBe(false);
    },
  );

  it("prioritizes editing a queued message over a local command", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      editingQueuedMessage: true,
      running: true,
      localCommand: "side-chat",
    });
    expect(presentation.label).toBe("Update queued message");
    expect(presentation.icon).toBe("checkmark");
  });

  it.each([
    [{ isDraft: true, localCommand: "feedback" }, "Send"],
    [{ isDraft: true, localCommand: "side-chat" }, "Send"],
    [
      { replyingToApproval: true, running: true, canSteer: true, localCommand: "side-chat" },
      "Queue",
    ],
  ] as const)("does not present a local command when it will be sent as text", (input, label) => {
    expect(resolveComposerSendPresentation({ ...idle, ...input }).label).toBe(label);
  });

  it("never promises steering the provider cannot do", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: false,
      followUpBehavior: "steer",
    });

    expect(presentation.label).toBe("Queue");
    expect(presentation.action).toBe("queue");
    expect(presentation.alternate).toBeNull();
    expect(presentation.offersFollowUpChoice).toBe(false);
  });
});
