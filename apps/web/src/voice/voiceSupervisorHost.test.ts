import {
  makeSupervisorTargetVersion,
  type SupervisorLocalConfirmationPayload,
  type SupervisorProposalHandle,
  type SupervisorTargetHandle,
} from "@t3tools/client-runtime/operations/thread-supervisor";
import { EnvironmentId, ProjectId, type VoiceRealtimeClientSecret } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";

import type { RealtimeServerEvent } from "./realtimeEvents";
import type {
  RealtimeSessionConnectInput,
  RealtimeSessionController,
  RealtimeSessionUpdate,
  RealtimeToolOutput,
  RealtimeToolOutputBatch,
  RealtimeTransportState,
} from "./realtimeSession";
import type {
  VoiceModelProposal,
  VoiceSupervisorToolName,
  VoiceToolResult,
  VoiceToolResultMap,
  VoiceToolsController,
} from "./voiceTools";
import {
  buildVoiceSupervisorSessionUpdate,
  createVoiceSupervisorHostController,
  voiceCredentialSessionError,
  type VoiceSupervisorStateProjector,
} from "./voiceSupervisorHost";

const CLIENT_SECRET: VoiceRealtimeClientSecret = {
  clientSecret: "ek_test",
  expiresAt: 2_000_000_000,
  sessionId: "session-secret",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeTransport implements RealtimeSessionController {
  readonly readiness = deferred<void>();
  readonly sessionUpdates: RealtimeSessionUpdate[] = [];
  readonly toolOutputBatches: ReadonlyArray<Omit<RealtimeToolOutput, "eventId">>[] = [];
  readonly sentBatches: RealtimeToolOutputBatch[] = [];
  readonly mutedAtSend: boolean[] = [];
  readonly muted: boolean[] = [];
  readonly dispose = vi.fn();
  input: RealtimeSessionConnectInput | null = null;

  connect(input: RealtimeSessionConnectInput) {
    this.input = input;
    return { generation: 41, ready: this.readiness.promise };
  }

  setMuted(muted: boolean) {
    this.muted.push(muted);
  }

  sendSessionUpdate(session: RealtimeSessionUpdate) {
    this.sessionUpdates.push(session);
  }

  sendToolOutputs(batch: RealtimeToolOutputBatch) {
    this.mutedAtSend.push(this.muted.at(-1) ?? false);
    this.sentBatches.push(batch);
    this.toolOutputBatches.push(batch.outputs.map(({ callId, output }) => ({ callId, output })));
  }

  emit(event: RealtimeServerEvent) {
    this.input?.onServerEvent?.({ generation: 41, event });
  }

  emitState(state: RealtimeTransportState) {
    this.input?.onTransportState?.({ generation: 41, state });
  }
}

function sessionCreated(id = "session-1"): RealtimeServerEvent {
  return { type: "session.created", event_id: "created-1", session: { id } };
}

function sessionUpdated(id = "session-1"): RealtimeServerEvent {
  return { type: "session.updated", event_id: "updated-1", session: { id } };
}

function responseDone(input: {
  readonly responseId: string;
  readonly calls: ReadonlyArray<{
    readonly callId: string;
    readonly name?: string;
    readonly arguments: string;
  }>;
  readonly eventId?: string;
}): RealtimeServerEvent {
  return {
    type: "response.done",
    event_id: input.eventId ?? `event-${input.responseId}`,
    response: {
      id: input.responseId,
      status: "completed",
      output: input.calls.map((call, index) => ({
        id: `item-${input.responseId}-${index}`,
        type: "function_call",
        call_id: call.callId,
        name: call.name ?? "list_projects",
        arguments: call.arguments,
        status: "completed",
      })),
    },
  };
}

function makeState(): VoiceSupervisorStateProjector {
  return {
    beginSession: vi.fn(),
    markConnected: vi.fn(),
    setMuted: vi.fn(),
    ingestEvent: vi.fn(),
    failSession: vi.fn(),
    endSession: vi.fn(),
    reset: vi.fn(),
  };
}

function makeTools(input?: {
  readonly invoke?: (name: string, value: unknown) => Promise<VoiceToolResult>;
  readonly payload?: SupervisorLocalConfirmationPayload;
}) {
  const invoke = vi.fn(input?.invoke ?? (async () => ({ status: "unknown-tool" as const })));
  function invokeController<Name extends VoiceSupervisorToolName>(
    name: Name,
    value: unknown,
  ): Promise<VoiceToolResultMap[Name]>;
  function invokeController(name: string, value: unknown): Promise<VoiceToolResult>;
  function invokeController(name: string, value: unknown) {
    return invoke(name, value);
  }
  const getConfirmationPayloadLocally = vi.fn((_handle: SupervisorProposalHandle) =>
    input?.payload
      ? ({ status: "pending", payload: input.payload } as const)
      : ({ status: "proposal-not-found" } as const),
  );
  const cancelProposalLocally = vi.fn(() => ({ status: "cancelled" as const }));
  const confirmProposalLocally = vi.fn(async () => ({
    status: "executed" as const,
    value: { receipt: "accepted" },
  }));
  return {
    controller: {
      definitions: [],
      invoke: invokeController,
      getConfirmationPayloadLocally,
      cancelProposalLocally,
      confirmProposalLocally,
    } satisfies VoiceToolsController,
    invoke,
    getConfirmationPayloadLocally,
    cancelProposalLocally,
    confirmProposalLocally,
  };
}

function harness(tools = makeTools()) {
  const transport = new FakeTransport();
  const state = makeState();
  const scheduled = new Map<
    ReturnType<typeof setTimeout>,
    { readonly callback: () => void; readonly delayMs: number }
  >();
  const controller = createVoiceSupervisorHostController({
    state,
    createTransport: () => transport,
    now: () => 123,
    schedule: (callback, delayMs) => {
      const handle = setTimeout(() => undefined, 0);
      clearTimeout(handle);
      scheduled.set(handle, { callback, delayMs });
      return handle;
    },
    cancelScheduled: (handle) => scheduled.delete(handle),
  });
  const generation = controller.start({
    audioElement: {} as HTMLAudioElement,
    voice: "cedar",
    getClientSecret: async () => CLIENT_SECRET,
    createToolsController: () => tools.controller,
  });
  const runScheduled = (delayMs: number) => {
    const matches = [...scheduled.entries()].filter(([, task]) => task.delayMs === delayMs);
    for (const [id, task] of matches) {
      scheduled.delete(id);
      task.callback();
    }
  };
  return { controller, generation, scheduled, runScheduled, state, tools, transport };
}

async function configure(transport: FakeTransport) {
  transport.emit(sessionCreated());
  transport.readiness.resolve();
  await Promise.resolve();
  transport.emit(sessionUpdated());
}

function proposal(handle: SupervisorProposalHandle): VoiceModelProposal {
  return {
    handle,
    action: "Start thread",
    summary: "Start Fix login",
    target: {
      handle: "target-1" as SupervisorTargetHandle,
      label: "T3 Code",
      availability: "live",
    },
    expiresAtEpochMs: 10_000,
  };
}

function localPayload(
  handle: SupervisorProposalHandle,
  preview: SupervisorLocalConfirmationPayload["preview"],
): SupervisorLocalConfirmationPayload {
  const modelProposal = proposal(handle);
  return {
    proposal: {
      ...modelProposal,
      target: { ...modelProposal.target, kind: "project" },
    },
    target: {
      kind: "project",
      environmentId: EnvironmentId.make("environment-test"),
      projectId: ProjectId.make("project-test"),
      version: makeSupervisorTargetVersion("1"),
    },
    preview,
  };
}

describe("voice supervisor host", () => {
  it("maps typed credential failures to honest redacted session errors", () => {
    expect(
      voiceCredentialSessionError({
        _tag: "EnvironmentVoiceUnavailableError",
        reason: "not_configured",
        traceId: "secret-trace",
      }),
    ).toMatchObject({ reason: "voice_not_configured" });
    expect(voiceCredentialSessionError({ _tag: "EnvironmentVoiceRateLimitedError" })).toMatchObject(
      { reason: "voice_rate_limited" },
    );
    expect(voiceCredentialSessionError(new Error("raw secret detail"))).toMatchObject({
      reason: "client_secret_failed",
      message: "T3 Code could not start a voice session.",
    });
  });

  it("waits for transport and session.created, sends one exact static config, then unmutes on matching ack", async () => {
    const { state, transport } = harness();
    expect(transport.muted).toEqual([true]);
    expect(state.setMuted).toHaveBeenCalledWith(1, true);

    transport.emit(sessionCreated());
    expect(transport.sessionUpdates).toEqual([]);
    transport.readiness.resolve();
    await Promise.resolve();

    expect(transport.sessionUpdates).toEqual([buildVoiceSupervisorSessionUpdate("cedar")]);
    const serialized = JSON.stringify(transport.sessionUpdates[0]);
    expect(serialized).toContain('"model":"gpt-realtime-2.1"');
    expect(serialized).toContain('"voice":"cedar"');
    expect(serialized).toContain('"transcription":{"model":"gpt-4o-mini-transcribe"}');
    expect(serialized).not.toContain("call_id");
    expect(serialized).toContain("untrusted data");
    expect(transport.muted).toEqual([true]);

    transport.emit(sessionUpdated("another-session"));
    expect(transport.muted).toEqual([true]);
    transport.emit(sessionUpdated());
    transport.emit(sessionUpdated());
    expect(transport.sessionUpdates).toHaveLength(1);
    expect(transport.muted).toEqual([true, false]);
    expect(state.markConnected).toHaveBeenCalledOnce();
  });

  it("ignores pre-configuration responses and injects the protocol call id over hostile arguments", async () => {
    const tools = makeTools();
    const { transport } = harness(tools);
    const event = responseDone({
      responseId: "response-1",
      calls: [{ callId: "canonical", arguments: '{"call_id":"spoof","limit":2}' }],
    });
    transport.emit(event);
    expect(tools.invoke).not.toHaveBeenCalled();

    await configure(transport);
    transport.emit(event);
    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(1));
    expect(tools.invoke).toHaveBeenCalledWith("list_projects", {
      call_id: "canonical",
      limit: 2,
    });
  });

  it("fails immediately on pre-ack and correlated continuation errors without exposing provider text", async () => {
    const beforeAck = harness();
    beforeAck.transport.emit({
      type: "error",
      event_id: "server-config-error",
      error: { message: "raw upstream credential detail" },
    });
    expect(beforeAck.state.failSession).toHaveBeenCalledWith(
      1,
      "The voice provider rejected the session configuration.",
      123,
    );
    expect(JSON.stringify(vi.mocked(beforeAck.state.failSession).mock.calls)).not.toContain(
      "credential detail",
    );

    const correlated = harness();
    await configure(correlated.transport);
    correlated.transport.emit(
      responseDone({
        responseId: "correlated-response",
        calls: [{ callId: "correlated-call", arguments: "{}" }],
      }),
    );
    await vi.waitFor(() => expect(correlated.transport.sentBatches).toHaveLength(1));
    const clientEventId = correlated.transport.sentBatches[0]?.responseCreateEventId;
    if (clientEventId === undefined) throw new Error("Expected a continuation event id.");
    correlated.transport.emit({
      type: "error",
      event_id: "server-tool-error",
      error: { event_id: clientEventId, message: "raw tool output rejection" },
    });
    expect(correlated.state.failSession).toHaveBeenCalledWith(
      1,
      "The voice provider rejected a tool continuation.",
      123,
    );
    expect(JSON.stringify(vi.mocked(correlated.state.failSession).mock.calls)).not.toContain(
      "tool output rejection",
    );
  });

  it("keeps an uncorrelated post-ack provider error recoverable", async () => {
    const setup = harness();
    await configure(setup.transport);
    setup.transport.emit({
      type: "error",
      event_id: "server-recoverable-error",
      error: { event_id: "unrelated-client-event", message: "upstream-only detail" },
    });

    expect(setup.state.failSession).not.toHaveBeenCalled();
    expect(setup.state.ingestEvent).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ type: "error" }),
      123,
    );
  });

  it("runs a response batch in parallel and emits one ordered continuation", async () => {
    const first = deferred<VoiceToolResult>();
    const second = deferred<VoiceToolResult>();
    const tools = makeTools({
      invoke: (name) => (name === "list_projects" ? first.promise : second.promise),
    });
    const { transport } = harness(tools);
    await configure(transport);
    transport.emit(
      responseDone({
        responseId: "parallel",
        calls: [
          { callId: "call-a", name: "list_projects", arguments: "{}" },
          { callId: "call-b", name: "list_threads", arguments: "{}" },
        ],
      }),
    );
    expect(tools.invoke).toHaveBeenCalledTimes(2);
    expect(transport.toolOutputBatches).toEqual([]);

    second.resolve({ status: "unavailable" });
    first.resolve({ status: "invalid-arguments" });
    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(1));
    expect(transport.toolOutputBatches[0]).toEqual([
      { callId: "call-a", output: { status: "invalid-arguments" } },
      { callId: "call-b", output: { status: "unavailable" } },
    ]);
    expect(transport.mutedAtSend).toEqual([true]);
    expect(transport.sentBatches[0]).toMatchObject({
      outputs: [
        { callId: "call-a", eventId: "t3-voice-1-1-output" },
        { callId: "call-b", eventId: "t3-voice-1-2-output" },
      ],
      responseCreateEventId: "t3-voice-1-3-continue",
    });
    expect(transport.muted.at(-1)).toBe(false);
  });

  it("deduplicates exact response replays and fails closed on changed cross-response call reuse", async () => {
    const tools = makeTools();
    const { state, transport } = harness(tools);
    await configure(transport);
    const first = responseDone({
      responseId: "response-a",
      calls: [{ callId: "call-a", arguments: '{"limit":1}' }],
    });
    transport.emit(first);
    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(1));
    transport.emit({ ...first, event_id: "replayed-event" });
    await Promise.resolve();
    expect(transport.toolOutputBatches).toHaveLength(1);

    const changed = responseDone({
      responseId: "response-b",
      calls: [{ callId: "call-a", arguments: '{"limit":2}' }],
    });
    transport.emit(changed);
    expect(state.failSession).toHaveBeenCalledWith(
      1,
      "The voice provider reused a tool call identifier.",
      123,
    );
    transport.emit({ ...changed, event_id: "changed-replay" });
    await Promise.resolve();
    expect(tools.invoke).toHaveBeenCalledTimes(1);
    expect(transport.toolOutputBatches).toHaveLength(1);
  });

  it("fails closed on exact call-id reuse in a different response without another output", async () => {
    const tools = makeTools();
    const { state, transport } = harness(tools);
    await configure(transport);
    transport.emit(
      responseDone({
        responseId: "first-response",
        calls: [{ callId: "reused-call", arguments: "{}" }],
      }),
    );
    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(1));

    transport.emit(
      responseDone({
        responseId: "second-response",
        calls: [{ callId: "reused-call", arguments: "{}" }],
      }),
    );

    expect(state.failSession).toHaveBeenCalledWith(
      1,
      "The voice provider reused a tool call identifier.",
      123,
    );
    expect(tools.invoke).toHaveBeenCalledOnce();
    expect(transport.toolOutputBatches).toHaveLength(1);
  });

  it("preserves user mute changes while every async tool batch remains effectively muted", async () => {
    const first = deferred<VoiceToolResult>();
    const second = deferred<VoiceToolResult>();
    const tools = makeTools({
      invoke: (name) => (name === "list_projects" ? first.promise : second.promise),
    });
    const { controller, transport } = harness(tools);
    await configure(transport);

    transport.emit(
      responseDone({
        responseId: "mute-first",
        calls: [{ callId: "mute-call-1", name: "list_projects", arguments: "{}" }],
      }),
    );
    controller.setMuted(true);
    expect(transport.muted.at(-1)).toBe(true);
    first.resolve({ status: "unknown-tool" });
    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(1));
    expect(transport.mutedAtSend[0]).toBe(true);
    expect(transport.muted.at(-1)).toBe(true);

    transport.emit(
      responseDone({
        responseId: "mute-second",
        calls: [{ callId: "mute-call-2", name: "list_threads", arguments: "{}" }],
      }),
    );
    controller.setMuted(false);
    expect(transport.muted.at(-1)).toBe(true);
    second.resolve({ status: "unknown-tool" });
    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(2));
    expect(transport.mutedAtSend[1]).toBe(true);
    expect(transport.muted.at(-1)).toBe(false);
  });

  it("does not release the microphone when the continuation batch cannot be sent", async () => {
    const setup = harness();
    await configure(setup.transport);
    vi.spyOn(setup.transport, "sendToolOutputs").mockImplementation(() => {
      throw new Error("channel write failed");
    });

    setup.transport.emit(
      responseDone({
        responseId: "failed-continuation",
        calls: [{ callId: "failed-call", arguments: "{}" }],
      }),
    );
    await vi.waitFor(() => expect(setup.state.failSession).toHaveBeenCalledOnce());

    expect(setup.transport.muted.at(-1)).toBe(true);
    expect(setup.transport.dispose).toHaveBeenCalledOnce();
    expect(setup.state.failSession).toHaveBeenCalledWith(
      1,
      "T3 Code could not continue after voice tool work.",
      123,
    );
  });

  it("fails closed when an existing response id is replayed with a new call", async () => {
    const tools = makeTools();
    const { state, transport } = harness(tools);
    await configure(transport);
    transport.emit(
      responseDone({
        responseId: "stable-response",
        calls: [{ callId: "known-call", arguments: "{}" }],
      }),
    );
    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(1));
    transport.emit(
      responseDone({
        responseId: "stable-response",
        calls: [{ callId: "new-call", arguments: "{}" }],
      }),
    );
    expect(tools.invoke).toHaveBeenCalledTimes(1);
    expect(state.failSession).toHaveBeenCalledWith(
      1,
      "The voice provider replayed a conflicting response.",
      123,
    );
    expect(transport.toolOutputBatches).toHaveLength(1);
  });

  it("rejects oversized response ids and tool metadata before invocation", async () => {
    const cases = [
      responseDone({
        responseId: "r".repeat(161),
        calls: [{ callId: "call", arguments: "{}" }],
      }),
      responseDone({
        responseId: "response",
        calls: [{ callId: "c".repeat(161), arguments: "{}" }],
      }),
      responseDone({
        responseId: "response",
        calls: [{ callId: "call", name: "n".repeat(129), arguments: "{}" }],
      }),
      responseDone({
        responseId: "response",
        calls: [{ callId: "call", arguments: `"${"x".repeat(16 * 1_024)}"` }],
      }),
    ];
    for (const event of cases) {
      const tools = makeTools();
      const { state, transport } = harness(tools);
      await configure(transport);
      transport.emit(event);
      expect(tools.invoke).not.toHaveBeenCalled();
      expect(transport.toolOutputBatches).toEqual([]);
      expect(state.failSession).toHaveBeenCalledOnce();
    }
  });

  it("rejects prototype-bearing JSON arguments before invoking a tool", async () => {
    const tools = makeTools();
    const { transport } = harness(tools);
    await configure(transport);
    transport.emit(
      responseDone({
        responseId: "unsafe-json",
        calls: [
          {
            callId: "unsafe-call",
            arguments: '{"__proto__":{"polluted":true}}',
          },
        ],
      }),
    );

    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(1));
    expect(tools.invoke).not.toHaveBeenCalled();
    expect(transport.toolOutputBatches[0]).toEqual([
      { callId: "unsafe-call", output: { status: "invalid-arguments" } },
    ]);
  });

  it("rejects oversized function-call batches before invocation", async () => {
    const tools = makeTools();
    const { state, transport } = harness(tools);
    await configure(transport);
    transport.emit(
      responseDone({
        responseId: "too-many",
        calls: Array.from({ length: 17 }, (_, index) => ({
          callId: `call-${index}`,
          arguments: "{}",
        })),
      }),
    );
    expect(tools.invoke).not.toHaveBeenCalled();
    expect(transport.toolOutputBatches).toEqual([]);
    expect(state.failSession).toHaveBeenCalledWith(
      1,
      "The voice provider returned too many tool calls at once.",
      123,
    );
  });

  it("does not spend the tool replay ledger on audio-only responses", async () => {
    const tools = makeTools();
    const { state, transport } = harness(tools);
    await configure(transport);
    for (let index = 0; index < 600; index += 1) {
      transport.emit(responseDone({ responseId: `audio-${index}`, calls: [] }));
    }
    expect(tools.invoke).not.toHaveBeenCalled();
    expect(state.failSession).not.toHaveBeenCalled();
  });

  it("collapses conflicting duplicate call ids within one response to one output", async () => {
    const tools = makeTools();
    const { state, transport } = harness(tools);
    await configure(transport);
    transport.emit(
      responseDone({
        responseId: "duplicate",
        calls: [
          { callId: "same-call", arguments: '{"limit":1}' },
          { callId: "same-call", arguments: '{"limit":2}' },
        ],
      }),
    );
    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(1));
    expect(tools.invoke).not.toHaveBeenCalled();
    expect(transport.toolOutputBatches[0]).toEqual([
      { callId: "same-call", output: { status: "call-id-conflict" } },
    ]);

    transport.emit(
      responseDone({
        responseId: "duplicate-reuse",
        calls: [{ callId: "same-call", arguments: "{}" }],
      }),
    );
    expect(state.failSession).toHaveBeenCalledWith(
      1,
      "The voice provider reused a tool call identifier.",
      123,
    );
    expect(tools.invoke).not.toHaveBeenCalled();
    expect(transport.toolOutputBatches).toHaveLength(1);
  });

  it("holds mutation output for the trusted local preview until confirmation", async () => {
    const handle = "proposal-1" as SupervisorProposalHandle;
    const trustedPayload = localPayload(handle, {
      operation: "start_thread",
      instruction: "Fix the login race",
      target: "T3 Code",
      title: "Fix login",
      model: "gpt-5.4",
      runtimeMode: "full-access",
      interactionMode: "default",
      workspace: {
        mode: "worktree",
        baseBranch: "main",
        startFromOrigin: true,
        runSetupScript: true,
      },
    });
    const tools = makeTools({
      payload: trustedPayload,
      invoke: async () => ({ status: "proposed", proposal: proposal(handle) }),
    });
    const { controller, generation, transport } = harness(tools);
    await configure(transport);
    transport.emit(
      responseDone({
        responseId: "proposal-response",
        calls: [{ callId: "proposal-call", name: "start_thread", arguments: "{}" }],
      }),
    );
    await vi.waitFor(() => expect(controller.getSnapshot().confirmations).toHaveLength(1));
    const confirmation = controller.getSnapshot().confirmations[0];
    expect(confirmation?.preview).toMatchObject({
      operation: "start_thread",
      instruction: "Fix the login race",
      target: "T3 Code",
    });
    expect(Object.isFrozen(confirmation)).toBe(true);
    expect(Object.isFrozen(confirmation?.preview)).toBe(true);
    if (confirmation?.preview.operation === "start_thread") {
      expect(Object.isFrozen(confirmation.preview.workspace)).toBe(true);
    }
    expect(transport.toolOutputBatches).toEqual([]);
    expect(transport.muted.at(-1)).toBe(true);

    controller.confirm(generation, "proposal-call");
    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(1));
    expect(tools.confirmProposalLocally).toHaveBeenCalledWith(handle);
    expect(transport.toolOutputBatches[0]?.[0]?.output).toEqual({
      status: "executed",
      value: { receipt: "accepted" },
    });
    expect(transport.mutedAtSend).toEqual([true]);
    expect(transport.muted.at(-1)).toBe(false);
  });

  it("rejects a mutation whose local frozen preview is not a known confirmation shape", async () => {
    const handle = "proposal-1" as SupervisorProposalHandle;
    const tools = makeTools({
      payload: localPayload(handle, { operation: "start_thread", target: "T3 Code" }),
      invoke: async () => ({ status: "proposed", proposal: proposal(handle) }),
    });
    const { controller, transport } = harness(tools);
    await configure(transport);
    transport.emit(
      responseDone({
        responseId: "bad-preview",
        calls: [{ callId: "proposal-call", name: "start_thread", arguments: "{}" }],
      }),
    );
    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(1));
    expect(controller.getSnapshot().confirmations).toEqual([]);
    expect(tools.cancelProposalLocally).toHaveBeenCalledWith(handle);
    expect(transport.toolOutputBatches[0]).toEqual([
      { callId: "proposal-call", output: { status: "unavailable" } },
    ]);
  });

  it("keeps the microphone held through a local denial and continues with that final result", async () => {
    const handle = "proposal-denied" as SupervisorProposalHandle;
    const tools = makeTools({
      payload: localPayload(handle, {
        operation: "interrupt_thread",
        target: "Fix voice · Laptop",
        hasActiveTurn: true,
      }),
      invoke: async () => ({ status: "proposed", proposal: proposal(handle) }),
    });
    const { controller, generation, transport } = harness(tools);
    await configure(transport);
    transport.emit(
      responseDone({
        responseId: "denied-proposal",
        calls: [{ callId: "denied-call", name: "interrupt_thread", arguments: "{}" }],
      }),
    );
    await vi.waitFor(() => expect(controller.getSnapshot().confirmations).toHaveLength(1));
    expect(transport.muted.at(-1)).toBe(true);

    controller.deny(generation, "denied-call");
    await vi.waitFor(() => expect(transport.toolOutputBatches).toHaveLength(1));
    expect(tools.cancelProposalLocally).toHaveBeenCalledWith(handle);
    expect(transport.toolOutputBatches[0]).toEqual([
      { callId: "denied-call", output: { status: "cancelled" } },
    ]);
    expect(transport.mutedAtSend).toEqual([true]);
    expect(transport.muted.at(-1)).toBe(false);
  });

  it("keeps recoverable disconnects alive but terminates and cancels on channel close", async () => {
    const handle = "proposal-1" as SupervisorProposalHandle;
    const tools = makeTools({
      payload: localPayload(handle, {
        operation: "start_thread",
        instruction: "Fix it",
        target: "T3 Code",
        title: "Fix it",
        model: "gpt-5.4",
        runtimeMode: "full-access",
        interactionMode: "default",
        workspace: {
          mode: "local",
          branch: "main",
          hasWorktreePath: false,
          runSetupScript: false,
        },
      }),
      invoke: async () => ({ status: "proposed", proposal: proposal(handle) }),
    });
    const { controller, state, transport } = harness(tools);
    await configure(transport);
    transport.emit(
      responseDone({
        responseId: "proposal-response",
        calls: [{ callId: "proposal-call", name: "start_thread", arguments: "{}" }],
      }),
    );
    await vi.waitFor(() => expect(controller.getSnapshot().confirmations).toHaveLength(1));
    transport.emitState("disconnected");
    expect(controller.getSnapshot().confirmations).toHaveLength(1);
    expect(tools.cancelProposalLocally).not.toHaveBeenCalled();

    transport.emitState("closed");
    expect(tools.cancelProposalLocally).toHaveBeenCalledWith(handle);
    expect(controller.getSnapshot().confirmations).toEqual([]);
    expect(state.failSession).toHaveBeenCalledWith(1, "The voice connection closed.", 123);
  });

  it("fails closed when new response or speech events overlap a pending tool batch", async () => {
    const overlappingEvents: RealtimeServerEvent[] = [
      {
        type: "response.created",
        event_id: "overlap-response",
        response: { id: "response-new", status: "in_progress" },
      },
      {
        type: "input_audio_buffer.speech_started",
        event_id: "overlap-speech",
        item_id: "item-new",
        audio_start_ms: 1,
      },
      responseDone({ responseId: "overlap-done", calls: [] }),
    ];

    for (const overlap of overlappingEvents) {
      const pending = deferred<VoiceToolResult>();
      const tools = makeTools({ invoke: async () => pending.promise });
      const { state, transport } = harness(tools);
      await configure(transport);
      transport.emit(
        responseDone({
          responseId: "held-response",
          calls: [{ callId: "held-call", arguments: "{}" }],
        }),
      );
      expect(transport.muted.at(-1)).toBe(true);
      transport.emit(overlap);
      expect(state.failSession).toHaveBeenCalledOnce();
      pending.resolve({ status: "unknown-tool" });
      await Promise.resolve();
      await Promise.resolve();
      expect(transport.toolOutputBatches).toEqual([]);
    }
  });

  it("coalesces transcript deltas and flushes final events synchronously", async () => {
    const { runScheduled, state, transport } = harness();
    await configure(transport);
    for (let index = 0; index < 100; index += 1) {
      transport.emit({
        type: "response.output_audio_transcript.delta",
        event_id: `delta-${index}`,
        response_id: "response-1",
        item_id: "item-1",
        delta: "x",
      });
    }
    const ingest = vi.mocked(state.ingestEvent);
    const deltaCallsBeforeFlush = ingest.mock.calls.filter(([, event]) =>
      event.type.endsWith("delta"),
    );
    expect(deltaCallsBeforeFlush).toHaveLength(0);
    runScheduled(80);
    const projectedDelta = ingest.mock.calls.find(
      ([, event]) => event.type === "response.output_audio_transcript.delta",
    )?.[1];
    expect(projectedDelta).toMatchObject({ delta: "x".repeat(100) });

    transport.emit({
      type: "response.output_audio_transcript.delta",
      event_id: "last-delta",
      response_id: "response-1",
      item_id: "item-1",
      delta: "ignored in favor of final",
    });
    transport.emit({
      type: "response.output_audio_transcript.done",
      event_id: "done-1",
      response_id: "response-1",
      item_id: "item-1",
      transcript: "Final transcript",
    });
    expect(ingest.mock.calls.at(-1)?.[1]).toMatchObject({
      type: "response.output_audio_transcript.done",
      transcript: "Final transcript",
    });
    const count = ingest.mock.calls.length;
    runScheduled(80);
    expect(ingest).toHaveBeenCalledTimes(count);
  });

  it("times out an unacknowledged handshake and ignores aborted ready rejection after stop", async () => {
    const missingCreated = harness();
    missingCreated.transport.readiness.resolve();
    await Promise.resolve();
    missingCreated.runScheduled(20_000);
    expect(missingCreated.transport.dispose).toHaveBeenCalledOnce();
    expect(missingCreated.state.failSession).toHaveBeenCalledWith(
      1,
      "Voice setup timed out before configuration completed.",
      123,
    );

    const missingUpdated = harness();
    missingUpdated.transport.emit(sessionCreated());
    missingUpdated.transport.readiness.resolve();
    await Promise.resolve();
    expect(missingUpdated.transport.sessionUpdates).toHaveLength(1);
    missingUpdated.runScheduled(20_000);
    expect(missingUpdated.state.failSession).toHaveBeenCalledWith(
      1,
      "Voice setup timed out before configuration completed.",
      123,
    );

    const aborted = harness();
    aborted.controller.stop();
    aborted.transport.readiness.reject(new Error("aborted secret"));
    await Promise.resolve();
    expect(aborted.state.failSession).not.toHaveBeenCalled();
    expect(aborted.state.endSession).toHaveBeenCalledOnce();
    expect([...aborted.scheduled.values()].some((task) => task.delayMs === 20_000)).toBe(false);
  });

  it("does not start the handshake timer while browser microphone permission is unresolved", async () => {
    const setup = harness();
    expect([...setup.scheduled.values()].some((task) => task.delayMs === 20_000)).toBe(false);
    setup.controller.stop();
  });

  it("clears and cancels a pending confirmation when replacing the active generation", async () => {
    const handle = "proposal-1" as SupervisorProposalHandle;
    const firstTools = makeTools({
      payload: localPayload(handle, {
        operation: "start_thread",
        instruction: "Fix it",
        target: "T3 Code",
        title: "Fix it",
        model: "gpt-5.4",
        runtimeMode: "full-access",
        interactionMode: "default",
        workspace: {
          mode: "local",
          branch: "main",
          hasWorktreePath: false,
          runSetupScript: false,
        },
      }),
      invoke: async () => ({ status: "proposed", proposal: proposal(handle) }),
    });
    const secondTools = makeTools();
    const firstTransport = new FakeTransport();
    const secondTransport = new FakeTransport();
    const transports = [firstTransport, secondTransport];
    const state = makeState();
    const controller = createVoiceSupervisorHostController({
      state,
      createTransport: () => transports.shift() ?? new FakeTransport(),
    });
    controller.start({
      audioElement: {} as HTMLAudioElement,
      voice: "marin",
      getClientSecret: async () => CLIENT_SECRET,
      createToolsController: () => firstTools.controller,
    });
    await configure(firstTransport);
    firstTransport.emit(
      responseDone({
        responseId: "proposal",
        calls: [{ callId: "call", name: "start_thread", arguments: "{}" }],
      }),
    );
    await vi.waitFor(() => expect(controller.getSnapshot().confirmations).toHaveLength(1));

    controller.start({
      audioElement: {} as HTMLAudioElement,
      voice: "cedar",
      getClientSecret: async () => CLIENT_SECRET,
      createToolsController: () => secondTools.controller,
    });
    expect(firstTools.cancelProposalLocally).toHaveBeenCalledWith(handle);
    expect(firstTransport.dispose).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().confirmations).toEqual([]);
    expect(state.endSession).toHaveBeenCalledWith(1, expect.any(Number));
    expect(secondTransport.input).not.toBeNull();

    controller.dispose();
    expect(secondTransport.dispose).toHaveBeenCalledOnce();
    expect(state.reset).toHaveBeenCalledOnce();
  });

  it("does not create a transport when tool construction fails", () => {
    const state = makeState();
    const createTransport = vi.fn(() => new FakeTransport());
    const controller = createVoiceSupervisorHostController({ state, createTransport });
    controller.start({
      audioElement: {} as HTMLAudioElement,
      voice: "marin",
      getClientSecret: async () => CLIENT_SECRET,
      createToolsController: () => {
        throw new Error("tools failed");
      },
    });
    expect(createTransport).not.toHaveBeenCalled();
    expect(controller.getSnapshot().confirmations).toEqual([]);
    expect(Object.isFrozen(controller.getSnapshot().confirmations)).toBe(true);
    expect(state.failSession).toHaveBeenCalledWith(
      1,
      "Voice tools could not be prepared.",
      expect.any(Number),
    );
  });

  it("cancels a proposal returned after replacement without publishing or writing into the successor", async () => {
    const handle = "late-proposal" as SupervisorProposalHandle;
    const lateInvoke = deferred<VoiceToolResult>();
    const firstTools = makeTools({
      payload: localPayload(handle, {
        operation: "interrupt_thread",
        target: "Fix voice · Laptop",
        hasActiveTurn: true,
      }),
      invoke: async () => lateInvoke.promise,
    });
    const secondTools = makeTools();
    const firstTransport = new FakeTransport();
    const secondTransport = new FakeTransport();
    const transports = [firstTransport, secondTransport];
    const controller = createVoiceSupervisorHostController({
      state: makeState(),
      createTransport: () => transports.shift() ?? new FakeTransport(),
    });
    controller.start({
      audioElement: {} as HTMLAudioElement,
      voice: "marin",
      getClientSecret: async () => CLIENT_SECRET,
      createToolsController: () => firstTools.controller,
    });
    await configure(firstTransport);
    firstTransport.emit(
      responseDone({
        responseId: "late-response",
        calls: [{ callId: "late-call", name: "interrupt_thread", arguments: "{}" }],
      }),
    );
    controller.start({
      audioElement: {} as HTMLAudioElement,
      voice: "cedar",
      getClientSecret: async () => CLIENT_SECRET,
      createToolsController: () => secondTools.controller,
    });
    lateInvoke.resolve({ status: "proposed", proposal: proposal(handle) });
    await vi.waitFor(() => expect(firstTools.cancelProposalLocally).toHaveBeenCalledWith(handle));
    expect(firstTools.cancelProposalLocally).toHaveBeenCalledOnce();
    expect(firstTransport.toolOutputBatches).toEqual([]);
    expect(secondTransport.toolOutputBatches).toEqual([]);
    expect(controller.getSnapshot().confirmations).toEqual([]);

    controller.dispose();
  });
});
