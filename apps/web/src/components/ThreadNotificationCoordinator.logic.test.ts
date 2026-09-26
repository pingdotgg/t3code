import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadNotification,
  type ThreadNotificationMarker,
} from "./ThreadNotificationCoordinator.logic";

const idle: ThreadNotificationMarker = {
  attention: null,
  completion: null,
  background: false,
  deferredCompletion: null,
};

const waitingTurn = 1_700_000_000_000;
const followUp = waitingTurn + 60_000;

function step(
  prior: ThreadNotificationMarker | null,
  patch: Partial<Parameters<typeof resolveThreadNotification>[0]> &
    Pick<Parameters<typeof resolveThreadNotification>[0], "status">,
) {
  return resolveThreadNotification({
    attentionKey: `turn:${patch.status}`,
    settledCompletion: null,
    background: false,
    sessionLive: false,
    prior,
    deferralDue: false,
    ...patch,
  });
}

describe("resolveThreadNotification", () => {
  it("alerts a normal completion immediately", () => {
    const first = step(null, { status: "working" });
    const done = step(first.marker, {
      status: "ready",
      settledCompletion: waitingTurn,
    });
    expect(done.kind).toBe("completion");
    expect(done.armDeferral).toBe(false);
    expect(done.marker.completion).toBe(waitingTurn);
  });

  it("does not alert while background work is live", () => {
    const running = step(null, { status: "working", background: true });
    const settled = step(running.marker, {
      status: "working",
      background: true,
      settledCompletion: waitingTurn,
    });
    expect(settled.kind).toBeNull();
    expect(settled.marker.completion).toBeNull();
    expect(settled.marker.background).toBe(true);
  });

  it("defers the completion when background liveness drops and drops it if the run resumes", () => {
    const background = step(null, { status: "working", background: true });
    const gap = step(background.marker, {
      status: "ready",
      settledCompletion: waitingTurn,
    });
    expect(gap.kind).toBeNull();
    expect(gap.armDeferral).toBe(true);
    expect(gap.marker.completion).toBeNull();
    expect(gap.marker.deferredCompletion).toBe(waitingTurn);

    const held = step(gap.marker, {
      status: "ready",
      settledCompletion: waitingTurn,
    });
    expect(held.kind).toBeNull();
    expect(held.armDeferral).toBe(false);
    expect(held.marker.deferredCompletion).toBe(waitingTurn);

    const resumed = step(held.marker, {
      status: "working",
      sessionLive: true,
    });
    expect(resumed.kind).toBeNull();
    expect(resumed.clearDeferral).toBe(true);
    expect(resumed.marker.deferredCompletion).toBeNull();
    expect(resumed.marker.completion).toBeNull();

    const followUpDone = step(resumed.marker, {
      status: "ready",
      settledCompletion: followUp,
    });
    expect(followUpDone.kind).toBe("completion");
    expect(followUpDone.armDeferral).toBe(false);
    expect(followUpDone.marker.completion).toBe(followUp);
  });

  it("alerts once when background work ends and the run stays ready", () => {
    const background = step(null, { status: "monitoring", background: true });
    const gap = step(background.marker, {
      status: "ready",
      settledCompletion: waitingTurn,
    });
    expect(gap.kind).toBeNull();
    const due = step(gap.marker, {
      status: "ready",
      settledCompletion: waitingTurn,
      deferralDue: true,
    });
    expect(due.kind).toBe("completion");
    expect(due.clearDeferral).toBe(true);
    expect(due.marker.completion).toBe(waitingTurn);
    expect(due.marker.deferredCompletion).toBeNull();

    const again = step(due.marker, {
      status: "ready",
      settledCompletion: waitingTurn,
    });
    expect(again.kind).toBeNull();
  });

  it("still alerts approvals immediately while a completion is deferred", () => {
    const background = step(null, { status: "working", background: true });
    const gap = step(background.marker, {
      status: "ready",
      settledCompletion: waitingTurn,
    });
    const approval = step(gap.marker, {
      status: "approval",
      attentionKey: "turn:approval",
    });
    expect(approval.kind).toBe("input");
    expect(approval.clearDeferral).toBe(true);
  });

  it("does not replay a completion that was already stored", () => {
    const stored = step(
      { ...idle, completion: waitingTurn },
      { status: "ready", settledCompletion: waitingTurn },
    );
    expect(stored.kind).toBeNull();
  });
});
