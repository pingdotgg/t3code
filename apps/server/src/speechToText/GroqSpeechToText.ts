// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetchInEffect:off
import { SpeechToTextError, type SpeechToTextTranscribeInput } from "@t3tools/contracts";
import type { ServerSettings } from "@t3tools/contracts/settings";
import { Buffer } from "node:buffer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const GROQ_TRANSCRIPTIONS_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MAX_AUDIO_BYTES = 100 * 1024 * 1024;

const GroqTranscriptionResponse = Schema.Struct({
  text: Schema.String,
});
const decodeGroqTranscriptionResponse = Schema.decodeUnknownEffect(GroqTranscriptionResponse);

function makeSpeechToTextError(detail: string, options?: { status?: number; cause?: unknown }) {
  return new SpeechToTextError({
    detail,
    ...(options?.status !== undefined ? { status: options.status } : {}),
    ...(options?.cause !== undefined ? { cause: options.cause } : {}),
  });
}

function decodeAudioBase64(input: string): Buffer {
  const normalized = input.replace(/\s/g, "");
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("Audio payload is not valid base64.");
  }
  return Buffer.from(normalized, "base64");
}

async function readResponseBodySafely(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function transcribeSpeechWithGroq(input: {
  readonly request: SpeechToTextTranscribeInput;
  readonly settings: ServerSettings;
}): Effect.Effect<
  { readonly text: string; readonly model: ServerSettings["speechToText"]["groqModel"] },
  SpeechToTextError
> {
  return Effect.gen(function* () {
    const groqApiKey = input.settings.speechToText.groqApiKey.trim();
    if (!groqApiKey) {
      return yield* makeSpeechToTextError(
        "Configure a Groq API key in Settings before using voice input.",
      );
    }

    const audioBytes = yield* Effect.try({
      try: () => decodeAudioBase64(input.request.audioBase64),
      catch: (cause) => makeSpeechToTextError("Failed to decode recorded audio.", { cause }),
    });

    if (audioBytes.byteLength === 0) {
      return yield* makeSpeechToTextError("Recorded audio was empty.");
    }
    if (audioBytes.byteLength > GROQ_MAX_AUDIO_BYTES) {
      return yield* makeSpeechToTextError(
        "Recorded audio is larger than Groq's 100 MB upload limit.",
      );
    }

    const model = input.settings.speechToText.groqModel;
    const body = new FormData();
    body.append(
      "file",
      new Blob([audioBytes], { type: input.request.mimeType }),
      input.request.fileName,
    );
    body.append("model", model);
    body.append("response_format", "json");

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(GROQ_TRANSCRIPTIONS_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqApiKey}`,
          },
          body,
        }),
      catch: (cause) => makeSpeechToTextError("Failed to reach Groq transcription API.", { cause }),
    });

    if (!response.ok) {
      const responseBody = yield* Effect.promise(() => readResponseBodySafely(response));
      const suffix = responseBody.trim().length > 0 ? ` ${responseBody.trim()}` : "";
      return yield* makeSpeechToTextError(`Groq transcription failed.${suffix}`, {
        status: response.status,
      });
    }

    const json = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => makeSpeechToTextError("Groq returned invalid JSON.", { cause }),
    });
    const transcript = yield* decodeGroqTranscriptionResponse(json).pipe(
      Effect.mapError((cause) =>
        makeSpeechToTextError("Groq response did not include transcript text.", { cause }),
      ),
    );

    return { text: transcript.text.trim(), model };
  });
}
