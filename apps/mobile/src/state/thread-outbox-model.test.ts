import { describe, expect, it } from "vitest";
import { MessageId } from "@t3tools/contracts";

import { isThreadOutboxThreadBusy } from "./thread-outbox-model";

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

  it("keeps the pre-existing running and starting signals", () => {
    expect(isThreadOutboxThreadBusy({ session: { status: "running" } })).toBe(true);
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
