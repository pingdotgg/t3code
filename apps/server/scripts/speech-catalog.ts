import {
  accuracyGrade,
  canonicalLanguage,
  compareEngineVersions,
  BENCHMARK_DICTATION_SECONDS,
  languageIdentity,
  modelFile,
  type CatalogData,
} from "@handy-computer/models";
import { format } from "vite-plus/fmt";

// ASR architectures registered in transcribe.cpp v0.4.1's src/transcribe-arch.cpp.
const ASR_FAMILIES = new Set([
  "parakeet",
  "cohere_asr",
  "canary",
  "qwen3_asr",
  "moss",
  "voxtral",
  "voxtral_realtime",
  "canary_qwen",
  "whisper",
  "moonshine",
  "moonshine_streaming",
  "sensevoice",
  "funasr_nano",
  "gigaam",
  "granite_speech",
  "granite_speech_nar",
  "granite5_ctc",
  "medasr",
]);

// Older clients rank and pick setup models by this flag; current clients use language recommendations.
const RECOMMENDED = new Set([
  "parakeet-unified-en-0.6b",
  "nemotron-3.5-asr-streaming-0.6b",
  "canary-180m-flash",
  "cohere-transcribe-03-2026",
  "whisper-medium",
]);

// Handy labels these weights MIT; Moonshine lists them under its Community License at https://huggingface.co/moonshine-ai/moonshine-models.
const COMMUNITY_LICENSED_MOONSHINE = /^moonshine-(?:(?:base|tiny)-(?:ar|ja|ko|uk|vi|zh)|base-es)$/;

export function generateSpeechCatalog(
  data: CatalogData,
  sourceVersion: string,
  engineVersion: string,
) {
  if (data.schema !== 2) throw new Error("Unsupported speech catalog schema.");
  if (engineVersion !== "0.4.1")
    throw new Error("Review speech catalog loader support for this engine.");
  const ids = new Set<string>();
  const filenames = new Set<string>();
  const models = data.models.flatMap((model) => {
    if (
      model.role !== "asr" ||
      /(?:^|[^a-z0-9])nc(?:$|[^a-z0-9])/i.test(model.license) ||
      COMMUNITY_LICENSED_MOONSHINE.test(model.id) ||
      !ASR_FAMILIES.has(model.family) ||
      compareEngineVersions(model.minEngine ?? data.transcribeCpp, engineVersion) > 0
    )
      return [];

    const file = modelFile(model);
    // The store and native loader accept one root-level GGUF per model.
    if (!/^[^/\\:]+\.gguf$/.test(file.filename) || file.filename.startsWith(".")) return [];
    if (
      !/^\w[\w.-]*\/\w[\w.-]*$/.test(model.repository) ||
      !/^[a-f0-9]{40}$/.test(model.revision) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      model.languages.length === 0
    )
      throw new Error(`Invalid speech catalog metadata: ${model.id}`);
    if (ids.has(model.repository) || filenames.has(file.filename)) {
      throw new Error(`Duplicate speech catalog model or filename: ${model.id}`);
    }
    ids.add(model.repository);
    filenames.add(file.filename);
    const languages = [...new Set(model.languages.map(canonicalLanguage))];
    const realtimeFactor = data.results[model.id]?.performance.accelerated;
    const cpuFactor = data.results[model.id]?.performance.cpu;
    const accuracy = Object.fromEntries(
      languages.flatMap((language) => {
        const cell = data.results[model.id]?.accuracy[languageIdentity(language)];
        return cell
          ? [
              [
                language,
                { grade: accuracyGrade(cell.error).label, errorPercent: cell.error },
              ] as const,
            ]
          : [];
      }),
    );
    return [
      {
        id: model.repository,
        revision: model.revision,
        name: model.name,
        description: model.description || `${model.name} speech-to-text.`,
        filename: file.filename,
        size: file.size,
        sha256: file.sha256,
        license: model.license,
        // T3 selects base languages; the engine's prompt dictionary accepts their short aliases.
        languages,
        benchmark: {
          accuracy,
          secondsPer30s: {
            cpu: cpuFactor ? BENCHMARK_DICTATION_SECONDS / cpuFactor : null,
            accelerated: realtimeFactor ? BENCHMARK_DICTATION_SECONDS / realtimeFactor : null,
          },
        },
        recommended: RECOMMENDED.has(model.id),
        supportsStreaming: model.capabilities.streaming,
        supportsLanguageDetection: model.capabilities.languageDetection,
        supportsTranslation: model.capabilities.translate,
      },
    ];
  });
  return { source: "@handy-computer/models", sourceVersion, engineVersion, models };
}

export async function renderSpeechCatalog(
  data: CatalogData,
  sourceVersion: string,
  engineVersion: string,
) {
  const result = await format(
    "catalog.json",
    JSON.stringify(generateSpeechCatalog(data, sourceVersion, engineVersion)),
  );
  if (result.errors.length > 0) throw new Error("Could not format speech catalog.");
  return result.code;
}
