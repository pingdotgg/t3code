// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - streams verified model downloads with Node APIs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

const WHISPER_LANGUAGES = [
  "en",
  "zh",
  "de",
  "es",
  "ru",
  "ko",
  "fr",
  "ja",
  "pt",
  "tr",
  "pl",
  "ca",
  "nl",
  "ar",
  "sv",
  "it",
  "id",
  "hi",
  "fi",
  "vi",
  "he",
  "uk",
  "el",
  "ms",
  "cs",
  "ro",
  "da",
  "hu",
  "ta",
  "no",
  "th",
  "ur",
  "hr",
  "bg",
  "lt",
  "la",
  "mi",
  "ml",
  "cy",
  "sk",
  "te",
  "fa",
  "lv",
  "bn",
  "sr",
  "az",
  "sl",
  "kn",
  "et",
  "mk",
  "br",
  "eu",
  "is",
  "hy",
  "ne",
  "mn",
  "bs",
  "kk",
  "sq",
  "sw",
  "gl",
  "mr",
  "pa",
  "si",
  "km",
  "sn",
  "yo",
  "so",
  "af",
  "oc",
  "ka",
  "be",
  "tg",
  "sd",
  "gu",
  "am",
  "yi",
  "lo",
  "uz",
  "fo",
  "ht",
  "ps",
  "tk",
  "nn",
  "mt",
  "sa",
  "lb",
  "my",
  "bo",
  "tl",
  "mg",
  "as",
  "tt",
  "haw",
  "ln",
  "ha",
  "ba",
  "jw",
  "su",
] as const;

export type SpeechModel = {
  readonly id: string;
  readonly revision: string;
  readonly name: string;
  readonly description: string;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
  readonly languages: readonly string[];
  readonly accuracy: number;
  readonly speed: number;
  readonly recommended: boolean;
};

export const SPEECH_MODELS = [
  {
    id: "handy-computer/canary-180m-flash-gguf",
    revision: "b147f9dc52b59f0998e410540a84727bd86457fd",
    name: "Canary 180M Flash",
    description: "Small, fast transcription for English, German, Spanish, and French.",
    filename: "canary-180m-flash-Q8_0.gguf",
    size: 218_447_552,
    sha256: "e13c7f5d0952b056a027cfffec13e3a3a134d1608babed24f983568f141e297c",
    languages: ["en", "de", "es", "fr"],
    accuracy: 88,
    speed: 98,
    recommended: true,
  },
  {
    id: "handy-computer/parakeet-unified-en-0.6b-gguf",
    revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
    name: "Parakeet Unified EN 0.6B",
    description: "Fast, accurate English transcription.",
    filename: "parakeet-unified-en-0.6b-Q8_0.gguf",
    size: 731_357_568,
    sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
    languages: ["en"],
    accuracy: 90,
    speed: 79,
    recommended: true,
  },
  {
    id: "handy-computer/moonshine-tiny-gguf",
    revision: "f5c11906eba3f44cf305eed30feb9cbfb0b4b9d0",
    name: "Moonshine Tiny",
    description: "Compact English transcription for lower-powered machines.",
    filename: "moonshine-tiny-Q8_0.gguf",
    size: 35_466_912,
    sha256: "2fd348d7b38f97d309cc3ec6848f3f57f537b80244950f07d2637e463f95a3a1",
    languages: ["en"],
    accuracy: 74,
    speed: 100,
    recommended: false,
  },
  {
    id: "handy-computer/whisper-tiny-gguf",
    revision: "6687f30c99641ee265df421e582354adbc8848fc",
    name: "Whisper Tiny",
    description: "Very fast transcription across 99 languages.",
    filename: "whisper-tiny-Q8_0.gguf",
    size: 45_981_088,
    sha256: "325b9c7997cd1eff81ef709d55766565e71be696130cc3a3d444713798706834",
    languages: WHISPER_LANGUAGES,
    accuracy: 61,
    speed: 100,
    recommended: false,
  },
  {
    id: "handy-computer/whisper-base-gguf",
    revision: "e0f69524f648720eca44c024d1d0dbb7027d1fa0",
    name: "Whisper Base",
    description: "Balanced multilingual transcription across 99 languages.",
    filename: "whisper-base-Q8_0.gguf",
    size: 84_962_880,
    sha256: "81c069428bc8a24551a8169cf31cf09bcfd9d4cf50389ae281323c9aa9648c81",
    languages: WHISPER_LANGUAGES,
    accuracy: 71,
    speed: 99,
    recommended: false,
  },
] as const satisfies readonly SpeechModel[];

export const DEFAULT_SPEECH_MODEL_ID = "handy-computer/parakeet-unified-en-0.6b-gguf";
export const getSpeechModel = (modelId: string): SpeechModel | undefined =>
  SPEECH_MODELS.find((model) => model.id === modelId);
export const speechModelPath = (directory: string, model: SpeechModel): string =>
  NodePath.join(directory, model.filename);

async function hasExpectedModel(directory: string, model: SpeechModel): Promise<boolean> {
  const path = speechModelPath(directory, model);
  const stat = await NodeFSP.stat(path).catch(() => null);
  if (stat?.size !== model.size) return false;
  const digest = NodeCrypto.createHash("sha256");
  try {
    for await (const chunk of NodeFS.createReadStream(path)) digest.update(chunk);
    return digest.digest("hex") === model.sha256;
  } catch {
    return false;
  }
}

export async function isSpeechModelReady(directory: string, model: SpeechModel): Promise<boolean> {
  const stat = await NodeFSP.stat(speechModelPath(directory, model)).catch(() => null);
  return stat?.isFile() === true && stat.size === model.size;
}

export async function downloadSpeechModel(
  directory: string,
  model: SpeechModel,
  signal?: AbortSignal,
  onProgress?: (downloaded: number) => void,
): Promise<string> {
  const finalPath = speechModelPath(directory, model);
  signal?.throwIfAborted();
  await NodeFSP.mkdir(directory, { recursive: true });
  if (await hasExpectedModel(directory, model)) return finalPath;
  const partialPath = `${finalPath}.${NodeCrypto.randomUUID()}.part`;
  const url = `https://huggingface.co/${model.id}/resolve/${model.revision}/${model.filename}`;
  try {
    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok || !response.body)
      throw new Error(`speech model download failed with status ${response.status}`);
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
    if (contentLength !== null && Number.isFinite(contentLength) && contentLength !== model.size)
      throw new Error(
        `speech model download size mismatch: expected ${model.size}, got ${contentLength}`,
      );
    const digest = NodeCrypto.createHash("sha256");
    let downloaded = 0;
    const verify = new NodeStream.Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > model.size)
          return callback(new Error("speech model download exceeded expected size"));
        digest.update(chunk);
        onProgress?.(downloaded);
        callback(null, chunk);
      },
    });
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body),
      verify,
      NodeFS.createWriteStream(partialPath, { mode: 0o600 }),
      { signal },
    );
    if (downloaded !== model.size || digest.digest("hex") !== model.sha256)
      throw new Error("speech model verification failed");
    await NodeFSP.rm(finalPath, { force: true });
    await NodeFSP.rename(partialPath, finalPath);
    return finalPath;
  } catch (error) {
    await NodeFSP.rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export const removeSpeechModel = (directory: string, model: SpeechModel): Promise<void> =>
  NodeFSP.rm(speechModelPath(directory, model), { force: true });
