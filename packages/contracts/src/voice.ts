import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Cap for one-shot dictation audio, enforced against the exact byte length. */
export const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;

export const VOICE_TRANSCRIBE_PATH = "/api/voice/transcribe";
export const VOICE_AVAILABILITY_PATH = "/api/voice/availability";

/** Desktop recorders emit webm/opus; v1 forwards it with auto-detect (no language hint). */
export const VOICE_TRANSCRIBE_CONTENT_TYPE = "audio/webm";

/** Raw recording bytes for POST /api/voice/transcribe. */
export const VoiceAudioPayload = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({ contentType: VOICE_TRANSCRIBE_CONTENT_TYPE }),
);
export type VoiceAudioPayload = typeof VoiceAudioPayload.Type;

export const VoiceTranscribeResponse = Schema.Struct({
  transcript: Schema.String,
});
export type VoiceTranscribeResponse = typeof VoiceTranscribeResponse.Type;

export const VoiceAvailabilityResponse = Schema.Struct({
  codexVoiceAvailable: Schema.Boolean,
});
export type VoiceAvailabilityResponse = typeof VoiceAvailabilityResponse.Type;

/** Explicit unsupported marker for non-Codex providers; the mic stays visible but disabled. */
export class VoiceProviderUnsupportedError extends Schema.TaggedErrorClass<VoiceProviderUnsupportedError>()(
  "VoiceProviderUnsupportedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(VoiceProviderUnsupportedError)(this, { status: 400 });
  }
}

/** v1 supports the Codex subscription only (`codex`; `claudeAgent` counts as unsupported). */
export const isVoiceSupportedDriver = (driver: string): boolean => driver === "codex";

/** Bounded unsupported message naming configured drivers, never credential material. */
export const voiceUnsupportedMessage = (configuredDrivers: ReadonlyArray<string>): string => {
  const unsupported = configuredDrivers.filter((driver) => !isVoiceSupportedDriver(driver));
  const detail = unsupported.length > 0 ? unsupported.join(", ") : "none configured";
  return `Voice dictation supports Codex only in v1 (unsupported: ${detail}).`;
};
