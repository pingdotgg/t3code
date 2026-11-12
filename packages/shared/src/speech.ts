import {
  CLOUD_SPEECH_PROVIDER_NAMES,
  type CloudSpeechProvider,
  SPEECH_MAX_OPTIONS_BYTES,
  type SpeechCustomWords,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeOptions = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechTranscriptionOptions));
const encodeOptions = Schema.encodeSync(Schema.fromJsonString(SpeechTranscriptionOptions));

export function cloudSpeechDisclosure(provider: CloudSpeechProvider, environment: string) {
  return provider === "openrouter"
    ? `After you stop, ${environment} sends the recording to OpenRouter. OpenRouter chooses who runs your model. T3 requests zero data retention; your OpenRouter account may allow safety retention.`
    : `After you stop, ${environment} sends your recording and vocabulary hints, including project names, to ${CLOUD_SPEECH_PROVIDER_NAMES[provider]}.`;
}

// Only offer explicit hints understood by all cloud APIs; other languages can still be detected.
export const cloudSpeechLanguages = {
  supportsLanguageDetection: true,
  languages:
    "ar bg ca cs da de el en es fa fi fr hi hr hu id it ja ko mk ms nl pl pt ro ru sk sv th tr uk ur vi zh".split(
      " ",
    ),
};

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

/**
 * The model first-run setup offers: the selected one, else a recommended one, else any that the
 * server would really transcribe the person's language with. Without a language hint,
 * offer only the selected model, without a recommendation.
 */
export function chooseSetupSpeechModel<
  Model extends {
    readonly id: string;
    readonly languages: readonly string[];
    readonly supportsLanguageDetection: boolean;
    readonly recommended: boolean;
  },
>(
  models: readonly Model[],
  input: {
    readonly selectedModelId: string;
    readonly intent: string;
    readonly preferred: readonly string[];
  },
) {
  if (input.intent === "auto" && input.preferred.length === 0) {
    const model = models.find(({ id }) => id === input.selectedModelId);
    return model && { model, language: null };
  }
  for (const language of input.intent === "auto" ? input.preferred : [input.intent]) {
    const capable = models.filter((model) => {
      const effective = effectiveSpeechLanguage(model, input.intent);
      return effective === language || (effective === "auto" && model.languages.includes(language));
    });
    const model =
      capable.find(({ id }) => id === input.selectedModelId) ??
      capable.find(({ recommended }) => recommended) ??
      capable[0];
    if (model) return { model, language };
  }
  return undefined;
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
