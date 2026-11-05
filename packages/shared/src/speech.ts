import {
  SPEECH_MAX_OPTIONS_BYTES,
  type SpeechCustomWords,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeOptions = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechTranscriptionOptions));
const encodeOptions = Schema.encodeSync(Schema.fromJsonString(SpeechTranscriptionOptions));

/** Resolve the language the model can produce from the requested language. */
export function effectiveSpeechLanguage(
  model: { readonly languages: readonly string[]; readonly supportsLanguageDetection: boolean },
  intent: string,
): string {
  if (model.languages.length === 1) return model.languages[0]!;
  if (intent !== "auto" && model.languages.includes(intent)) return intent;
  if (model.supportsLanguageDetection) return "auto";
  return model.languages.find((language) => language === "en") ?? model.languages[0] ?? "auto";
}

const vocabularyKey = (value: string) => value.trim().normalize("NFC").toLocaleLowerCase();

/**
 * Project spellings win over personal ones. Hint terms, such as the project name or the
 * correction cue, come first so the 100-entry wire limit cannot drop them.
 */
export function resolveSpeechVocabulary(input: {
  readonly personal: SpeechCustomWords;
  readonly project: SpeechCustomWords;
  readonly hints?: ReadonlyArray<string>;
}): SpeechCustomWords {
  const known = new Set(
    [...input.project, ...input.personal].flatMap(({ term, aliases }) =>
      [term, ...aliases].map(vocabularyKey),
    ),
  );
  // A hint that is already a dictionary entry keeps that entry and its aliases in place.
  const hints = (input.hints ?? []).flatMap((hint) => {
    const term = hint.replace(/\s+/g, " ").trim();
    return term.length > 0 && term.length <= 50 && !known.has(vocabularyKey(term))
      ? [{ term, aliases: [] }]
      : [];
  });
  const seen = new Set<string>();
  return [...hints, ...input.project, ...input.personal]
    .flatMap(({ term, aliases }) => {
      if (seen.has(vocabularyKey(term))) return [];
      seen.add(vocabularyKey(term));
      const uniqueAliases = aliases.filter((alias) => {
        if (seen.has(vocabularyKey(alias))) return false;
        seen.add(vocabularyKey(alias));
        return true;
      });
      return [{ term, aliases: uniqueAliases }];
    })
    .slice(0, 100);
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
