import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSendPresentation } from "./composerSendPresentation";

const idle = {
  editingQueuedMessage: false,
  running: false,
  canSteer: false,
  followUpBehavior: "queue",
  deliveryDeferred: false,
} as const;

describe("resolveComposerSendPresentation", () => {
  it("sends plainly while the thread is idle", () => {
    const presentation = resolveComposerSendPresentation(idle);

    expect(presentation.label).toBe("Send");
    expect(presentation.icon).toBe("arrow.up");
    expect(presentation.offersFollowUpChoice).toBe(false);
    expect(presentation.action).toBeNull();
  });

  it("says Queue while the outbox is holding the message back", () => {
    expect(resolveComposerSendPresentation({ ...idle, deliveryDeferred: true }).label).toBe(
      "Queue",
    );
  });

  it("follows the configured behavior once a turn is running", () => {
    const queueing = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: true,
      followUpBehavior: "queue",
    });
    const steering = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: true,
      followUpBehavior: "steer",
    });

    expect(queueing.label).toBe("Queue");
    expect(queueing.icon).toBe("list.number");
    expect(queueing.action).toBe("queue");
    expect(queueing.alternate).toBe("steer");
    expect(steering.label).toBe("Steer");
    expect(steering.icon).toBe("arrow.turn.left.up");
    expect(steering.action).toBe("steer");
    expect(steering.alternate).toBe("queue");
    expect(steering.offersFollowUpChoice).toBe(true);
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

  it("keeps the save affordance while a queued message is being edited", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      editingQueuedMessage: true,
      running: true,
      canSteer: true,
      followUpBehavior: "steer",
    });

    expect(presentation.label).toBe("Update queued message");
    expect(presentation.icon).toBe("checkmark");
    expect(presentation.offersFollowUpChoice).toBe(false);
  });
});
