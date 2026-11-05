// @effect-diagnostics globalFetch:off - speech calls OpenRouter from Promise boundaries like model downloads.
import type { EnvironmentSpeechCloudModel } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const OPENROUTER_API = "https://openrouter.ai/api/v1";
const SAMPLE_RATE = 16_000;
// OpenRouter's upstream providers time out after 60 seconds per request.
const TRANSCRIPTION_TIMEOUT_MS = 90_000;
const CATALOG_TIMEOUT_MS = 15_000;

/** Sorted first while OpenRouter lists them; never a list of their own. */
const PREFERRED_MODEL_IDS = [
  "google/gemini-3.5-transcribe",
  "microsoft/mai-transcribe-2",
  "meta/muse-voice-transcribe-1.0",
];

const OpenRouterFailure = Schema.Literals(["key_invalid", "credits", "failed"]);
type OpenRouterFailure = typeof OpenRouterFailure.Type;

export class OpenRouterSpeechError extends Schema.TaggedError<OpenRouterSpeechError>()(
  "OpenRouterSpeechError",
  { failure: OpenRouterFailure, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const failureFor = (status: number): OpenRouterFailure =>
  status === 401 || status === 403 ? "key_invalid" : status === 402 ? "credits" : "failed";

async function failedResponse(response: Response, operation: string) {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") detail = body.error.message;
  } catch {
    // A non-JSON error body says nothing more than the status.
  }
  return new OpenRouterSpeechError({
    failure: failureFor(response.status),
    detail: `OpenRouter ${operation} failed with status ${response.status}${detail ? `: ${detail}` : ""}`,
  });
}

const withTimeout = (signal: AbortSignal | undefined, milliseconds: number) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(milliseconds)])
    : AbortSignal.timeout(milliseconds);

/** Live models first in OpenRouter's order, with preferred models moved ahead when listed. */
function orderSpeechCloudModels<Model extends { readonly id: string }>(
  models: ReadonlyArray<Model>,
): Model[] {
  const preferred = PREFERRED_MODEL_IDS.flatMap((id) => models.filter((model) => model.id === id));
  return [...preferred, ...models.filter((model) => !PREFERRED_MODEL_IDS.includes(model.id))];
}

export function parseSpeechCloudModels(body: unknown): EnvironmentSpeechCloudModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data))
    throw new OpenRouterSpeechError({
      failure: "failed",
      detail: "OpenRouter returned an unexpected model list",
    });
  return orderSpeechCloudModels(
    data.flatMap((entry: Record<string, unknown>) => {
      const pricing = entry.pricing as Record<string, unknown> | undefined;
      if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 200) return [];
      return [
        {
          id: entry.id,
          name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
          description: typeof entry.description === "string" ? entry.description : "",
          pricing: {
            prompt: typeof pricing?.prompt === "string" ? pricing.prompt : "0",
            completion: typeof pricing?.completion === "string" ? pricing.completion : "0",
          },
        },
      ];
    }),
  );
}

export async function fetchSpeechCloudModels(signal?: AbortSignal) {
  const response = await fetch(`${OPENROUTER_API}/models?output_modalities=transcription`, {
    signal: withTimeout(signal, CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await failedResponse(response, "model listing");
  return parseSpeechCloudModels(await response.json());
}

/** Rejects a key OpenRouter does not accept before it is saved. */
export async function verifyOpenRouterKey(apiKey: string, signal?: AbortSignal) {
  const response = await fetch(`${OPENROUTER_API}/key`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: withTimeout(signal, CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await failedResponse(response, "key check");
}

/** 16-bit PCM WAV: half the size of float samples and accepted by every provider. */
export function encodeSpeechWav(pcm: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let index = 0; index < pcm.length; index++) {
    const sample = Math.max(-1, Math.min(1, pcm[index]!));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

export async function transcribeWithOpenRouter(input: {
  readonly apiKey: string;
  readonly modelId: string;
  readonly pcm: Float32Array;
  readonly language: string | undefined;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const response = await fetch(`${OPENROUTER_API}/audio/transcriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      "x-title": "T3 Code",
    },
    body: JSON.stringify({
      model: input.modelId,
      input_audio: {
        data: Buffer.from(encodeSpeechWav(input.pcm)).toString("base64"),
        format: "wav",
      },
      ...(input.language ? { language: input.language } : {}),
    }),
    signal: withTimeout(input.signal, TRANSCRIPTION_TIMEOUT_MS),
  });
  if (!response.ok) throw await failedResponse(response, "transcription");
  const body = (await response.json()) as { text?: unknown };
  if (typeof body.text !== "string")
    throw new OpenRouterSpeechError({
      failure: "failed",
      detail: "OpenRouter returned no transcript",
    });
  return body.text;
}
