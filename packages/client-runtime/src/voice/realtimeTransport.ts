import type { VoiceRealtimeClientSecret } from "@t3tools/contracts";

import type { RealtimeFunctionCall, RealtimeServerEvent } from "./realtimeEvents.ts";

export const MAX_REALTIME_CLIENT_EVENT_ID_CHARS = 160;

export type RealtimeSessionErrorReason =
  | "insecure_context"
  | "media_devices_unavailable"
  | "microphone_access_failed"
  | "client_secret_failed"
  | "voice_not_configured"
  | "voice_credential_rejected"
  | "voice_model_unavailable"
  | "voice_rate_limited"
  | "voice_environment_timeout"
  | "voice_upstream_failed"
  | "client_secret_expired"
  | "negotiation_timeout"
  | "negotiation_failed"
  | "upstream_rejected"
  | "data_channel_failed"
  | "connection_failed"
  | "audio_playback_failed"
  | "not_ready"
  | "serialization_failed"
  | "aborted";

const ERROR_MESSAGES = {
  insecure_context: "Voice requires a secure connection.",
  media_devices_unavailable: "Microphone access is unavailable in this browser.",
  microphone_access_failed: "T3 Code could not access the microphone.",
  client_secret_failed: "T3 Code could not start a voice session.",
  voice_not_configured: "Configure an OpenAI API key for this environment before starting voice.",
  voice_credential_rejected: "OpenAI rejected this environment's API key.",
  voice_model_unavailable: "The OpenAI Realtime model is unavailable for this API key.",
  voice_rate_limited: "Voice is temporarily rate limited. Try again shortly.",
  voice_environment_timeout: "The voice host environment timed out while starting the session.",
  voice_upstream_failed: "OpenAI could not start the Realtime voice session.",
  client_secret_expired: "The voice session credential expired before it could be used.",
  negotiation_timeout: "The voice connection timed out while starting.",
  negotiation_failed: "T3 Code could not establish the voice connection.",
  upstream_rejected: "The voice provider rejected the connection.",
  data_channel_failed: "The voice control channel failed.",
  connection_failed: "The voice connection failed.",
  audio_playback_failed: "T3 Code could not play voice audio.",
  not_ready: "The voice session is not ready.",
  serialization_failed: "The voice message could not be prepared.",
  aborted: "The voice connection was cancelled.",
} as const satisfies Record<RealtimeSessionErrorReason, string>;

/** A deliberately redacted transport error safe to project into UI state. */
export class RealtimeSessionError extends Error {
  override readonly name = "RealtimeSessionError";
  readonly reason: RealtimeSessionErrorReason;
  readonly status?: number | undefined;

  constructor(reason: RealtimeSessionErrorReason, status?: number) {
    super(ERROR_MESSAGES[reason]);
    this.reason = reason;
    this.status = status;
  }
}

export type RealtimeTransportState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export interface RealtimeSessionUpdate {
  readonly type: "realtime";
  readonly [key: string]: unknown;
}

export interface RealtimeServerEventEnvelope {
  readonly generation: number;
  readonly event: RealtimeServerEvent;
}

export interface RealtimeFunctionCallEnvelope {
  readonly generation: number;
  readonly calls: ReadonlyArray<RealtimeFunctionCall>;
}

export interface RealtimeTransportStateEnvelope {
  readonly generation: number;
  readonly state: RealtimeTransportState;
  readonly error?: RealtimeSessionError;
}

export interface RealtimeSessionAttempt {
  readonly generation: number;
  readonly ready: Promise<void>;
}

export interface RealtimeTransportConnectInput {
  readonly getClientSecret: (signal: AbortSignal) => Promise<VoiceRealtimeClientSecret>;
  readonly onServerEvent?: (envelope: RealtimeServerEventEnvelope) => void;
  readonly onFunctionCalls?: (envelope: RealtimeFunctionCallEnvelope) => void;
  readonly onTransportState?: (envelope: RealtimeTransportStateEnvelope) => void;
}

/** Platform-neutral transport owned by the voice supervisor coordinator. */
export interface RealtimeTransportController {
  readonly connect: (input: RealtimeTransportConnectInput) => RealtimeSessionAttempt;
  readonly setMuted: (muted: boolean) => void;
  readonly sendSessionUpdate: (session: RealtimeSessionUpdate) => void;
  readonly sendToolOutputs: (batch: RealtimeToolOutputBatch) => void;
  readonly dispose: () => void;
}

export interface RealtimeToolOutput {
  readonly eventId: string;
  readonly callId: string;
  readonly output: unknown;
}

export interface RealtimeToolOutputBatch {
  readonly outputs: ReadonlyArray<RealtimeToolOutput>;
  readonly responseCreateEventId: string;
}

function encodeEvent(event: unknown): string {
  try {
    const encoded = JSON.stringify(event);
    if (encoded === undefined) throw new RealtimeSessionError("serialization_failed");
    return encoded;
  } catch {
    throw new RealtimeSessionError("serialization_failed");
  }
}

function validClientEventId(value: string): boolean {
  return (
    value.length > 0 && value.length <= MAX_REALTIME_CLIENT_EVENT_ID_CHARS && value.trim() === value
  );
}

export function serializeRealtimeSessionUpdate(session: RealtimeSessionUpdate): string {
  return encodeEvent({ type: "session.update", session });
}

/** Serializes the complete tool batch before a platform transport sends any event. */
export function serializeRealtimeToolOutputBatch(
  batch: RealtimeToolOutputBatch,
): ReadonlyArray<string> {
  const { outputs, responseCreateEventId } = batch;
  if (outputs.length === 0) return [];
  if (
    !validClientEventId(responseCreateEventId) ||
    outputs.some((output) => !validClientEventId(output.eventId))
  ) {
    throw new RealtimeSessionError("serialization_failed");
  }
  const serialized = outputs.map(({ eventId, callId, output }) => {
    try {
      return {
        eventId,
        callId,
        output: typeof output === "string" ? output : (JSON.stringify(output) ?? "null"),
      };
    } catch {
      throw new RealtimeSessionError("serialization_failed");
    }
  });

  return [
    ...serialized.map((output) =>
      encodeEvent({
        event_id: output.eventId,
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: output.callId,
          output: output.output,
        },
      }),
    ),
    encodeEvent({ event_id: responseCreateEventId, type: "response.create" }),
  ];
}
