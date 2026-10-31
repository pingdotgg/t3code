import type { DictationModelId } from "@t3tools/contracts";
import { cleanWhisperText } from "./audio.ts";

type ResolveFile = (name: string) => string;

const parakeetConfig = (resolve: ResolveFile, _language: string) => ({
  transducer: {
    encoder: resolve("encoder.int8.onnx"),
    decoder: resolve("decoder.int8.onnx"),
    joiner: resolve("joiner.int8.onnx"),
  },
  tokens: resolve("tokens.txt"),
  modelType: "nemo_transducer",
});
const whisperConfig = (resolve: ResolveFile, language: string) => ({
  whisper: {
    encoder: resolve("turbo-encoder.int8.onnx"),
    decoder: resolve("turbo-decoder.int8.onnx"),
    language,
    task: "transcribe",
  },
  tokens: resolve("turbo-tokens.txt"),
});
const moonshineConfig = (resolve: ResolveFile, _language: string) => ({
  moonshine: {
    preprocessor: resolve("preprocess.onnx"),
    encoder: resolve("encode.int8.onnx"),
    uncachedDecoder: resolve("uncached_decode.int8.onnx"),
    cachedDecoder: resolve("cached_decode.int8.onnx"),
  },
  tokens: resolve("tokens.txt"),
});

const filesAt = (
  repository: string,
  revision: string,
  files: readonly { name: string; bytes: number; sha256: string }[],
) =>
  files.map((file) => ({
    ...file,
    url: `https://huggingface.co/csukuangfj/${repository}/resolve/${revision}/${file.name}`,
  }));

/** Pinned artifact sizes/hashes come from HF LFS metadata; regular token files also match their Git blob IDs. */
export const models = {
  "parakeet-v3": {
    label: "Parakeet v3",
    languages: "25 European languages",
    note: null,
    languageOptions: [],
    featureDim: 80,
    modelConfig: parakeetConfig,
    skipSilence: false,
    cleanText: (text: string) => text,
    files: filesAt(
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
      "2bda32ec70b097a55adaa07d9a7173915b43cc78",
      [
        {
          name: "encoder.int8.onnx",
          bytes: 652184281,
          sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
        },
        {
          name: "decoder.int8.onnx",
          bytes: 11845275,
          sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
        },
        {
          name: "joiner.int8.onnx",
          bytes: 6355277,
          sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
        },
        {
          name: "tokens.txt",
          bytes: 93939,
          sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
        },
      ],
    ),
  },
  "whisper-turbo": {
    label: "Whisper turbo",
    languages: "99 languages",
    // Measured 6 to 14 s from release to text on a 2 vCPU host.
    note: "Slow without a GPU",
    languageOptions: [
      { code: "en", label: "English" },
      { code: "nl", label: "Dutch" },
      { code: "de", label: "German" },
      { code: "fr", label: "French" },
      { code: "es", label: "Spanish" },
      { code: "it", label: "Italian" },
      { code: "pt", label: "Portuguese" },
      { code: "pl", label: "Polish" },
      { code: "sv", label: "Swedish" },
      { code: "da", label: "Danish" },
      { code: "no", label: "Norwegian" },
      { code: "fi", label: "Finnish" },
      { code: "cs", label: "Czech" },
      { code: "uk", label: "Ukrainian" },
      { code: "ru", label: "Russian" },
      { code: "tr", label: "Turkish" },
      { code: "ar", label: "Arabic" },
      { code: "he", label: "Hebrew" },
      { code: "hi", label: "Hindi" },
      { code: "ja", label: "Japanese" },
      { code: "ko", label: "Korean" },
      { code: "zh", label: "Chinese" },
      { code: "id", label: "Indonesian" },
      { code: "vi", label: "Vietnamese" },
      { code: "th", label: "Thai" },
      { code: "el", label: "Greek" },
      { code: "hu", label: "Hungarian" },
      { code: "ro", label: "Romanian" },
      { code: "bg", label: "Bulgarian" },
      { code: "hr", label: "Croatian" },
      { code: "sk", label: "Slovak" },
      { code: "sl", label: "Slovenian" },
      { code: "et", label: "Estonian" },
      { code: "lv", label: "Latvian" },
      { code: "lt", label: "Lithuanian" },
      { code: "fa", label: "Persian" },
      { code: "bn", label: "Bengali" },
      { code: "ta", label: "Tamil" },
      { code: "ur", label: "Urdu" },
      { code: "ms", label: "Malay" },
    ],
    featureDim: 128,
    modelConfig: whisperConfig,
    skipSilence: true,
    cleanText: cleanWhisperText,
    files: filesAt("sherpa-onnx-whisper-turbo", "2ca6ff69fc878651b770880507669577ac41c2ff", [
      {
        name: "turbo-encoder.int8.onnx",
        bytes: 674716297,
        sha256: "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b",
      },
      {
        name: "turbo-decoder.int8.onnx",
        bytes: 361080764,
        sha256: "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547",
      },
      {
        name: "turbo-tokens.txt",
        bytes: 816730,
        sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
      },
    ]),
  },
  "moonshine-base": {
    label: "Moonshine base",
    languages: "English only",
    note: null,
    languageOptions: [],
    featureDim: 80,
    modelConfig: moonshineConfig,
    skipSilence: false,
    cleanText: (text: string) => text,
    files: filesAt(
      "sherpa-onnx-moonshine-base-en-int8",
      "052b0798ad1bf046a140fdd4efcd9426530fa3f5",
      [
        {
          name: "preprocess.onnx",
          bytes: 14077290,
          sha256: "ffa630d395c5ccf76f5d4954be5b882df76aaf6491519ec01fd82ea7a3819fb2",
        },
        {
          name: "encode.int8.onnx",
          bytes: 50311494,
          sha256: "7e38770f776f2e5583a53b052936005df2ba5c833d7e09c2a5fd796b94bf73e2",
        },
        {
          name: "uncached_decode.int8.onnx",
          bytes: 122120451,
          sha256: "c01f4b35093bcac20d352d23a75a539e772964579f9d024a90e5e6f09cae9987",
        },
        {
          name: "cached_decode.int8.onnx",
          bytes: 99983837,
          sha256: "2db74e51cedf64a8b1be3c8192e0bb5e4923af0e90bd9e87f8e8771873f8ea03",
        },
        {
          name: "tokens.txt",
          bytes: 436688,
          sha256: "1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea",
        },
      ],
    ),
  },
} satisfies Record<
  DictationModelId,
  {
    label: string;
    languages: string;
    note: string | null;
    languageOptions: readonly { code: string; label: string }[];
    featureDim: number;
    modelConfig: (resolve: ResolveFile, language: string) => Readonly<Record<string, unknown>>;
    skipSilence: boolean;
    cleanText: (text: string) => string;
    files: readonly { name: string; bytes: number; sha256: string; url: string }[];
  }
>;

/** Invalid or unsupported selections have the same native representation as auto-detection. */
export function resolveLanguage(model: DictationModelId, language: string): string {
  return models[model].languageOptions.some((option) => option.code === language) ? language : "";
}

const runtimeVersion = "1.13.8";
const runtimeIntegrity: Readonly<Record<string, string>> = {
  "darwin-arm64":
    "FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==",
  "darwin-x64":
    "7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==",
  "linux-x64":
    "6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==",
  "linux-arm64":
    "Tlg7a70b/Wge3OF8IgTHF9jhSVCsLyKQKhwc4BsJ5A+dL/SrFtGBjzuHp4XeLhiiOT7afCxX5PdSn/D4c8Lnuw==",
  "win-x64":
    "oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==",
};

export function runtimeFor(platform: string, arch: string) {
  const target = `${platform === "win32" ? "win" : platform}-${arch}`;
  const integrity = runtimeIntegrity[target];
  if (!integrity) return null;
  const name = `sherpa-onnx-${target}`;
  return {
    directory: `${name}-${runtimeVersion}`,
    integrity,
    nativeFiles:
      platform === "darwin"
        ? [
            "sherpa-onnx.node",
            "libonnxruntime.dylib",
            "libsherpa-onnx-c-api.dylib",
            "libsherpa-onnx-cxx-api.dylib",
          ]
        : platform === "win32"
          ? [
              "sherpa-onnx.node",
              "onnxruntime.dll",
              "onnxruntime_providers_shared.dll",
              "sherpa-onnx-c-api.dll",
              "sherpa-onnx-cxx-api.dll",
            ]
          : [
              "sherpa-onnx.node",
              "libonnxruntime.so",
              "libsherpa-onnx-c-api.so",
              "libsherpa-onnx-cxx-api.so",
            ],
    url: `https://registry.npmjs.org/${name}/-/${name}-${runtimeVersion}.tgz`,
  };
}
