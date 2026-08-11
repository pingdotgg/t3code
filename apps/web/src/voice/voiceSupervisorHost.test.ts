import type { SupervisorProposalHandle } from "@t3tools/client-runtime/operations/thread-supervisor";
import type {
  VoiceSupervisorToolName,
  VoiceToolResult,
  VoiceToolResultMap,
  VoiceToolsController,
} from "@t3tools/client-runtime/operations/voice-supervisor-tools";
import {
  buildVoiceSupervisorSessionUpdate as buildSharedVoiceSupervisorSessionUpdate,
  MAX_VOICE_TRANSCRIPT_CHARS as SHARED_MAX_VOICE_TRANSCRIPT_CHARS,
} from "@t3tools/client-runtime/voice/voice-supervisor-host";
import { describe, expect, it, vi } from "@effect/vitest";

import type { RealtimeSessionConnectInput, RealtimeSessionController } from "./realtimeSession";
import {
  bindRealtimeSessionAudio,
  buildVoiceSupervisorSessionUpdate,
  createBrowserVoiceSupervisorTransport,
  createVoiceSupervisorHostController,
  MAX_VOICE_TRANSCRIPT_CHARS,
  type VoiceSupervisorStateProjector,
} from "./voiceSupervisorHost";

class FakeBrowserTransport implements RealtimeSessionController {
  readonly connect = vi.fn((input: RealtimeSessionConnectInput) => {
    this.input = input;
    return { generation: 7, ready: new Promise<void>(() => undefined) };
  });
  readonly setMuted = vi.fn();
  readonly sendSessionUpdate = vi.fn();
  readonly sendToolOutputs = vi.fn();
  readonly dispose = vi.fn();
  input: RealtimeSessionConnectInput | null = null;
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

function makeTools(): VoiceToolsController {
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

describe("voice supervisor web adapter", () => {
  it("binds the exact browser audio element and preserves transport method ownership", () => {
    const browser = new FakeBrowserTransport();
    const audioElement = Object.create(null) as HTMLAudioElement;
    const bound = bindRealtimeSessionAudio(browser, audioElement);
    const input = {
      getClientSecret: async () => ({
        clientSecret: "ek_test",
        expiresAt: 2_000_000_000,
        sessionId: "session-test",
      }),
    };

    bound.connect(input);
    bound.setMuted(true);
    bound.sendSessionUpdate({ type: "realtime" });
    bound.sendToolOutputs({
      outputs: [{ eventId: "event-output", callId: "call-1", output: { status: "ok" } }],
      responseCreateEventId: "event-continue",
    });
    bound.dispose();

    expect(browser.input).toEqual({ ...input, audioElement });
    expect(browser.setMuted).toHaveBeenCalledWith(true);
    expect(browser.sendSessionUpdate).toHaveBeenCalledOnce();
    expect(browser.sendToolOutputs).toHaveBeenCalledOnce();
    expect(browser.dispose).toHaveBeenCalledOnce();
  });

  it("preserves the web start API when a browser transport factory is injected", () => {
    const browser = new FakeBrowserTransport();
    const createTransport = vi.fn(() => browser);
    const controller = createVoiceSupervisorHostController({
      state: makeState(),
      createTransport,
    });
    const audioElement = Object.create(null) as HTMLAudioElement;

    controller.start({
      audioElement,
      voice: "cedar",
      getClientSecret: async () => ({
        clientSecret: "ek_test",
        expiresAt: 2_000_000_000,
        sessionId: "session-test",
      }),
      createToolsController: makeTools,
    });

    expect(createTransport).toHaveBeenCalledOnce();
    expect(browser.input?.audioElement).toBe(audioElement);
    expect(browser.setMuted).toHaveBeenCalledWith(true);
    controller.stop();
    expect(browser.dispose).toHaveBeenCalledOnce();
  });

  it("creates the default browser transport without touching media before connect", () => {
    const audioElement = Object.create(null) as HTMLAudioElement;
    const transport = createBrowserVoiceSupervisorTransport(audioElement);

    expect(() => transport.dispose()).not.toThrow();
  });

  it("re-exports the shared session policy and transcript bound", () => {
    expect(buildVoiceSupervisorSessionUpdate).toBe(buildSharedVoiceSupervisorSessionUpdate);
    expect(MAX_VOICE_TRANSCRIPT_CHARS).toBe(SHARED_MAX_VOICE_TRANSCRIPT_CHARS);
  });
});
