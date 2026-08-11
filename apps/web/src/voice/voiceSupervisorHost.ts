import { createThreadSupervisorCore } from "@t3tools/client-runtime/operations/thread-supervisor";
import {
  createVoiceToolsController,
  type VoiceToolsController,
} from "@t3tools/client-runtime/operations/voice-supervisor-tools";
import {
  createVoiceSupervisorHostController as createSharedVoiceSupervisorHostController,
  type VoiceSupervisorHostController as SharedVoiceSupervisorHostController,
  type VoiceSupervisorStateProjector,
} from "@t3tools/client-runtime/voice/voice-supervisor-host";
import type { RealtimeTransportController } from "@t3tools/client-runtime/voice/realtime-transport";
import type { RealtimeVoice } from "@t3tools/contracts";

import { randomHex } from "../lib/utils";
import { createRealtimeSessionController, type RealtimeSessionController } from "./realtimeSession";

export {
  buildVoiceSupervisorSessionUpdate,
  MAX_VOICE_TRANSCRIPT_CHARS,
  voiceCredentialSessionError,
  type VoiceSupervisorConfirmation,
  type VoiceSupervisorConfirmationPreview,
  type VoiceSupervisorHostSnapshot,
  type VoiceSupervisorStateProjector,
} from "@t3tools/client-runtime/voice/voice-supervisor-host";

export interface VoiceSupervisorHostStartInput {
  readonly audioElement: HTMLAudioElement;
  readonly voice: RealtimeVoice;
  readonly getClientSecret: Parameters<RealtimeSessionController["connect"]>[0]["getClientSecret"];
  readonly createToolsController: () => VoiceToolsController;
}

export interface VoiceSupervisorHostController extends Omit<
  SharedVoiceSupervisorHostController,
  "start"
> {
  readonly start: (input: VoiceSupervisorHostStartInput) => number;
}

type VoiceSupervisorTimer = ReturnType<typeof setTimeout>;

export interface VoiceSupervisorHostDependencies {
  readonly state: VoiceSupervisorStateProjector;
  readonly createTransport?: () => RealtimeSessionController;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => VoiceSupervisorTimer;
  readonly cancelScheduled?: (handle: VoiceSupervisorTimer) => void;
}

export function bindRealtimeSessionAudio(
  controller: RealtimeSessionController,
  audioElement: HTMLAudioElement,
): RealtimeTransportController {
  return {
    connect: (input) => controller.connect({ ...input, audioElement }),
    setMuted: (muted) => controller.setMuted(muted),
    sendSessionUpdate: (session) => controller.sendSessionUpdate(session),
    sendToolOutputs: (batch) => controller.sendToolOutputs(batch),
    dispose: () => controller.dispose(),
  };
}

export function createBrowserVoiceSupervisorTransport(
  audioElement: HTMLAudioElement,
): RealtimeTransportController {
  return bindRealtimeSessionAudio(createRealtimeSessionController(), audioElement);
}

export function createVoiceSupervisorHostController(
  dependencies: VoiceSupervisorHostDependencies,
): VoiceSupervisorHostController {
  const {
    createTransport,
    now,
    schedule = (callback, delayMs) => setTimeout(callback, delayMs),
    cancelScheduled = (handle) => clearTimeout(handle),
    state,
  } = dependencies;
  const controller = createSharedVoiceSupervisorHostController({
    state,
    ...(now === undefined ? {} : { now }),
    schedule: (callback, delayMs) => {
      const handle = schedule(callback, delayMs);
      return () => cancelScheduled(handle);
    },
  });
  return {
    ...controller,
    start: ({ audioElement, ...input }) =>
      controller.start({
        ...input,
        createTransport: () =>
          createTransport === undefined
            ? createBrowserVoiceSupervisorTransport(audioElement)
            : bindRealtimeSessionAudio(createTransport(), audioElement),
      }),
  };
}

export function createDefaultVoiceToolsController(
  repository: Parameters<typeof createVoiceToolsController>[0]["repository"],
): VoiceToolsController {
  let sequence = 0;
  const core = createThreadSupervisorCore({
    now: Date.now,
    makeOpaqueId: (kind) => `${kind}-${randomHex(16)}-${++sequence}`,
  });
  return createVoiceToolsController({ core, repository });
}
