import { describe, expect, it } from "vite-plus/test";

import { m, type MessageResolver } from "../../i18n/messages";
import { resolveComposerSendPresentation } from "./composerSendPresentation";

const idle = {
  editingQueuedMessage: false,
  running: false,
  canSteer: false,
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

  it("resolves the alternate send label in the user's language", () => {
    const translated = ((message, variables) => `[${m(message, variables)}]`) as MessageResolver;
    const running = { ...idle, running: true, canSteer: true } as const;

    expect(resolveComposerSendPresentation(running, translated).alternateLabel).toBe("[Steer now]");
    expect(
      resolveComposerSendPresentation({ ...running, followUpBehavior: "steer" }, translated)
        .alternateLabel,
    ).toBe("[Queue]");
    expect(resolveComposerSendPresentation(idle, translated).alternateLabel).toBe("[Send]");
  });
});
