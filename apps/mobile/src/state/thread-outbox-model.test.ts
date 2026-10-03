import { describe, expect, it } from "vitest";
import { MessageId } from "@t3tools/contracts";

import { isThreadOutboxThreadBusy, resolveThreadOutboxDeliveryAction } from "./thread-outbox-model";

const pendingTurnStart = {
  messageId: MessageId.make("message-1"),
  requestedAt: "2026-03-01T10:00:00.000Z",
};

describe("isThreadOutboxThreadBusy", () => {
  it("treats an accepted-but-unacknowledged start as busy", () => {
    // The provider has not reported `running` yet. Without the pending start this
    // looks idle and the outbox sends into the window the server rejects.
    expect(
      isThreadOutboxThreadBusy({
        session: { status: "ready" },
        pendingTurnStart,
      }),
    ).toBe(true);
  });

  it("reports a thread with no start and no session as free", () => {
    expect(isThreadOutboxThreadBusy({})).toBe(false);
    expect(isThreadOutboxThreadBusy({ session: null, pendingTurnStart: null })).toBe(false);
    expect(isThreadOutboxThreadBusy({ session: { status: "ready" } })).toBe(false);
  });

  it("treats a running turn as steerable rather than blocking", () => {
    // The drain steers an active turn instead of starting a new one, so a
    // running turn must still reach the send path.
    expect(
      isThreadOutboxThreadBusy({ session: { status: "running", activeTurnId: "turn-1" } }),
    ).toBe(false);
    // Running with no active turn has nothing to steer.
    expect(isThreadOutboxThreadBusy({ session: { status: "running", activeTurnId: null } })).toBe(
      true,
    );
    expect(isThreadOutboxThreadBusy({ session: { status: "starting" } })).toBe(true);
  });

  it("stops blocking once the start is retired", () => {
    // A terminal status with no active turn means the start ended, so the thread
    // must accept the next queued message.
    expect(
      isThreadOutboxThreadBusy({
        session: { status: "stopped" },
        pendingTurnStart: null,
      }),
    ).toBe(false);
  });

  it("does not require a session at all to see the pending start", () => {
    expect(isThreadOutboxThreadBusy({ pendingTurnStart })).toBe(true);
  });
});

describe("resolveThreadOutboxDeliveryAction", () => {
  const base = {
    isCreation: false,
    threadExists: true,
    shellStatus: "live" as const,
    environmentConnected: true,
  };

  it("waits instead of sending into an unsteerable accepted start", () => {
    // threadBusy used to be accepted and never read, so every connected thread
    // sent and collected an "already has a turn in flight" rejection.
    expect(resolveThreadOutboxDeliveryAction({ ...base, threadBusy: true })).toBe("wait");
    expect(resolveThreadOutboxDeliveryAction({ ...base, threadBusy: false })).toBe("send");
  });

  it("still sends when the environment is not connected", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        ...base,
        environmentConnected: false,
        threadBusy: false,
      }),
    ).toBe("wait");
  });
});
