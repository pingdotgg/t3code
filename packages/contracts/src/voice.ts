import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Cap for one-shot dictation audio, enforced against the exact byte length. */
export const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;

export const VOICE_TRANSCRIBE_PATH = "/api/voice/transcribe";
export const VOICE_AVAILABILITY_PATH = "/api/voice/availability";

/** Desktop recorders emit webm/opus; Safari falls back to mp4. Both ride the same endpoint. */
export const VOICE_TRANSCRIBE_CONTENT_TYPE = "audio/webm";

/** MIME type carried in `x-voice-mime-type` so the server forwards Safari mp4 correctly. */
export const VOICE_TRANSCRIBE_MIME_TYPE_HEADER = "x-voice-mime-type";

export const VOICE_TRANSCRIBE_DEFAULT_MIME_TYPE = "audio/webm";

/** Normalizes a recorder/blob MIME to the upstream set; unknown/empty falls back to webm. */
export function normalizeVoiceAudioMimeType(mimeType: string | null | undefined): string {
  const base = (mimeType ?? "").split(";")[0]?.trim().toLowerCase();
  return base === "audio/mp4" ? "audio/mp4" : VOICE_TRANSCRIBE_DEFAULT_MIME_TYPE;
}

/** Upstream filename matching the normalized MIME (`recording.mp4` for Safari, else webm). */
export function voiceAudioFileNameForMimeType(mimeType: string | null | undefined): string {
  return normalizeVoiceAudioMimeType(mimeType) === "audio/mp4" ? "recording.mp4" : "recording.webm";
}

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
