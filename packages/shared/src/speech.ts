import {
  SPEECH_MAX_OPTIONS_BYTES,
  type SpeechCustomWords,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeOptions = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechTranscriptionOptions));
const encodeOptions = Schema.encodeSync(Schema.fromJsonString(SpeechTranscriptionOptions));

/** Project spellings take precedence. Request validation enforces the combined size limit. */
export function mergeSpeechCustomWords(
  personal: SpeechCustomWords,
  project: SpeechCustomWords,
): SpeechCustomWords {
  const seen = new Set<string>();
  const key = (value: string) => value.trim().normalize("NFC").toLocaleLowerCase();
  const words = [...project, ...personal].flatMap(({ term, aliases }) => {
    if (seen.has(key(term))) return [];
    seen.add(key(term));
    const uniqueAliases = aliases.filter((alias) => {
      if (seen.has(key(alias))) return false;
      seen.add(key(alias));
      return true;
    });
    return [{ term, aliases: uniqueAliases }];
  });
  return words;
}

/** Binary requests contain a four-byte JSON length, UTF-8 options, then unencoded PCM. */
export function encodeSpeechPcmRequest(
  pcm: Uint8Array,
  options: SpeechTranscriptionOptions,
): Uint8Array<ArrayBuffer> {
  const metadata = new TextEncoder().encode(encodeOptions(options));
  if (metadata.byteLength > SPEECH_MAX_OPTIONS_BYTES)
    throw new Error("Speech options are too large.");
  const body = new Uint8Array(4 + metadata.byteLength + pcm.byteLength);
  new DataView(body.buffer).setUint32(0, metadata.byteLength, true);
  body.set(metadata, 4);
  body.set(pcm, 4 + metadata.byteLength);
  return body;
}

export function decodeSpeechPcmRequest(body: Uint8Array) {
  if (body.byteLength < 4) throw new Error("Missing speech options.");
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true);
  if (length > SPEECH_MAX_OPTIONS_BYTES || 4 + length >= body.byteLength)
    throw new Error("Invalid speech options length.");
  const options = decodeOptions(
    new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(4, 4 + length)),
  );
  return { pcm: body.subarray(4 + length), options };
}
