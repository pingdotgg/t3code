import type { SpeechEndpointConfig } from "@t3tools/contracts";

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TRANSCRIPT_LENGTH = 100_000;

function encodeWav(pcm: Float32Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, buffer.byteLength - 8, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, pcm.length * 2, true);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = pcm[index]!;
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32_768 : 32_767)), true);
  }
  return bytes;
}

/** HTTP adapter: the owning SpeechService validates audio and consent before calling it. */
export async function transcribeSpeechEndpoint(input: {
  readonly endpoint: SpeechEndpointConfig;
  readonly pcm: Float32Array;
  readonly language: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const body = new FormData();
  body.set("file", new Blob([encodeWav(input.pcm)], { type: "audio/wav" }), "recording.wav");
  body.set("model", input.endpoint.model);
  body.set("response_format", "json");
  if (input.language !== "auto") body.set("language", input.language);
  // @effect-diagnostics-next-line globalFetch:off - This Promise adapter preserves fetch's redirect rejection and AbortSignal; SpeechService owns the Effect boundary.
  const response = await fetch(input.endpoint.url, {
    method: "POST",
    body,
    headers: input.endpoint.apiKey ? { Authorization: `Bearer ${input.endpoint.apiKey}` } : {},
    redirect: "error",
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Speech endpoint returned HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error("Speech endpoint returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Speech endpoint response is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Speech endpoint must return a JSON object with a text field.");
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("text" in result) ||
    typeof result.text !== "string" ||
    result.text.length > MAX_TRANSCRIPT_LENGTH
  )
    throw new Error("Speech endpoint must return a JSON object with a text field.");
  return result.text;
}
