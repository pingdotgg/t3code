import { describe, expect, it } from "vite-plus/test";
import { EventId, MessageId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeVoiceSession, type VoiceTransport } from "./VoiceSession.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const threadId = ThreadId.make("voice-thread");
const transcript = {
  type: "session.input_transcript.delta",
  event_id: "transcript-1",
  delta: "Please fix the failing build",
  start_ms: 0,
  end_ms: 100,
};
const delegation = {
  type: "session.delegation.created",
  event_id: "delegation-event",
  offset_ms: 100,
  delegation: { id: "delegation-1", type: "delegation", target: "client" },
};

function assistantMessage(
  sequence: number,
  text: string,
  streaming: boolean,
  target = threadId,
): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: target,
    occurredAt: "2026-09-13T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId: target,
      messageId: MessageId.make("answer-1"),
      role: "assistant",
      text,
      streaming,
      turnId: null,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
    },
  };
}

function harness(overrides: Partial<VoiceTransport> = {}) {
  let receive = (_value: unknown) => {};
  let closed = 0;
  const sent: unknown[] = [];
  const dispatched: Array<{ threadId: ThreadId; id: string; prompt: string }> = [];
  const manager = makeVoiceSession({
    transport: {
      create: async () => ({ sessionId: "live-1", sdp: "answer" }),
      hangup: async () => true,
      connect: async (_sessionId, onEvent) => {
        receive = onEvent;
        return {
          send: (event) => {
            sent.push(event);
            if ((event as { type: string }).type === "session.close") {
              receive({
                type: "session.closed",
                session: { id: "live-1" },
                usage: { seconds: 1 },
                reason: "client_requested",
              });
            }
          },
          close: () => {
            closed++;
          },
        };
      },
      ...overrides,
    },
    context: async () => "Current thread: build fix. Existing permissions apply.",
    dispatch: async (targetThreadId, id, prompt) => {
      dispatched.push({ threadId: targetThreadId, id, prompt });
    },
  });
  return {
    manager,
    sent,
    dispatched,
    receive: (value: unknown) => receive(value),
    get closed() {
      return closed;
    },
  };
}

describe("voice session ownership and delegation", () => {
  it("dispatches a delegation once to the pinned thread with the spoken request", async () => {
    const h = harness();
    await h.manager.start({ threadId, sdp: "offer" });
    h.receive(transcript);
    h.receive(delegation);
    h.receive(delegation);
    await h.manager.drain();
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.prompt).toContain("Please fix the failing build");
    expect(h.dispatched[0]?.threadId).toBe(threadId);
    expect(h.dispatched[0]?.prompt).not.toContain("Current thread: build fix");
    expect(h.sent).toContainEqual(
      expect.objectContaining({ type: "session.thinking.append", delegation_id: "delegation-1" }),
    );
    await h.manager.dispose();
  });

  it("asks the user to repeat when a delegation arrives without user transcript", async () => {
    const h = harness();
    await h.manager.start({ threadId, sdp: "offer" });
    h.receive(delegation);
    await h.manager.drain();
    expect(h.dispatched).toHaveLength(0);
    expect(h.sent).toContainEqual(
      expect.objectContaining({
        type: "session.commentary.append",
        content: expect.stringContaining("repeat"),
      }),
    );
    await h.manager.dispose();
  });

  it("rejects cross-connection session IDs without ending its own call", async () => {
    const h = harness();
    await h.manager.start({ threadId, sdp: "offer" });
    await expect(h.manager.stop("another-session")).rejects.toThrow("another connection");
    expect(h.closed).toBe(0);
    await h.manager.stop("live-1");
    expect(h.sent).toContainEqual(expect.objectContaining({ type: "session.close" }));
    expect(h.closed).toBeGreaterThan(0);
  });

  it("does not send a queued instruction after the owning socket closes", async () => {
    const h = harness();
    await h.manager.start({ threadId, sdp: "offer" });
    h.receive(transcript);
    h.receive(delegation);
    const work = h.manager.drain();
    await h.manager.dispose();
    await work;
    expect(h.dispatched).toHaveLength(0);
    await expect(h.manager.start({ threadId, sdp: "offer" })).rejects.toThrow("closed");
  });

  it("closes a late sideband handshake after cancellation", async () => {
    const connecting = deferred<void>();
    const release = deferred<void>();
    const events: unknown[] = [];
    let closeCount = 0;
    const h = harness({
      connect: async (_id, receive) => {
        connecting.resolve();
        await release.promise;
        return {
          send: (event) => {
            events.push(event);
            receive({
              type: "session.closed",
              session: { id: "live-1" },
              usage: { seconds: 0 },
              reason: "client_requested",
            });
          },
          close: () => {
            closeCount++;
          },
        };
      },
    });
    const start = h.manager.start({ threadId, sdp: "offer" });
    await connecting.promise;
    await h.manager.dispose();
    release.resolve();
    await expect(start).rejects.toThrow("cancelled");
    expect(events).toContainEqual(expect.objectContaining({ type: "session.close" }));
    expect(closeCount).toBeGreaterThan(0);
  });

  it("releases ownership after failed negotiation so the user can retry", async () => {
    let attempts = 0;
    const h = harness({
      create: async () => {
        if (++attempts === 1) throw new Error("upstream unavailable");
        return { sessionId: "live-1", sdp: "answer" };
      },
    });
    await expect(h.manager.start({ threadId, sdp: "offer" })).rejects.toThrow(
      "upstream unavailable",
    );
    expect(await h.manager.start({ threadId, sdp: "offer" })).toEqual({
      sessionId: "live-1",
      sdp: "answer",
    });
    await h.manager.dispose();
  });

  it("sends assembled coding output as session context, without assigning a possibly unrelated delegation", async () => {
    const h = harness();
    await h.manager.start({ threadId, sdp: "offer" });
    h.receive(transcript);
    h.receive(delegation);
    await h.manager.drain();
    h.manager.observe(assistantMessage(1, "The build ", true));
    h.manager.observe(assistantMessage(2, "passes.", true));
    h.manager.observe(assistantMessage(3, "", false));
    h.manager.observe(
      assistantMessage(4, "Private other thread", true, ThreadId.make("another-thread")),
    );
    h.manager.observe(assistantMessage(5, "", false, ThreadId.make("another-thread")));
    await h.manager.drain();
    const updates = h.sent.filter(
      (event) => (event as { type: string }).type === "session.commentary.append",
    );
    expect(updates).toEqual([
      expect.objectContaining({
        content: "Coding agent update in this thread: The build passes.",
        delegation_id: null,
      }),
    ]);
    await h.manager.dispose();
  });

  it("attempts server hangup when sideband attachment fails after session creation", async () => {
    const hungUp: string[] = [];
    const h = harness({
      connect: async () => {
        throw new Error("attachment failed");
      },
      hangup: async (id) => {
        hungUp.push(id);
        return true;
      },
    });
    await expect(h.manager.start({ threadId, sdp: "offer" })).rejects.toThrow("attachment failed");
    expect(hungUp).toEqual(["live-1"]);
  });

  it("does not claim cleanup succeeded when upstream hangup is rejected", async () => {
    const h = harness({
      connect: async () => {
        throw new Error("attachment failed");
      },
      hangup: async () => false,
    });
    await expect(h.manager.start({ threadId, sdp: "offer" })).rejects.toThrow("did not confirm");
  });

  it("retries unconfirmed cleanup before creating the next voice session", async () => {
    const operations: string[] = [];
    let created = 0;
    let hangups = 0;
    const h = harness({
      create: async () => {
        operations.push(`create:${++created}`);
        return { sessionId: `live-${created}`, sdp: "answer" };
      },
      connect: async () => ({
        send: () => {
          throw new Error("socket closed");
        },
        close: () => {},
      }),
      hangup: async (id) => {
        operations.push(`hangup:${id}`);
        return ++hangups > 1;
      },
    });
    await h.manager.start({ threadId, sdp: "offer" });
    await expect(h.manager.stop("live-1")).rejects.toThrow("did not confirm");
    expect(await h.manager.start({ threadId, sdp: "offer" })).toEqual({
      sessionId: "live-2",
      sdp: "answer",
    });
    expect(operations).toEqual(["create:1", "hangup:live-1", "hangup:live-1", "create:2"]);
    await h.manager.dispose();
  });

  it("does not create another paid session while cleanup remains unconfirmed", async () => {
    let created = 0;
    let hangups = 0;
    const h = harness({
      create: async () => {
        created++;
        return { sessionId: "live-1", sdp: "answer" };
      },
      connect: async () => ({
        send: () => {
          throw new Error("socket closed");
        },
        close: () => {},
      }),
      hangup: async () => {
        hangups++;
        return false;
      },
    });
    await h.manager.start({ threadId, sdp: "offer" });
    await expect(h.manager.stop("live-1")).rejects.toThrow("did not confirm");
    await expect(h.manager.start({ threadId, sdp: "offer" })).rejects.toThrow(
      "previous voice session",
    );
    expect(created).toBe(1);
    expect(hangups).toBe(2);
  });

  it("retries a previously failed hangup when the owning socket is disposed", async () => {
    const hungUp: string[] = [];
    const h = harness({
      connect: async () => ({
        send: () => {
          throw new Error("socket closed");
        },
        close: () => {},
      }),
      hangup: async (id) => {
        hungUp.push(id);
        return hungUp.length > 1;
      },
    });
    await h.manager.start({ threadId, sdp: "offer" });
    await expect(h.manager.stop("live-1")).rejects.toThrow("did not confirm");
    await h.manager.dispose();
    expect(hungUp).toEqual(["live-1", "live-1"]);
  });

  it("still attempts upstream hangup when a dead sideband rejects session.close", async () => {
    const hungUp: string[] = [];
    const h = harness({
      connect: async () => ({
        send: () => {
          throw new Error("socket closed");
        },
        close: () => {},
      }),
      hangup: async (id) => {
        hungUp.push(id);
        return true;
      },
    });
    await h.manager.start({ threadId, sdp: "offer" });
    await h.manager.stop("live-1");
    expect(hungUp).toEqual(["live-1"]);
  });
});
