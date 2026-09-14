import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createLiveVoiceController,
  type LiveVoiceControllerDependencies,
  type LiveVoiceState,
  type LiveVoiceTransportCallbacks,
} from "./controller.ts";

function harness(overrides: Partial<LiveVoiceControllerDependencies> = {}) {
  let callbacks!: LiveVoiceTransportCallbacks;
  const transport = {
    createOffer: vi.fn(async () => "offer"),
    acceptAnswer: vi.fn(async (_sdp: string) => undefined),
    setMuted: vi.fn((_muted: boolean) => undefined),
    close: vi.fn(),
  };
  const states: LiveVoiceState[] = [];
  const dependencies: LiveVoiceControllerDependencies = {
    createTransport: vi.fn((next) => {
      callbacks = next;
      return transport;
    }),
    startSession: vi.fn(async () => ({ sessionId: "session-1", sdp: "answer" })),
    stopSession: vi.fn(async () => undefined),
    onStateChange: (state) => states.push(state),
    ...overrides,
  };
  return {
    controller: createLiveVoiceController(dependencies),
    transport,
    dependencies,
    states,
    event: (data: unknown) => callbacks.onEvent(data),
    connection: (state: Parameters<LiveVoiceTransportCallbacks["onConnectionState"]>[0]) =>
      callbacks.onConnectionState(state),
  };
}

afterEach(() => vi.useRealTimers());

describe("live voice lifecycle", () => {
  it("shares a pending start, waits for connection, and stops media and the session once", async () => {
    const h = harness();
    const starting = h.controller.start();
    expect(h.controller.start()).toBe(starting);
    await starting;
    expect(h.controller.getState().status).toBe("connecting");
    h.connection("connected");
    expect(h.controller.getState().status).toBe("connecting");
    h.event({ type: "session.started" });
    expect(h.controller.getState().status).toBe("connected");
    expect(h.transport.acceptAnswer).toHaveBeenCalledWith("answer");

    await Promise.all([h.controller.stop(), h.controller.stop(), h.controller.dispose()]);

    expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(h.dependencies.stopSession).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(h.controller.getState().status).toBe("idle");
  });

  it("releases late microphone permission after disposal without starting a remote session", async () => {
    const entered = Promise.withResolvers<void>();
    const permission = Promise.withResolvers<void>();
    const h = harness();
    h.transport.createOffer.mockImplementation(async () => {
      entered.resolve();
      await permission.promise;
      return "late-offer";
    });
    const starting = h.controller.start();
    await entered.promise;
    const disposing = h.controller.dispose();
    expect(h.transport.close).toHaveBeenCalledTimes(1);
    permission.resolve();
    await Promise.all([starting, disposing]);

    expect(h.dependencies.startSession).not.toHaveBeenCalled();
    expect(h.controller.getState().status).toBe("idle");
    await h.controller.start();
    expect(h.transport.createOffer).toHaveBeenCalledTimes(1);
  });

  it("closes a transport returned after its factory was canceled", async () => {
    const entered = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    const close = vi.fn();
    const createOffer = vi.fn(async () => "offer");
    const h = harness({
      createTransport: async () => {
        entered.resolve();
        await prepared.promise;
        return {
          createOffer,
          close,
          acceptAnswer: async () => undefined,
          setMuted: () => undefined,
        };
      },
    });
    const starting = h.controller.start();
    await entered.promise;
    const stopping = h.controller.stop();
    prepared.resolve();
    await Promise.all([starting, stopping]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(createOffer).not.toHaveBeenCalled();
  });

  it("stops a remote session created after disposal even when the request ignores abort", async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const response = Promise.withResolvers<{ sessionId: string; sdp: string }>();
    const h = harness({
      startSession: ({ signal }) => {
        entered.resolve(signal);
        return response.promise;
      },
    });
    const starting = h.controller.start();
    const signal = await entered.promise;
    const notifications = h.states.length;
    const disposing = h.controller.dispose();
    expect(signal.aborted).toBe(true);
    response.resolve({ sessionId: "late-session", sdp: "late-answer" });
    await Promise.all([starting, disposing]);

    expect(h.transport.acceptAnswer).not.toHaveBeenCalled();
    expect(h.dependencies.stopSession).toHaveBeenCalledExactlyOnceWith("late-session");
    expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(h.states).toHaveLength(notifications);
  });

  it.each(["permission", "authorization", "answer"] as const)(
    "surfaces %s failure and releases all acquired resources",
    async (phase) => {
      const failure = new Error(`${phase} denied`);
      const h = harness(
        phase === "authorization"
          ? {
              startSession: async () => {
                throw failure;
              },
            }
          : {},
      );
      if (phase === "permission") h.transport.createOffer.mockRejectedValue(failure);
      if (phase === "answer") h.transport.acceptAnswer.mockRejectedValue(failure);
      await h.controller.start();
      expect(h.controller.getState()).toMatchObject({ status: "error", error: failure.message });
      expect(h.transport.close).toHaveBeenCalledTimes(1);
      if (phase === "answer")
        expect(h.dependencies.stopSession).toHaveBeenCalledExactlyOnceWith("session-1");
      else expect(h.dependencies.stopSession).not.toHaveBeenCalled();
    },
  );

  it("retains mute selected during microphone preparation and applies later changes", async () => {
    const entered = Promise.withResolvers<void>();
    const permission = Promise.withResolvers<void>();
    const h = harness();
    h.transport.createOffer.mockImplementation(async () => {
      entered.resolve();
      await permission.promise;
      return "offer";
    });
    const starting = h.controller.start();
    await entered.promise;
    h.controller.setMuted(true);
    permission.resolve();
    await starting;
    expect(h.controller.getState().muted).toBe(true);
    expect(h.transport.setMuted).toHaveBeenLastCalledWith(true);
    h.controller.setMuted(false);
    expect(h.transport.setMuted).toHaveBeenLastCalledWith(false);
    await h.controller.stop();
  });

  it("appends exact transcript deltas once and ignores malformed or late events", async () => {
    const h = harness();
    await h.controller.start();
    const first = { type: "session.input_transcript.delta", event_id: "1", delta: "Fix " };
    h.event(first);
    h.event(first);
    h.event({ type: "session.input_transcript.delta", event_id: "2", delta: "this." });
    h.event({ type: "session.output_transcript.delta", delta: "Okay." });
    h.event({ type: "session.output_transcript.delta", delta: 1 });
    h.event(null);
    expect(h.controller.getState().transcript).toEqual([
      { role: "user", text: "Fix this." },
      { role: "assistant", text: "Okay." },
    ]);
    await h.controller.stop();
    h.event({ type: "session.output_transcript.delta", delta: "late" });
    h.connection("connected");
    expect(h.controller.getState().transcript[1]?.text).toBe("Okay.");
    expect(h.controller.getState().status).toBe("idle");
  });

  it("bounds both conversation history and a single uninterrupted transcript", async () => {
    const h = harness();
    await h.controller.start();
    for (let index = 0; index < 300; index++) {
      h.event({
        type:
          index % 2 === 0 ? "session.input_transcript.delta" : "session.output_transcript.delta",
        delta: String(index),
      });
    }
    expect(h.controller.getState().transcript.length).toBeLessThanOrEqual(100);
    h.event({ type: "session.output_transcript.delta", delta: "x".repeat(50_000) });
    expect(
      h.controller.getState().transcript.reduce((size, entry) => size + entry.text.length, 0),
    ).toBeLessThanOrEqual(24_000);
    await h.controller.stop();
  });

  it("stops on protocol errors and disconnects without duplicate cleanup", async () => {
    const h = harness();
    await h.controller.start();
    h.event({ type: "error", error: { message: "Playback permission denied" } });
    h.connection("failed");
    await h.controller.dispose();
    expect(h.controller.getState()).toMatchObject({
      status: "error",
      error: "Playback permission denied",
    });
    expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(h.dependencies.stopSession).toHaveBeenCalledExactlyOnceWith("session-1");
  });

  it("times out a stalled connection and cancels the deadline after connection", async () => {
    vi.useFakeTimers();
    const stalled = harness();
    await stalled.controller.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stalled.controller.getState()).toMatchObject({
      status: "error",
      error: expect.stringContaining("timed out"),
    });
    expect(stalled.transport.close).toHaveBeenCalledTimes(1);
    expect(stalled.dependencies.stopSession).toHaveBeenCalledExactlyOnceWith("session-1");

    const connected = harness();
    await connected.controller.start();
    connected.connection("connected");
    connected.event({ type: "session.started" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connected.controller.getState().status).toBe("connected");
    await connected.controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["permission", "session"] as const)(
    "waits for canceled %s work before restarting and ignores stale callbacks",
    async (phase) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const callbacks: LiveVoiceTransportCallbacks[] = [];
      const closes = [vi.fn(), vi.fn()];
      let transportNumber = 0;
      let sessionNumber = 0;
      const h = harness({
        createTransport: (next) => {
          const number = transportNumber++;
          callbacks.push(next);
          return {
            createOffer: async () => {
              if (phase === "permission" && number === 0) {
                entered.resolve();
                await release.promise;
              }
              return `offer-${number}`;
            },
            acceptAnswer: async () => undefined,
            setMuted: () => undefined,
            close: closes[number]!,
          };
        },
        startSession: async () => {
          const number = sessionNumber++;
          if (phase === "session" && number === 0) {
            entered.resolve();
            await release.promise;
          }
          return { sessionId: `session-${number}`, sdp: "answer" };
        },
      });
      const starting = h.controller.start();
      await entered.promise;
      const stopping = h.controller.stop();
      const restarting = h.controller.start();
      await Promise.resolve();
      expect(transportNumber).toBe(1);
      release.resolve();
      await Promise.all([starting, stopping, restarting]);
      expect(transportNumber).toBe(2);
      callbacks[1]!.onEvent({ type: "session.started" });
      callbacks[1]!.onConnectionState("connected");
      callbacks[0]!.onEvent({ type: "error", error: { message: "old error" } });
      callbacks[0]!.onConnectionState("closed");
      expect(h.controller.getState().status).toBe("connected");
      expect(closes[0]).toHaveBeenCalledTimes(1);
      expect(closes[1]).not.toHaveBeenCalled();
      if (phase === "session")
        expect(h.dependencies.stopSession).toHaveBeenCalledExactlyOnceWith("session-0");
      else expect(h.dependencies.stopSession).not.toHaveBeenCalled();
      await h.controller.stop();
    },
  );

  it("cancels a queued restart if the user ends the call again", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<{ sessionId: string; sdp: string }>();
    const h = harness({
      startSession: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const starting = h.controller.start();
    await entered.promise;
    const stopping = h.controller.stop();
    const restarting = h.controller.start();
    const stoppingAgain = h.controller.stop();
    release.resolve({ sessionId: "late", sdp: "answer" });
    await Promise.all([starting, stopping, restarting, stoppingAgain]);
    expect(h.dependencies.createTransport).toHaveBeenCalledTimes(1);
    expect(h.controller.getState().status).toBe("idle");
  });
});
