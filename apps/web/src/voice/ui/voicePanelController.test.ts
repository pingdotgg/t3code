import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ThreadId, VoiceToolError } from "@t3tools/contracts";

import type {
  VoiceLiveClient,
  VoiceLiveClientEvent,
  VoiceLiveClientOptions,
  VoiceLiveMediaStreamTrack,
} from "../live-client";
import type { VoiceNavigationDestination, VoiceRouteDriver } from "../navigation";
import type { VoiceToolExecutor } from "../tools";
import { createVoiceHistoryRecorder } from "../history";
import {
  createVoicePanelController,
  describeVoiceToolError,
  type VoiceMicController,
  type VoicePanelControllerDeps,
} from "./voicePanelController";

// ---------------------------------------------------------------------------
// Fakes: the client, mic, broker port, executor, and router are all injected.
// ---------------------------------------------------------------------------

class FakeMicTrack implements VoiceLiveMediaStreamTrack {
  readonly kind = "audio";
  enabled = true;
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeMic implements VoiceMicController {
  readonly track = new FakeMicTrack();
  stopped = false;
  setMuted(muted: boolean): void {
    this.track.enabled = !muted;
  }
  stop(): void {
    this.stopped = true;
  }
}

interface FakeClientHarness {
  client: VoiceLiveClient;
  readonly events: VoiceLiveClientEvent[];
  readonly emittedMarks: Array<{ mark: string; detail?: string }>;
  readonly executorCalls: Array<{ name: string; input: unknown }>;
  readonly closed: { value: boolean };
  startError: VoiceToolError | undefined;
  /** Delivers a server event through the client's event bus to the panel. */
  emit(event: VoiceLiveClientEvent): void;
}

const makeFakeClient = (): FakeClientHarness => {
  const listeners = new Set<(event: VoiceLiveClientEvent) => void>();
  const harness: FakeClientHarness = {
    events: [],
    emittedMarks: [],
    executorCalls: [],
    closed: { value: false },
    startError: undefined,
    client: undefined as never,
    emit: (event) => {
      harness.events.push(event);
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
  harness.client = {
    start: async () => {
      if (harness.startError !== undefined) {
        throw harness.startError;
      }
      harness.emit({ type: "state", state: "live" });
      return { sessionId: "live_sess_1" as never };
    },
    close: async () => {
      harness.closed.value = true;
      harness.emit({ type: "state", state: "closed" });
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emitMark: (mark, detail) => {
      harness.emittedMarks.push({ mark, ...(detail === undefined ? {} : { detail }) });
    },
    getState: () => "live",
    getSessionId: () => "live_sess_1" as never,
  } as VoiceLiveClient;
  return harness;
};

const DESTINATION: VoiceNavigationDestination = {
  environmentId: "env-1" as EnvironmentId,
  threadId: "thread-1" as ThreadId,
};

interface Harness {
  deps: VoicePanelControllerDeps;
  readonly fakeClient: FakeClientHarness;
  readonly mic: FakeMic;
  readonly driverCalls: Array<{ to: string; params: VoiceNavigationDestination }>;
  readonly speakerTracks: VoiceLiveMediaStreamTrack[];
  /** The executor the controller wired into the client (tool bridge). */
  wiredExecutor: { execute(name: string, input: unknown): Promise<unknown> } | undefined;
  controller: ReturnType<typeof createVoicePanelController>;
  reachability: "unknown" | "disconnected" | "connected";
  brokerError: VoiceToolError | undefined;
}

const makeHarness = (): Harness => {
  const fakeClient = makeFakeClient();
  const mic = new FakeMic();
  const driverCalls: Array<{ to: string; params: VoiceNavigationDestination }> = [];
  const speakerTracks: VoiceLiveMediaStreamTrack[] = [];
  const harness: Harness = {
    fakeClient,
    mic,
    driverCalls,
    speakerTracks,
    deps: undefined as never,
    wiredExecutor: undefined,
    controller: undefined as never,
    reachability: "connected",
    brokerError: undefined,
  };
  const driver: VoiceRouteDriver = {
    navigate: async (input) => {
      driverCalls.push({ to: input.to, params: input.params });
    },
    readCurrentPath: () => `/${DESTINATION.environmentId}/${DESTINATION.threadId}`,
    subscribePathChange: () => () => {},
  };
  harness.deps = {
    resolveBrokerPort: async () => {
      if (harness.brokerError !== undefined) {
        throw harness.brokerError;
      }
      return {
        mintSession: async () => {
          throw new Error("broker mint is not exercised through the fake client");
        },
        closeSession: async () => ({ closed: true }),
      };
    },
    captureMic: async () => mic,
    createToolsExecutor: () =>
      ({
        // Per-tool executor (T2's VoiceToolExecutor shape): the bridge
        // dispatches by method; only openThread matters here.
        openThread: async (input: { environmentId: string; threadId: string }) => ({
          environment: { environmentId: input.environmentId, status: "ok" },
          acknowledged: false,
          destination: { environmentId: input.environmentId, threadId: input.threadId },
        }),
      }) as unknown as VoiceToolExecutor,
    driver,
    reachabilityOf: () => harness.reachability,
    attachSpeakerTrack: (track: VoiceLiveMediaStreamTrack) => {
      speakerTracks.push(track);
    },
    createClient: (options: VoiceLiveClientOptions) => {
      harness.wiredExecutor = options.executor as Harness["wiredExecutor"];
      return fakeClient.client;
    },
  };
  const controller = createVoicePanelController(harness.deps);
  harness.controller = controller;
  return harness;
};

describe("voice panel controller", () => {
  it("connects: mic captured, client started, phase transitions to live", async () => {
    const harness = makeHarness();
    expect(harness.controller.getState().phase).toBe("idle");

    await harness.controller.connect();

    expect(harness.controller.getState().phase).toBe("live");
    expect(harness.controller.getState().starting).toBe(false);
    expect(harness.controller.getState().error).toBeNull();
  });

  it("notifies subscribers with a fresh immutable snapshot on each change", async () => {
    const harness = makeHarness();
    const seen: Array<{ phase: string }> = [];
    let notifications = 0;
    harness.controller.subscribe(() => {
      notifications += 1;
      seen.push({ phase: harness.controller.getState().phase });
    });
    const before = harness.controller.getState();

    await harness.controller.connect();

    expect(notifications).toBeGreaterThan(0);
    const after = harness.controller.getState();
    expect(after).not.toBe(before);
    expect(after.phase).toBe("live");
    expect(seen[seen.length - 1]?.phase).toBe("live");
  });

  it("keeps connect disabled (starting) while mint work is pending", async () => {
    const harness = makeHarness();
    let releaseMic: (() => void) | undefined;
    harness.deps = {
      ...harness.deps,
      captureMic: () =>
        new Promise<VoiceMicController>((resolve) => {
          releaseMic = () => resolve(harness.mic);
        }),
    };

    const pending = harness.controller.connect();
    expect(harness.controller.getState().starting).toBe(true);

    // A second connect during startup is ignored.
    await harness.controller.connect();

    releaseMic?.();
    await pending;
    expect(harness.controller.getState().phase).toBe("live");
    expect(harness.controller.getState().starting).toBe(false);
  });

  it("surfaces a connect failure readably, stops the mic, and lands in error state", async () => {
    const harness = makeHarness();
    harness.brokerError = {
      code: "insufficient_scope",
      message: "session lacks orchestration:operate",
    };

    await harness.controller.connect();

    expect(harness.controller.getState().phase).toBe("error");
    expect(harness.controller.getState().error?.code).toBe("insufficient_scope");
    expect(harness.mic.stopped).toBe(true);
    expect(harness.controller.getState().starting).toBe(false);
  });

  it("folds transcript deltas into ordered speaker-labeled utterances", async () => {
    const harness = makeHarness();
    await harness.controller.connect();

    harness.fakeClient.emit({
      type: "transcript",
      channel: "input",
      delta: "find the ",
      utterance: "in-1",
    });
    harness.fakeClient.emit({
      type: "transcript",
      channel: "input",
      delta: "macroscope thread",
      utterance: "in-1",
    });
    harness.fakeClient.emit({
      type: "transcript",
      channel: "output",
      delta: "Opening it now.",
      utterance: "out-1",
    });

    expect(harness.controller.getState().utterances).toEqual([
      { id: "input:in-1", channel: "input", text: "find the macroscope thread" },
      { id: "output:out-1", channel: "output", text: "Opening it now." },
    ]);
  });

  it("keeps interleaved multi-turn utterances in arrival order with per-utterance streaming", async () => {
    const harness = makeHarness();
    await harness.controller.connect();

    harness.fakeClient.emit({
      type: "transcript",
      channel: "input",
      delta: "catch me up",
      utterance: "in-1",
    });
    harness.fakeClient.emit({
      type: "transcript",
      channel: "output",
      delta: "On the ",
      utterance: "out-1",
    });
    // The user interrupts while the assistant is mid-sentence, then the
    // assistant resumes its answer as a new utterance.
    harness.fakeClient.emit({
      type: "transcript",
      channel: "input",
      delta: "just the Oracle project",
      utterance: "in-2",
    });
    harness.fakeClient.emit({
      type: "transcript",
      channel: "output",
      delta: "Oracle project.",
      utterance: "out-2",
    });

    expect(harness.controller.getState().utterances).toEqual([
      { id: "input:in-1", channel: "input", text: "catch me up" },
      { id: "output:out-1", channel: "output", text: "On the " },
      { id: "input:in-2", channel: "input", text: "just the Oracle project" },
      { id: "output:out-2", channel: "output", text: "Oracle project." },
    ]);
  });

  it("appends a late delta to its matching utterance even after newer entries exist", async () => {
    const harness = makeHarness();
    await harness.controller.connect();

    harness.fakeClient.emit({
      type: "transcript",
      channel: "output",
      delta: "Part one.",
      utterance: "out-1",
    });
    harness.fakeClient.emit({
      type: "transcript",
      channel: "input",
      delta: "go on",
      utterance: "in-1",
    });
    // A late delta carrying the earlier utterance key still lands on its
    // owner; the entry order reflects arrival, keyed folding stays exact.
    harness.fakeClient.emit({
      type: "transcript",
      channel: "output",
      delta: " Part one continued.",
      utterance: "out-1",
    });

    const utterances = harness.controller.getState().utterances;
    expect(utterances).toHaveLength(2);
    expect(utterances[0]).toEqual({
      id: "output:out-1",
      channel: "output",
      text: "Part one. Part one continued.",
    });
    expect(utterances[1]).toEqual({
      id: "input:in-1",
      channel: "input",
      text: "go on",
    });
  });

  it("bounds retained utterances to the latest window", async () => {
    const harness = makeHarness();
    await harness.controller.connect();

    for (let index = 0; index < 205; index++) {
      harness.fakeClient.emit({
        type: "transcript",
        channel: "input",
        delta: `u${index}`,
        utterance: `in-${index + 1}`,
      });
    }

    const utterances = harness.controller.getState().utterances;
    expect(utterances).toHaveLength(200);
    expect(utterances[0]?.text).toBe("u5");
    expect(utterances[utterances.length - 1]?.text).toBe("u204");
  });

  it("shows the in-flight tool while delegated work runs and clears it on completion", async () => {
    const harness = makeHarness();
    await harness.controller.connect();

    harness.fakeClient.emit({
      type: "timing",
      record: { mark: "function_call_received", atMs: 1, detail: "voice.searchThreads" },
    });
    expect(harness.controller.getState().inFlightTool).toBe("voice.searchThreads");

    harness.fakeClient.emit({ type: "timing", record: { mark: "tool_done", atMs: 2 } });
    expect(harness.controller.getState().inFlightTool).toBeNull();
  });

  it("attaches the client's speaker track for playback", async () => {
    const harness = makeHarness();
    await harness.controller.connect();

    const track = new FakeMicTrack();
    harness.fakeClient.emit({ type: "track", track });

    expect(harness.speakerTracks).toHaveLength(1);
    expect(harness.speakerTracks[0]).toBe(track);
  });

  it("surfaces client error events readably", async () => {
    const harness = makeHarness();
    await harness.controller.connect();

    const error: VoiceToolError = {
      code: "environment_unreachable",
      message: "peer connection failed",
    };
    harness.fakeClient.emit({ type: "error", error });

    expect(harness.controller.getState().error).toEqual(error);
    expect(describeVoiceToolError(error)).toContain("could not be reached");
    expect(describeVoiceToolError(error)).toContain("peer connection failed");
  });

  it("mutes and unmutes by toggling the mic track, without touching the session", async () => {
    const harness = makeHarness();
    await harness.controller.connect();

    harness.controller.toggleMute();
    expect(harness.controller.getState().micMuted).toBe(true);
    expect(harness.mic.track.enabled).toBe(false);

    harness.controller.toggleMute();
    expect(harness.controller.getState().micMuted).toBe(false);
    expect(harness.mic.track.enabled).toBe(true);
    expect(harness.fakeClient.closed.value).toBe(false);
  });

  it("ends the session: client closed, mic stopped, phase closed", async () => {
    const harness = makeHarness();
    await harness.controller.connect();

    await harness.controller.end();

    expect(harness.fakeClient.closed.value).toBe(true);
    expect(harness.mic.stopped).toBe(true);
    expect(harness.controller.getState().micMuted).toBe(false);
    expect(harness.controller.getState().phase).toBe("closed");
  });

  it("clears utterances, errors, and navigation display", async () => {
    const harness = makeHarness();
    await harness.controller.connect();
    harness.fakeClient.emit({
      type: "transcript",
      channel: "input",
      delta: "hello",
      utterance: "in-1",
    });
    harness.fakeClient.emit({
      type: "transcript",
      channel: "output",
      delta: "hi",
      utterance: "out-1",
    });
    await harness.controller.end();

    harness.controller.clear();

    expect(harness.controller.getState().utterances).toEqual([]);
    expect(harness.controller.getState().error).toBeNull();
    expect(harness.controller.getState().navigationStatus).toBeNull();
  });

  it("resets utterances when reconnecting after a session ends", async () => {
    const harness = makeHarness();
    await harness.controller.connect();
    harness.fakeClient.emit({
      type: "transcript",
      channel: "input",
      delta: "hello",
      utterance: "in-1",
    });
    await harness.controller.end();

    await harness.controller.connect();

    expect(harness.controller.getState().utterances).toEqual([]);
    harness.fakeClient.emit({
      type: "transcript",
      channel: "input",
      delta: "fresh start",
      utterance: "in-1",
    });
    expect(harness.controller.getState().utterances).toEqual([
      { id: "input:in-1", channel: "input", text: "fresh start" },
    ]);
  });

  it("records a failed navigation readably in the navigation status", async () => {
    const harness = makeHarness();
    harness.reachability = "disconnected";
    await harness.controller.connect();

    const result = await harness.wiredExecutor?.execute("voice.openThread", {
      environmentId: DESTINATION.environmentId,
      threadId: DESTINATION.threadId,
    });

    expect(result).toMatchObject({ acknowledged: false });
    expect(harness.controller.getState().navigationFailed).toBe(true);
    expect(harness.controller.getState().navigationStatus).toContain("not connected");
  });

  it("acknowledged navigation records success and emits navigation marks through the client", async () => {
    const harness = makeHarness();
    await harness.controller.connect();

    // Output speech before any navigation: no first_useful_speech.
    harness.fakeClient.emit({
      type: "transcript",
      channel: "output",
      delta: "hello",
      utterance: "out-1",
    });
    expect(
      harness.fakeClient.emittedMarks.filter((mark) => mark.mark === "first_useful_speech"),
    ).toHaveLength(0);

    // Navigate through the wired executor bridge.
    await harness.wiredExecutor?.execute("voice.openThread", {
      environmentId: DESTINATION.environmentId,
      threadId: DESTINATION.threadId,
    });

    expect(harness.driverCalls).toEqual([{ to: "/$environmentId/$threadId", params: DESTINATION }]);
    expect(harness.controller.getState().navigationStatus).toContain("Opened thread");
    expect(harness.controller.getState().navigationFailed).toBe(false);
    const ackMarks = harness.fakeClient.emittedMarks.filter(
      (mark) => mark.mark === "navigation_acknowledged",
    );
    expect(ackMarks).toHaveLength(1);
    expect(ackMarks[0]?.detail).toBe("env-1/thread-1");

    // The first output delta after the acknowledgment fires first_useful_speech.
    harness.fakeClient.emit({
      type: "transcript",
      channel: "output",
      delta: "Here it is.",
      utterance: "out-2",
    });
    const speechMarks = harness.fakeClient.emittedMarks.filter(
      (mark) => mark.mark === "first_useful_speech",
    );
    expect(speechMarks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// End during a pending connection (parent-authorized narrow UI fix): the
// pending initial connect must be cancellable from the panel.
// ---------------------------------------------------------------------------

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("end during a pending connection", () => {
  /** Harness with a genuinely gated mic capture (the controller captures
      `deps` at creation, so per-test overrides of `harness.deps` never reach
      it) and a fresh fake client per connect attempt. */
  const makeGatedHarness = () => {
    const clients: FakeClientHarness[] = [];
    const mic = new FakeMic();
    let micGate: ((mic: VoiceMicController) => void) | undefined;
    const controller = createVoicePanelController({
      resolveBrokerPort: async () => ({
        mintSession: async () => {
          throw new Error("broker mint is not exercised through the fake client");
        },
        closeSession: async () => ({ closed: true }),
      }),
      captureMic: () =>
        micGate !== undefined
          ? new Promise<VoiceMicController>((resolve) => {
              micGate = resolve;
            })
          : Promise.resolve(mic),
      createToolsExecutor: () => ({}) as never,
      driver: {
        navigate: async () => {},
        readCurrentPath: () => "/",
        subscribePathChange: () => () => {},
      },
      reachabilityOf: () => "connected",
      attachSpeakerTrack: () => {},
      createClient: () => {
        const client = makeFakeClient();
        clients.push(client);
        return client.client;
      },
    });
    return {
      controller,
      mic,
      clients,
      holdMic: () => {
        micGate = () => {};
      },
      releaseMic: () => {
        micGate?.(mic);
        micGate = undefined;
      },
    };
  };

  it("end during idle-starting cancels the pending connect: late mic resolves to no client, no session, readable idle state", async () => {
    const harness = makeGatedHarness();
    harness.holdMic();
    const pending = harness.controller.connect();
    await flushMicrotasks();
    // The permission prompt is pending: Starting… with no client yet.
    expect(harness.controller.getState().phase).toBe("idle");
    expect(harness.controller.getState().starting).toBe(true);

    await harness.controller.end();

    const settled = harness.controller.getState();
    expect(settled.phase).toBe("idle");
    // The cancelled attempt must not leave the panel stuck on "Starting…".
    expect(settled.starting).toBe(false);

    // The late capture lands after the user ended: released, nothing acquired.
    harness.releaseMic();
    await pending;
    await flushMicrotasks();
    expect(harness.clients).toHaveLength(0);
    expect(harness.mic.stopped).toBe(true);
    expect(harness.controller.getState().phase).toBe("idle");
    expect(harness.controller.getState().starting).toBe(false);
  });

  it("after cancelling a pending connect, a fresh connect works again", async () => {
    const harness = makeGatedHarness();
    harness.holdMic();
    const pending = harness.controller.connect();
    await flushMicrotasks();
    await harness.controller.end();
    harness.releaseMic();
    await pending;
    await flushMicrotasks();

    await harness.controller.connect();
    expect(harness.clients).toHaveLength(1);
    expect(harness.controller.getState().phase).toBe("live");
    expect(harness.controller.getState().starting).toBe(false);
  });

  it("end during a pending start settles the display with starting visible false", async () => {
    const harness = makeGatedHarness();
    await harness.controller.connect();
    expect(harness.controller.getState().phase).toBe("live");

    // The r3 semantics: end() invalidates and closes through the lifecycle.
    await harness.controller.end();
    const settled = harness.controller.getState();
    expect(settled.phase).toBe("closed");
    expect(settled.starting).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// History recording: the durable session record follows the same event
// stream, navigation outcomes, and tool executions the panel displays.
// ---------------------------------------------------------------------------

describe("voice panel history recording", () => {
  const makeRecorderHarness = () => {
    const base = makeHarness();
    const recorder = createVoiceHistoryRecorder({ now: () => 1000 });
    base.deps = { ...base.deps, history: recorder };
    base.controller = createVoicePanelController(base.deps);
    return { base, recorder };
  };

  it("records transcript, tool outcome, navigation target, and errors in one session", async () => {
    const { base, recorder } = makeRecorderHarness();
    await base.controller.connect();

    base.fakeClient.emit({
      type: "transcript",
      channel: "input",
      delta: "open the macroscope thread",
      utterance: "in-1",
    });
    await base.wiredExecutor?.execute("voice.openThread", {
      environmentId: DESTINATION.environmentId,
      threadId: DESTINATION.threadId,
    });
    base.fakeClient.emit({
      type: "error",
      error: { code: "model_unavailable", message: "backend slow" },
    });
    await base.controller.end();

    const sessions = recorder.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endedAt).toBeDefined();
    const entries = recorder.readSession(sessions[0]!.id)!.entries;
    expect(entries).toContainEqual({
      kind: "utterance",
      id: "input:in-1",
      channel: "input",
      text: "open the macroscope thread",
      startedAt: 1000,
      updatedAt: 1000,
    });
    expect(entries).toContainEqual({
      kind: "tool",
      name: "openThread",
      status: "ok",
      input: { environmentId: "env-1", threadId: "thread-1" },
      result: {
        acknowledged: true,
        destination: { environmentId: "env-1", threadId: "thread-1" },
        environmentStatus: "ok",
      },
      startedAt: 1000,
      endedAt: 1000,
    });
    expect(entries).toContainEqual({
      kind: "navigation",
      status: "acknowledged",
      environmentId: "env-1",
      threadId: "thread-1",
      at: 1000,
    });
    expect(entries).toContainEqual({
      kind: "error",
      code: "model_unavailable",
      message: "backend slow",
      at: 1000,
    });
  });

  it("keeps a reconnect as a separate saved session", async () => {
    const { base, recorder } = makeRecorderHarness();

    await base.controller.connect();
    base.fakeClient.emit({
      type: "transcript",
      channel: "input",
      delta: "first session",
      utterance: "in-1",
    });
    await base.controller.end();

    await base.controller.connect();
    base.fakeClient.emit({
      type: "transcript",
      channel: "input",
      delta: "second session",
      utterance: "in-1",
    });
    await base.controller.end();

    const sessions = recorder.listSessions();
    expect(sessions).toHaveLength(2);
    const texts = sessions.map((session) =>
      recorder.readSession(session.id)!.entries.find((entry) => entry.kind === "utterance"),
    );
    expect(texts).toEqual([
      {
        kind: "utterance",
        id: "input:in-1",
        channel: "input",
        text: "first session",
        startedAt: 1000,
        updatedAt: 1000,
      },
      {
        kind: "utterance",
        id: "input:in-1",
        channel: "input",
        text: "second session",
        startedAt: 1000,
        updatedAt: 1000,
      },
    ]);
  });

  it("records a failed tool execution and preserves the failure", async () => {
    const { base, recorder } = makeRecorderHarness();
    base.deps = {
      ...base.deps,
      createToolsExecutor: () =>
        ({
          openThread: async () => {
            throw new Error("environment disconnected");
          },
        }) as unknown as VoiceToolExecutor,
    };
    base.controller = createVoicePanelController(base.deps);
    await base.controller.connect();

    await expect(
      base.wiredExecutor?.execute("voice.openThread", {
        environmentId: DESTINATION.environmentId,
        threadId: DESTINATION.threadId,
      }),
    ).rejects.toThrow("environment disconnected");

    const sessions = recorder.listSessions();
    const entries = recorder.readSession(sessions[0]!.id)!.entries;
    expect(entries).toContainEqual({
      kind: "tool",
      name: "openThread",
      status: "failed",
      input: { environmentId: "env-1", threadId: "thread-1" },
      startedAt: 1000,
      endedAt: 1000,
      error: "environment disconnected",
    });
  });
});
