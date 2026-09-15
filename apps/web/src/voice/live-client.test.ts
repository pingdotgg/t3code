import { describe, expect, it } from "vite-plus/test";
import type {
  VoiceBrokerSessionCreated,
  VoiceBrokerSessionRequest,
  VoiceTimingMarkRecord,
  VoiceToolError,
} from "@t3tools/contracts";
import { VoiceSessionId } from "@t3tools/contracts";

import {
  createVoiceLiveClient,
  type VoiceLiveClientEvent,
  type VoiceLiveRtcDataChannel,
  type VoiceLiveRtcPeerConnection,
  type VoiceLiveSessionDescription,
  type VoiceLiveToolExecutor,
} from "./live-client.ts";

// ---------------------------------------------------------------------------
// Fakes: the whole WebRTC/broker/executor surface is injected, so these tests
// run in plain Node without network, media hardware, or DOM globals.
// ---------------------------------------------------------------------------

class FakeDataChannel implements VoiceLiveRtcDataChannel {
  readonly sent: Array<string> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: { readonly message?: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Simulates the Live server delivering one event on the channel. */
  receive(event: unknown): void {
    this.onmessage?.({ data: typeof event === "string" ? event : JSON.stringify(event) });
  }

  sentTypes(): Array<string> {
    return this.sent.map((data) => {
      const parsed = JSON.parse(data) as { type?: string };
      return parsed.type ?? "<unknown>";
    });
  }
}

class FakePeerConnection implements VoiceLiveRtcPeerConnection {
  readonly channel = new FakeDataChannel();
  readonly addedTracks: Array<unknown> = [];
  remoteDescription: VoiceLiveSessionDescription | undefined;
  closed = false;
  connectionState = "new";
  ontrack: VoiceLiveRtcPeerConnection["ontrack"] = null;
  onconnectionstatechange: (() => void) | null = null;

  createDataChannel(): VoiceLiveRtcDataChannel {
    return this.channel;
  }

  async createOffer(): Promise<VoiceLiveSessionDescription> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(description: VoiceLiveSessionDescription): Promise<void> {
    this.remoteDescription = description;
  }

  addTrack(track: unknown): void {
    this.addedTracks.push(track);
  }

  close(): void {
    this.closed = true;
  }

  failConnection(): void {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }
}

class VoiceLiveMediaTrackStub {
  readonly kind = "audio";
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

interface FakeBrokerState {
  readonly mintRequests: Array<VoiceBrokerSessionRequest>;
  readonly closeRequests: Array<string>;
  mintResult: VoiceBrokerSessionCreated;
  mintError: VoiceToolError | undefined;
  closeError: VoiceToolError | undefined;
}

const makeBroker = (state: FakeBrokerState) => ({
  async mintSession(request: VoiceBrokerSessionRequest) {
    state.mintRequests.push(request);
    if (state.mintError !== undefined) {
      throw state.mintError;
    }
    return state.mintResult;
  },
  async closeSession(input: { readonly sessionId: VoiceSessionId }) {
    state.closeRequests.push(input.sessionId);
    if (state.closeError !== undefined) {
      throw state.closeError;
    }
    return { closed: true };
  },
});

const makeBrokerState = (): FakeBrokerState => ({
  mintRequests: [],
  closeRequests: [],
  mintResult: { sessionId: VoiceSessionId.make("live_sess_1"), sdp: "answer-sdp" },
  mintError: undefined,
  closeError: undefined,
});

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface ClientHarness {
  client: ReturnType<typeof createVoiceLiveClient>;
  readonly peerConnection: FakePeerConnection;
  readonly brokerState: FakeBrokerState;
  readonly events: Array<VoiceLiveClientEvent>;
  readonly marks: Array<VoiceTimingMarkRecord>;
  readonly states: Array<string>;
  readonly executorCalls: Array<{ readonly name: string; readonly input: unknown }>;
  executorResult: unknown;
  executorError: Error | undefined;
}

const makeClient = (overrides?: {
  readonly brokerState?: FakeBrokerState;
  /** "none" starts the client without any tool executor. */
  readonly executor?: VoiceLiveToolExecutor | "none";
  readonly audioTrack?: VoiceLiveMediaTrackStub;
  readonly acknowledgeAction?: () => void;
  readonly onSpeechSuppressionChange?: (suppressed: boolean) => void;
}): ClientHarness => {
  const peerConnection = new FakePeerConnection();
  const brokerState = overrides?.brokerState ?? makeBrokerState();
  const executorCalls: Array<{ readonly name: string; readonly input: unknown }> = [];
  const harness: ClientHarness = {
    client: undefined as never,
    peerConnection,
    brokerState,
    events: [],
    marks: [],
    states: [],
    executorCalls,
    executorResult: { ok: true },
    executorError: undefined,
  };
  const inlineExecutor: VoiceLiveToolExecutor = {
    execute: (name: string, input: unknown) => {
      executorCalls.push({ name, input });
      if (harness.executorError !== undefined) {
        return Promise.reject(harness.executorError);
      }
      return Promise.resolve(harness.executorResult);
    },
  };
  const executor: VoiceLiveToolExecutor | undefined =
    overrides?.executor === "none" ? undefined : (overrides?.executor ?? inlineExecutor);
  harness.client = createVoiceLiveClient({
    broker: makeBroker(brokerState),
    createPeerConnection: () => peerConnection,
    ...(overrides?.onSpeechSuppressionChange
      ? { onSpeechSuppressionChange: overrides.onSpeechSuppressionChange }
      : {}),
    ...(overrides?.acknowledgeAction ? { acknowledgeAction: overrides.acknowledgeAction } : {}),
    ...(executor !== undefined ? { executor } : {}),
    ...(overrides?.audioTrack !== undefined ? { audioTrack: overrides.audioTrack } : {}),
  });
  harness.client.onEvent((event) => {
    harness.events.push(event);
    if (event.type === "timing") {
      harness.marks.push(event.record);
    }
    if (event.type === "state") {
      harness.states.push(event.state);
    }
  });
  return harness;
};

/** Drives the client to the live state. The session.started event is
    delivered only after start() has finished its setup, mirroring the real
    ordering where the data channel cannot carry events before the answer SDP
    is applied. */
const startToLive = async (harness: ClientHarness) => {
  const started = harness.client.start();
  await flushMicrotasks();
  harness.peerConnection.channel.receive({ type: "session.started" });
  await started;
  // The genuine delegation event, per the documented Live event list.
  harness.peerConnection.channel.receive({ type: "session.delegation.created" });
};

const markNames = (harness: ClientHarness) => harness.marks.map((record) => record.mark);

/** Delivers one delegation event in the documented nested envelope. */
const receiveDelegationEvent = (
  harness: ClientHarness,
  delegationId: string,
  event: Record<string, unknown>,
) => {
  harness.peerConnection.channel.receive({
    type: "response.event",
    delegation_id: delegationId,
    event,
  });
};

const functionCallDone = (call: {
  readonly callId: string;
  readonly name: string;
  readonly args?: string;
}) => ({
  type: "response.output_item.done",
  item: {
    type: "function_call",
    call_id: call.callId,
    name: call.name,
    arguments: call.args ?? "{}",
  },
});

const responseCompleted = (responseId: string) => ({
  type: "response.completed",
  // Lifecycle snapshots legitimately carry an empty output array; results
  // come from collected output_item.done events, never from this array.
  response: { id: responseId, output: [] },
});

const sentEvents = (harness: ClientHarness) =>
  harness.peerConnection.channel.sent.map((data) => JSON.parse(data) as Record<string, any>);

const outputItems = (harness: ClientHarness) =>
  sentEvents(harness).filter(
    (event) => event.type === "response.item.create" && event.item?.type === "function_call_output",
  );

const continuationCount = (harness: ClientHarness) =>
  sentEvents(harness).filter((event) => event.type === "response.create").length;

describe("voice live client", () => {
  it("surfaces Live backend request errors instead of silently waiting", async () => {
    const harness = makeClient();
    await startToLive(harness);
    harness.peerConnection.channel.receive({
      type: "error",
      error: {
        code: "invalid_request_error",
        message: "Invalid schema for function discoverEnvironments",
      },
    });
    expect(harness.events).toContainEqual({
      type: "error",
      error: {
        code: "invalid_request",
        message: "Invalid schema for function discoverEnvironments",
      },
    });
  });
  it("sends typed user input before continuing the backend, only when live", async () => {
    const harness = makeClient();
    expect(harness.client.sendText?.("lookup")).toBe(false);
    await startToLive(harness);
    expect(harness.client.sendText?.("  ")).toBe(false);
    expect(harness.client.sendText?.("Find Macroscope trials")).toBe(true);
    expect(harness.peerConnection.channel.sent.map((data) => JSON.parse(data))).toEqual([
      {
        type: "response.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Find Macroscope trials" }],
        },
      },
      { type: "response.create" },
    ]);
  });
  it("mints through the broker, applies the answer SDP, and never sends session.start", async () => {
    const harness = makeClient({ audioTrack: new VoiceLiveMediaTrackStub() });
    await startToLive(harness);

    expect(harness.brokerState.mintRequests).toEqual([
      { transport: { type: "webrtc", sdp: "offer-sdp" } },
    ]);
    expect(harness.peerConnection.remoteDescription).toEqual({
      type: "answer",
      sdp: "answer-sdp",
    });
    expect(harness.peerConnection.addedTracks).toHaveLength(1);
    expect(harness.client.getSessionId()).toBe("live_sess_1");
    expect(harness.client.getState()).toBe("live");
    expect(harness.peerConnection.channel.sentTypes()).not.toContain("session.start");
  });

  it("walks the state machine idle -> minting -> connecting -> live", async () => {
    const harness = makeClient();
    const started = harness.client.start();
    expect(harness.states).toEqual(["minting"]);
    await flushMicrotasks();
    expect(harness.states).toEqual(["minting", "connecting"]);
    harness.peerConnection.channel.receive({ type: "session.started" });
    await started;
    expect(harness.states).toEqual(["minting", "connecting", "live"]);
  });

  it("runs the function round trip over nested response.event envelopes", async () => {
    const harness = makeClient();
    await startToLive(harness);

    receiveDelegationEvent(harness, "del_1", {
      type: "response.created",
      response: { id: "resp_1" },
    });
    receiveDelegationEvent(
      harness,
      "del_1",
      functionCallDone({
        callId: "call_1",
        name: "voice.searchThreads",
        args: JSON.stringify({ query: "macroscope" }),
      }),
    );
    receiveDelegationEvent(harness, "del_1", responseCompleted("resp_1"));
    await flushMicrotasks();

    expect(harness.executorCalls).toEqual([
      { name: "voice.searchThreads", input: { query: "macroscope" } },
    ]);
    expect(outputItems(harness)).toEqual([
      {
        type: "response.item.create",
        item: { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
      },
    ]);
    expect(continuationCount(harness)).toBe(1);
    // The output item must be submitted before the follow-up response.create.
    const sent = sentEvents(harness);
    expect(sent.findIndex((event) => event.type === "response.item.create")).toBeLessThan(
      sent.findIndex((event) => event.type === "response.create"),
    );
  });

  it("rejects new-thread creation for an update in managed delegation", async () => {
    const harness = makeClient();
    await startToLive(harness);
    harness.peerConnection.channel.receive({
      type: "session.input_transcript.delta",
      delta: "Ask that thread for an update",
    });
    harness.peerConnection.channel.receive({
      type: "session.delegation.created",
      delegation: { id: "update", target: "responses" },
    });
    receiveDelegationEvent(harness, "update", {
      type: "response.created",
      response: { id: "update-response" },
    });
    receiveDelegationEvent(
      harness,
      "update",
      functionCallDone({ callId: "wrong-new-thread", name: "voice.startThread", args: "{}" }),
    );
    receiveDelegationEvent(harness, "update", responseCompleted("update-response"));
    await flushMicrotasks();
    expect(harness.executorCalls).toHaveLength(0);
    expect(JSON.stringify(outputItems(harness))).toContain("No explicit new-thread request");
  });

  it("chimes once only after managed navigation is acknowledged", async () => {
    let chimes = 0;
    const harness = makeClient({
      acknowledgeAction: () => {
        chimes++;
      },
    });
    await startToLive(harness);
    for (const acknowledged of [false, true]) {
      harness.executorResult = { acknowledged };
      const id = `navigation-${acknowledged}`;
      receiveDelegationEvent(harness, id, { type: "response.created", response: { id } });
      receiveDelegationEvent(
        harness,
        id,
        functionCallDone({ callId: id, name: "voice.openThread", args: "{}" }),
      );
      receiveDelegationEvent(harness, id, responseCompleted(id));
      await flushMicrotasks();
      expect(chimes).toBe(acknowledged ? 1 : 0);
    }
  });

  it("holds navigation speech at the first input fragment and releases questions and errors", async () => {
    const states: boolean[] = [];
    const harness = makeClient({ onSpeechSuppressionChange: (value) => states.push(value) });
    await startToLive(harness);
    harness.peerConnection.channel.receive({
      type: "session.input_transcript.delta",
      delta: "Open the",
    });
    expect(states.at(-1)).toBe(true);
    harness.peerConnection.channel.receive({
      type: "session.output_transcript.delta",
      delta: "Sure, let me find it",
    });
    expect(
      harness.events.filter((e) => e.type === "transcript" && e.channel === "output"),
    ).toHaveLength(0);
    harness.client.setSpeechSuppressed?.(false);
    harness.peerConnection.channel.receive({
      type: "session.output_transcript.delta",
      delta: "Which thread?",
    });
    expect(harness.events).toContainEqual({
      type: "transcript",
      channel: "output",
      delta: "Which thread?",
      utterance: "out-1",
    });
    harness.client.setSpeechSuppressed?.(true);
    harness.peerConnection.channel.receive({
      type: "error",
      error: { message: "Could not open thread" },
    });
    expect(states.at(-1)).toBe(false);
  });

  it("submits one batched continuation for multiple out-of-order calls, deduplicating duplicates", async () => {
    const harness = makeClient();
    await startToLive(harness);

    receiveDelegationEvent(harness, "del_1", {
      type: "response.created",
      response: { id: "resp_1" },
    });
    // Out of order: the second call finishes first, then a duplicate delivery
    // of the first call, then the first call itself.
    receiveDelegationEvent(
      harness,
      "del_1",
      functionCallDone({
        callId: "call_2",
        name: "voice.readThread",
        args: JSON.stringify({ threadId: "thread-2" }),
      }),
    );
    receiveDelegationEvent(
      harness,
      "del_1",
      functionCallDone({ callId: "call_1", name: "voice.searchThreads" }),
    );
    receiveDelegationEvent(
      harness,
      "del_1",
      functionCallDone({ callId: "call_1", name: "voice.searchThreads" }),
    );
    receiveDelegationEvent(
      harness,
      "del_1",
      functionCallDone({ callId: "call_1", name: "voice.searchThreads" }),
    );
    receiveDelegationEvent(harness, "del_1", responseCompleted("resp_1"));
    // Duplicate completion delivery: must not re-submit or re-continue.
    receiveDelegationEvent(harness, "del_1", responseCompleted("resp_1"));
    await flushMicrotasks();

    expect(harness.executorCalls).toHaveLength(2);
    expect(harness.executorCalls.map((call) => call.name)).toEqual([
      "voice.readThread",
      "voice.searchThreads",
    ]);
    const outputs = outputItems(harness);
    expect(outputs).toHaveLength(2);
    expect(outputs.map((event) => event.item.call_id)).toEqual(["call_2", "call_1"]);
    expect(continuationCount(harness)).toBe(1);
    const sent = sentEvents(harness);
    const lastOutputIndex = sent.findIndex(
      (event) => event.type === "response.item.create" && event.item?.call_id === "call_1",
    );
    expect(sent.findIndex((event) => event.type === "response.create")).toBeGreaterThan(
      lastOutputIndex,
    );
  });

  it("never treats an empty lifecycle output snapshot as a completed batch with no calls", async () => {
    const harness = makeClient();
    await startToLive(harness);

    receiveDelegationEvent(harness, "del_1", {
      type: "response.created",
      response: { id: "resp_1" },
    });
    // A plain completion with an empty snapshot and no collected calls must
    // not produce any submission or continuation.
    receiveDelegationEvent(harness, "del_1", responseCompleted("resp_1"));
    await flushMicrotasks();

    expect(harness.executorCalls).toHaveLength(0);
    expect(outputItems(harness)).toHaveLength(0);
    expect(continuationCount(harness)).toBe(0);
  });

  it("records the function-loop timing marks, with the delegation mark on session.delegation.created", async () => {
    const harness = makeClient();
    const preLive = makeClient();
    // session.started alone must NOT emit the delegation mark...
    const starting = preLive.client.start();
    await flushMicrotasks();
    preLive.peerConnection.channel.receive({ type: "session.started" });
    await starting;
    expect(markNames(preLive)).not.toContain("session_delegation_created");
    // ...the genuine delegation event does.
    preLive.peerConnection.channel.receive({ type: "session.delegation.created" });
    expect(markNames(preLive)).toEqual(["session_delegation_created"]);

    await startToLive(harness);
    receiveDelegationEvent(harness, "del_1", {
      type: "response.created",
      response: { id: "resp_1" },
    });
    receiveDelegationEvent(
      harness,
      "del_1",
      functionCallDone({ callId: "call_1", name: "voice.searchThreads" }),
    );
    receiveDelegationEvent(harness, "del_1", responseCompleted("resp_1"));
    await flushMicrotasks();
    // Consumer-owned mark exposed through the mark bus (T4's navigation).
    harness.client.emitMark("navigation_acknowledged", "route-read-back");

    expect(markNames(harness)).toEqual([
      "session_delegation_created",
      "function_call_received",
      "tool_done",
      "function_call_output_sent",
      "navigation_acknowledged",
    ]);
  });

  it("emits utterance_end as unavailable alongside the first output transcript delta", async () => {
    const harness = makeClient();
    await startToLive(harness);

    harness.peerConnection.channel.receive({
      type: "session.output_transcript.delta",
      delta: "Hel",
    });
    harness.peerConnection.channel.receive({
      type: "session.output_transcript.delta",
      delta: "lo",
    });

    const utteranceEnd = harness.marks.find((record) => record.mark === "utterance_end");
    expect(utteranceEnd).toMatchObject({ source: "unavailable" });
    expect(
      markNames(harness).filter((mark) => mark === "first_output_transcript_delta"),
    ).toHaveLength(1);

    const transcripts = harness.events.filter((event) => event.type === "transcript");
    expect(transcripts).toEqual([
      { type: "transcript", channel: "output", delta: "Hel", utterance: "out-1" },
      { type: "transcript", channel: "output", delta: "lo", utterance: "out-1" },
    ]);
  });

  it("exposes input transcript deltas and usage updates as events", async () => {
    const harness = makeClient();
    await startToLive(harness);

    harness.peerConnection.channel.receive({
      type: "session.input_transcript.delta",
      delta: "find the thread",
    });
    harness.peerConnection.channel.receive({
      type: "session.usage.updated",
      usage: { input_tokens: 5 },
    });

    expect(harness.events).toContainEqual({
      type: "transcript",
      channel: "input",
      delta: "find the thread",
      utterance: "in-1",
    });
    const usage = harness.events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({
      type: "usage",
      usage: { sessionId: "live_sess_1", usage: { input_tokens: 5 } },
    });
  });

  it("starts a new utterance on each channel flip across a multi-turn conversation", async () => {
    const harness = makeClient();
    await startToLive(harness);
    const transcriptsOf = (channel: "input" | "output") =>
      harness.events
        .filter((event) => event.type === "transcript" && event.channel === channel)
        .map((event) => (event as { utterance: string; delta: string }).utterance);

    harness.peerConnection.channel.receive({
      type: "session.input_transcript.delta",
      delta: "find ",
    });
    harness.peerConnection.channel.receive({
      type: "session.input_transcript.delta",
      delta: "the thread",
    });
    expect(transcriptsOf("input")).toEqual(["in-1", "in-1"]);

    harness.peerConnection.channel.receive({
      type: "session.output_transcript.delta",
      delta: "Opening ",
    });
    harness.peerConnection.channel.receive({
      type: "session.output_transcript.delta",
      delta: "it now.",
    });
    expect(transcriptsOf("output")).toEqual(["out-1", "out-1"]);

    // The user speaks again: a fresh input utterance, and the next assistant
    // speech after it is a fresh output utterance too.
    harness.peerConnection.channel.receive({
      type: "session.input_transcript.delta",
      delta: "now search it",
    });
    expect(transcriptsOf("input")).toEqual(["in-1", "in-1", "in-2"]);
    harness.peerConnection.channel.receive({
      type: "session.output_transcript.delta",
      delta: "Done.",
    });
    expect(transcriptsOf("output")).toEqual(["out-1", "out-1", "out-2"]);
  });

  it("closes the accumulated input utterance at session.delegation.created", async () => {
    const harness = makeClient();
    await startToLive(harness);
    harness.peerConnection.channel.receive({
      type: "session.input_transcript.delta",
      delta: "open it",
    });
    // A real delegation announcement carries the delegation object.
    harness.peerConnection.channel.receive({
      type: "session.delegation.created",
      delegation: { id: "del_1", target: "responses" },
    });
    // The user interrupts with more speech after the delegation boundary.
    harness.peerConnection.channel.receive({
      type: "session.input_transcript.delta",
      delta: "actually wait",
    });

    const keys = harness.events
      .filter((event) => event.type === "transcript" && event.channel === "input")
      .map((event) => (event as { utterance: string }).utterance);
    expect(keys).toEqual(["in-1", "in-2"]);
  });

  it("shows typed text as its own input utterance after a successful send", async () => {
    const harness = makeClient();
    await startToLive(harness);
    harness.peerConnection.channel.receive({
      type: "session.input_transcript.delta",
      delta: "spoken words",
    });

    expect(harness.client.sendText?.("typed request")).toBe(true);

    const typed = harness.events.filter(
      (event) =>
        event.type === "transcript" && (event as { delta: string }).delta === "typed request",
    );
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({ channel: "input", utterance: "in-2" });
  });

  it("closes with session.close, waits for session.closed, then closes broker accounting", async () => {
    const harness = makeClient();
    await startToLive(harness);

    const closing = harness.client.close();
    expect(harness.peerConnection.channel.sentTypes()).toContain("session.close");
    expect(harness.client.getState()).toBe("closing");
    harness.peerConnection.channel.receive({
      type: "session.closed",
      usage: { input_tokens: 9, output_tokens: 3 },
    });
    await closing;

    expect(harness.client.getState()).toBe("closed");
    expect(harness.brokerState.closeRequests).toEqual(["live_sess_1"]);
    expect(harness.peerConnection.closed).toBe(true);
    const finalUsage = harness.events.filter((event) => event.type === "usage");
    expect(finalUsage.at(-1)).toMatchObject({ usage: { usage: { input_tokens: 9 } } });
  });

  it("closing after a server-side session.closed is idempotent and still reports usage", async () => {
    const harness = makeClient();
    await startToLive(harness);

    harness.peerConnection.channel.receive({ type: "session.closed" });
    expect(harness.client.getState()).toBe("closed");
    await harness.client.close();

    expect(harness.peerConnection.channel.sentTypes()).not.toContain("session.close");
    expect(harness.brokerState.closeRequests).toEqual(["live_sess_1"]);
    expect(harness.peerConnection.closed).toBe(true);
  });

  it("maps a broker mint rejection to the frozen error code", async () => {
    const brokerState = makeBrokerState();
    brokerState.mintError = { code: "insufficient_scope", message: "operate required" };
    const harness = makeClient({ brokerState });

    await expect(harness.client.start()).rejects.toMatchObject({
      code: "insufficient_scope",
      message: "operate required",
    });
    expect(harness.client.getState()).toBe("error");
    const mintError = harness.events.find((event) => event.type === "error");
    expect(mintError).toMatchObject({ error: { code: "insufficient_scope" } });
    expect(harness.peerConnection.closed).toBe(true);
  });

  it("maps transport loss to environment_unreachable", async () => {
    const harness = makeClient();
    await startToLive(harness);

    harness.peerConnection.failConnection();
    expect(harness.client.getState()).toBe("error");
    const transportError = harness.events.find((event) => event.type === "error");
    expect(transportError).toMatchObject({ error: { code: "environment_unreachable" } });
  });

  it("reports executor failures as tool output instead of wedging the batch", async () => {
    const harness = makeClient();
    await startToLive(harness);
    harness.executorError = new Error("environment unreachable");

    receiveDelegationEvent(harness, "del_1", {
      type: "response.created",
      response: { id: "resp_1" },
    });
    receiveDelegationEvent(
      harness,
      "del_1",
      functionCallDone({ callId: "call_9", name: "voice.readThread" }),
    );
    receiveDelegationEvent(harness, "del_1", responseCompleted("resp_1"));
    await flushMicrotasks();

    const outputs = outputItems(harness);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.item.call_id).toBe("call_9");
    expect(JSON.parse(outputs[0]!.item.output)).toEqual({
      error: { code: "partial_failure", message: "environment unreachable" },
    });
    expect(continuationCount(harness)).toBe(1);
  });

  it("keeps one continuation when a mixed batch has both successes and failures", async () => {
    // Fail only the second call.
    const harness = makeClient();
    await startToLive(harness);
    const mixedExecutor = {
      execute: (name: string, input: unknown) => {
        harness.executorCalls.push({ name, input });
        if (name === "voice.readThread") {
          return Promise.reject(new Error("boom"));
        }
        return Promise.resolve({ ok: true });
      },
    } as unknown as VoiceLiveToolExecutor;
    const racer = makeClient({ executor: mixedExecutor });
    await startToLive(racer);

    receiveDelegationEvent(racer, "del_1", {
      type: "response.created",
      response: { id: "resp_1" },
    });
    receiveDelegationEvent(
      racer,
      "del_1",
      functionCallDone({ callId: "call_1", name: "voice.searchThreads" }),
    );
    receiveDelegationEvent(
      racer,
      "del_1",
      functionCallDone({ callId: "call_2", name: "voice.readThread" }),
    );
    receiveDelegationEvent(racer, "del_1", responseCompleted("resp_1"));
    await flushMicrotasks();

    const outputs = outputItems(racer);
    expect(outputs).toHaveLength(2);
    expect(JSON.parse(outputs[0]!.item.output)).toEqual({ ok: true });
    expect(JSON.parse(outputs[1]!.item.output)).toEqual({
      error: { code: "partial_failure", message: "boom" },
    });
    expect(continuationCount(racer)).toBe(1);
  });

  it("answers with explicit error outputs when no executor is configured", async () => {
    const harness = makeClient({ executor: "none" });
    await startToLive(harness);

    receiveDelegationEvent(harness, "del_1", {
      type: "response.created",
      response: { id: "resp_1" },
    });
    receiveDelegationEvent(
      harness,
      "del_1",
      functionCallDone({ callId: "call_2", name: "voice.searchThreads" }),
    );
    receiveDelegationEvent(harness, "del_1", responseCompleted("resp_1"));
    await flushMicrotasks();

    const outputs = outputItems(harness);
    expect(outputs).toHaveLength(1);
    expect(JSON.parse(outputs[0]!.item.output)).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(continuationCount(harness)).toBe(1);
  });

  it("suppresses pending batch submission across a session-close race", async () => {
    const harness = makeClient();
    await startToLive(harness);

    receiveDelegationEvent(harness, "del_1", {
      type: "response.created",
      response: { id: "resp_1" },
    });
    receiveDelegationEvent(
      harness,
      "del_1",
      functionCallDone({ callId: "call_1", name: "voice.searchThreads" }),
    );

    // The user hangs up while the batch is still pending.
    const closing = harness.client.close();
    expect(harness.client.getState()).toBe("closing");
    harness.peerConnection.channel.receive({
      type: "session.closed",
      usage: { input_tokens: 1 },
    });
    await closing;
    expect(harness.client.getState()).toBe("closed");

    // The completion arrives after the session already closed: no submission,
    // no continuation, and no duplicate broker accounting.
    receiveDelegationEvent(harness, "del_1", responseCompleted("resp_1"));
    await flushMicrotasks();

    expect(outputItems(harness)).toHaveLength(0);
    expect(continuationCount(harness)).toBe(0);
    expect(sentEvents(harness).map((event) => event.type)).toEqual(["session.close"]);
    expect(harness.brokerState.closeRequests).toEqual(["live_sess_1"]);
  });

  it("suppresses the continuation when completion lands mid-close", async () => {
    const harness = makeClient();
    await startToLive(harness);

    receiveDelegationEvent(harness, "del_1", {
      type: "response.created",
      response: { id: "resp_1" },
    });
    receiveDelegationEvent(
      harness,
      "del_1",
      functionCallDone({ callId: "call_1", name: "voice.searchThreads" }),
    );

    const closing = harness.client.close();
    receiveDelegationEvent(harness, "del_1", responseCompleted("resp_1"));
    harness.peerConnection.channel.receive({ type: "session.closed" });
    await closing;
    await flushMicrotasks();

    expect(outputItems(harness)).toHaveLength(0);
    expect(continuationCount(harness)).toBe(0);
  });

  it("ignores malformed channel payloads without crashing", async () => {
    const harness = makeClient();
    await startToLive(harness);

    harness.peerConnection.channel.receive("not json at all");
    harness.peerConnection.channel.receive({ noType: true });

    expect(harness.client.getState()).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Start/close races (parent check 4, correction 3): real createVoiceLiveClient
// with injected boundaries — deferred mint, manual channel/pc fakes.
// ---------------------------------------------------------------------------

interface GatedMintHarness {
  readonly peerConnection: FakePeerConnection;
  readonly brokerState: FakeBrokerState;
  readonly events: Array<VoiceLiveClientEvent>;
  readonly states: Array<string>;
  client: ReturnType<typeof createVoiceLiveClient>;
  resolveMint: (created?: VoiceBrokerSessionCreated) => void;
}

/** A client whose broker mint stays pending until resolveMint(). */
const makeGatedMintClient = (): GatedMintHarness => {
  const peerConnection = new FakePeerConnection();
  const brokerState = makeBrokerState();
  const events: Array<VoiceLiveClientEvent> = [];
  const states: Array<string> = [];
  let mintResolver: ((created: VoiceBrokerSessionCreated) => void) | undefined;
  const harness: GatedMintHarness = {
    peerConnection,
    brokerState,
    events,
    states,
    client: undefined as never,
    resolveMint: (created) => {
      mintResolver?.(created ?? brokerState.mintResult);
      mintResolver = undefined;
    },
  };
  const broker = {
    ...makeBroker(brokerState),
    mintSession: async (request: VoiceBrokerSessionRequest) => {
      brokerState.mintRequests.push(request);
      return new Promise<VoiceBrokerSessionCreated>((resolve) => {
        mintResolver = resolve;
      });
    },
  };
  harness.client = createVoiceLiveClient({
    broker,
    createPeerConnection: () => peerConnection,
  });
  harness.client.onEvent((event) => {
    events.push(event);
    if (event.type === "state") {
      states.push(event.state);
    }
  });
  return harness;
};

describe("live client start/close races", () => {
  it("a late mint after close never establishes a session and still settles broker accounting", async () => {
    const harness = makeGatedMintClient();
    const started = harness.client.start();
    await flushMicrotasks();
    expect(harness.states.at(-1)).toBe("minting");

    // The user closes while the mint is pending.
    const closePromise = harness.client.close();
    await flushMicrotasks();
    expect(harness.states).toContain("closing");

    // The mint resolves after close: no connecting state, no live session.
    harness.resolveMint({ sessionId: VoiceSessionId.make("live_late_1"), sdp: "late-sdp" });
    await expect(started).rejects.toMatchObject({ code: "invalid_request" });
    await flushMicrotasks();

    // The minted session is not orphaned: the broker accounting settles for
    // it even though close() ran before the mint resolved.
    expect(harness.brokerState.closeRequests).toContain("live_late_1" as never);

    // The peer connection is released.
    expect(harness.peerConnection.closed).toBe(true);

    // close() itself completes: the cancellation path unblocks its waiter.
    harness.peerConnection.channel.onclose?.();
    await closePromise;
    expect(harness.states.at(-1)).toBe("closed");
    expect(harness.client.getState()).toBe("closed");
  });

  it("close during the live wait settles start() when the server confirms closure", async () => {
    const harness = makeGatedMintClient();
    const started = harness.client.start();
    await flushMicrotasks();
    harness.resolveMint();
    await flushMicrotasks();
    // start() is now waiting for session.started.
    expect(harness.states.at(-1)).toBe("connecting");

    const closePromise = harness.client.close();
    await flushMicrotasks();

    // The server confirms the close: start() must settle (reject), never hang.
    harness.peerConnection.channel.receive({ type: "session.closed" });
    await expect(started).rejects.toMatchObject({ code: "invalid_request" });
    await closePromise;
    expect(harness.states.at(-1)).toBe("closed");
    expect(harness.brokerState.closeRequests).toContain("live_sess_1" as never);
  });

  it("close during the connecting phase settles start() without hanging", async () => {
    const harness = makeGatedMintClient();
    // Gate setRemoteDescription so start() sits between mint and the live wait.
    let releaseRemote: (() => void) | undefined;
    const originalSetRemote = harness.peerConnection.setRemoteDescription.bind(
      harness.peerConnection,
    );
    harness.peerConnection.setRemoteDescription = async (
      description: VoiceLiveSessionDescription,
    ) => {
      await new Promise<void>((resolve) => {
        releaseRemote = resolve;
      });
      await originalSetRemote(description);
    };
    const started = harness.client.start();
    await flushMicrotasks();
    harness.resolveMint();
    await flushMicrotasks();

    const closePromise = harness.client.close();
    await flushMicrotasks();
    releaseRemote?.();
    await expect(started).rejects.toMatchObject({ code: "invalid_request" });

    // close() completes through the server confirmation.
    harness.peerConnection.channel.receive({ type: "session.closed" });
    await closePromise;
    expect(harness.states.at(-1)).toBe("closed");
  });
});
