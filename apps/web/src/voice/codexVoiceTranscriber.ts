import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
} from "@t3tools/client-runtime/voice-input";
import * as Effect from "effect/Effect";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import type { ComposerVoiceTranscriber } from "./composerVoiceSession";

/**
 * Codex voice transcription over the environment HTTP API.
 *
 * Reconciled server contract (`packages/contracts/src/voice.ts`,
 * `apps/server/src/voice/`):
 * - `POST /api/voice/transcribe` takes the raw recording bytes
 *   (`VoiceAudioPayload`, content type `audio/webm`) and returns
 *   `{ transcript: string }`. No provider id or mime field: v1 always uses
 *   the ambient Codex subscription.
 * - `GET /api/voice/availability` returns `{ codexVoiceAvailable: boolean }`
 *   (see `codexVoiceAvailability.ts`).
 * - Errors: BadRequest (empty/oversize) / Forbidden (Codex rejected the
 *   request, points at `codex login`) / InternalServerError, plus
 *   VoiceProviderUnsupportedError for non-Codex drivers.
 *
 * Language is auto-detected end to end: nothing sends a locale, and the
 * browser locale below only feeds local insert-spacing rules.
 */

function voiceErrorMessage(cause: unknown): string {
  if (cause instanceof VoiceTranscriptionError) return cause.message;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim().length > 0
  ) {
    return cause.message;
  }
  return "Voice transcription failed.";
}

function browserLocale(): string {
  return typeof navigator === "undefined" || typeof navigator.language !== "string"
    ? "en"
    : navigator.language;
}

function runWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfVoiceTranscriptionAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createCodexVoiceTranscriber(): ComposerVoiceTranscriber {
  return async (audio, { signal }) => {
    throwIfVoiceTranscriptionAborted(signal);
    const bytes = new Uint8Array(await audio.arrayBuffer());
    const transcript = await runWithAbort(
      runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.voice.transcribe({ payload: bytes, headers: {} }).pipe(
              Effect.map((result) => result.transcript),
              Effect.mapError(
                (cause) =>
                  new VoiceTranscriptionError("transcription-failed", voiceErrorMessage(cause)),
              ),
            ),
          ),
        ),
      ).catch((error: unknown) => {
        throw error instanceof VoiceTranscriptionError
          ? error
          : new VoiceTranscriptionError("transcription-failed", voiceErrorMessage(error));
      }),
      signal,
    );
    return { text: transcript, locale: browserLocale() };
  };
}
