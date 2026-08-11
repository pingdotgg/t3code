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

import { randomHex } from "../lib/uuid";
import { createMobileRealtimeSessionController } from "./realtimeSession";

export {
  voiceCredentialSessionError,
  type VoiceSupervisorConfirmation,
  type VoiceSupervisorConfirmationPreview,
  type VoiceSupervisorHostSnapshot,
} from "@t3tools/client-runtime/voice/voice-supervisor-host";

export interface MobileVoiceSupervisorHostStartInput {
  readonly voice: RealtimeVoice;
  readonly getClientSecret: Parameters<
    RealtimeTransportController["connect"]
  >[0]["getClientSecret"];
  readonly createToolsController: () => VoiceToolsController;
}

export interface MobileVoiceSupervisorHostController extends Omit<
  SharedVoiceSupervisorHostController,
  "start"
> {
  readonly start: (input: MobileVoiceSupervisorHostStartInput) => number;
}

type VoiceSupervisorTimer = ReturnType<typeof setTimeout>;

export interface MobileVoiceSupervisorHostDependencies {
  readonly state: VoiceSupervisorStateProjector;
  readonly createTransport?: () => RealtimeTransportController;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => VoiceSupervisorTimer;
  readonly cancelScheduled?: (handle: VoiceSupervisorTimer) => void;
}

export function createMobileVoiceSupervisorHostController(
  dependencies: MobileVoiceSupervisorHostDependencies,
): MobileVoiceSupervisorHostController {
  const {
    createTransport = createMobileRealtimeSessionController,
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
    start: (input) => controller.start({ ...input, createTransport }),
  };
}

export function createDefaultMobileVoiceToolsController(
  repository: Parameters<typeof createVoiceToolsController>[0]["repository"],
): VoiceToolsController {
  let sequence = 0;
  const core = createThreadSupervisorCore({
    now: Date.now,
    makeOpaqueId: (kind) => `${kind}-${randomHex(16)}-${++sequence}`,
  });
  return createVoiceToolsController({ core, repository });
}
