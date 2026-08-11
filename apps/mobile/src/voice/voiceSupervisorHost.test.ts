import type { SupervisorProposalHandle } from "@t3tools/client-runtime/operations/thread-supervisor";
import type {
  VoiceSupervisorToolName,
  VoiceToolResult,
  VoiceToolResultMap,
  VoiceToolsController,
} from "@t3tools/client-runtime/operations/voice-supervisor-tools";
import type { VoiceSupervisorStateProjector } from "@t3tools/client-runtime/voice/voice-supervisor-host";
import type {
  RealtimeTransportConnectInput,
  RealtimeTransportController,
} from "@t3tools/client-runtime/voice/realtime-transport";
import { describe, expect, it, vi } from "vite-plus/test";

import { createMobileVoiceSupervisorHostController } from "./voiceSupervisorHost";

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000000"),
  getRandomBytes: vi.fn((byteLength: number) => new Uint8Array(byteLength)),
}));

vi.mock("./realtimeSession", () => ({
  createMobileRealtimeSessionController: vi.fn(),
}));

class FakeTransport implements RealtimeTransportController {
  readonly connect = vi.fn((input: RealtimeTransportConnectInput) => {
    this.input = input;
    return { generation: 9, ready: new Promise<void>(() => undefined) };
  });
  readonly setMuted = vi.fn();
  readonly sendSessionUpdate = vi.fn();
  readonly sendToolOutputs = vi.fn();
  readonly dispose = vi.fn();
  input: RealtimeTransportConnectInput | null = null;
}

function stateProjector(): VoiceSupervisorStateProjector {
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

function tools(): VoiceToolsController {
  function invoke<Name extends VoiceSupervisorToolName>(
    _name: Name,
    _value: unknown,
  ): Promise<VoiceToolResultMap[Name]>;
  function invoke(_name: string, _value: unknown): Promise<VoiceToolResult>;
  function invoke() {
    return Promise.resolve({ status: "unknown-tool" as const });
  }
  return {
    definitions: [],
    invoke,
    getConfirmationPayloadLocally: () => ({ status: "proposal-not-found" }),
    cancelProposalLocally: () => ({ status: "cancelled" }),
    confirmProposalLocally: async (_handle: SupervisorProposalHandle) => ({
      status: "proposal-not-found",
    }),
  };
}

describe("mobile voice supervisor host adapter", () => {
  it("does not create a native transport until explicit start and disposes it once", () => {
    const transport = new FakeTransport();
    const createTransport = vi.fn(() => transport);
    const controller = createMobileVoiceSupervisorHostController({
      state: stateProjector(),
      createTransport,
    });

    expect(createTransport).not.toHaveBeenCalled();
    controller.start({
      voice: "marin",
      getClientSecret: async () => ({
        clientSecret: "ek_mobile",
        expiresAt: 2_000_000_000,
        sessionId: "session-mobile",
      }),
      createToolsController: tools,
    });

    expect(createTransport).toHaveBeenCalledOnce();
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(transport.setMuted).toHaveBeenCalledWith(true);
    controller.stop();
    controller.stop();
    expect(transport.dispose).toHaveBeenCalledOnce();
  });

  it("preserves transient peer disconnected and terminates closed connections", () => {
    const state = stateProjector();
    const transport = new FakeTransport();
    const controller = createMobileVoiceSupervisorHostController({
      state,
      createTransport: () => transport,
    });
    controller.start({
      voice: "cedar",
      getClientSecret: async () => ({
        clientSecret: "ek_mobile",
        expiresAt: 2_000_000_000,
        sessionId: "session-mobile",
      }),
      createToolsController: tools,
    });

    transport.input?.onTransportState?.({ generation: 9, state: "disconnected" });
    expect(state.failSession).not.toHaveBeenCalled();
    expect(transport.dispose).not.toHaveBeenCalled();

    transport.input?.onTransportState?.({ generation: 9, state: "closed" });
    expect(state.failSession).toHaveBeenCalledWith(
      1,
      "The voice connection closed.",
      expect.any(Number),
    );
    expect(transport.dispose).toHaveBeenCalledOnce();
  });
});
