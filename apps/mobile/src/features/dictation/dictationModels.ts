import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";
export const LOCAL_DICTATION_MODEL_IDS = [
  "parakeet-110m",
  "parakeet-v3",
  "parakeet-ultra",
] as const;
export type LocalDictationModelId = (typeof LOCAL_DICTATION_MODEL_IDS)[number];
export type DictationModelId = "apple" | LocalDictationModelId;
export const VOICE_FILTER_MODEL_ID = "voice-filter";
export const VOICE_FILTER_DOWNLOAD_BYTES = 21_000_000;
export type DownloadableModelId = LocalDictationModelId | typeof VOICE_FILTER_MODEL_ID;

/** Core ML picks the Neural Engine where it can; no setting exposes the other choices yet. */
export const DICTATION_PROCESSING = "auto";

export interface LocalDictationModel {
  readonly id: LocalDictationModelId;
  readonly name: string;
  readonly summary: string;
  /** Measured on disk after download. */
  readonly downloadBytes: number;
  /** Decimal bytes, because a "4 GB" device reports a little under 4 GiB. */
  readonly minimumMemoryBytes: number;
  readonly englishOnly: boolean;
}

export const LOCAL_DICTATION_MODELS: ReadonlyArray<LocalDictationModel> = [
  {
    id: "parakeet-110m",
    name: "Fast",
    summary: m(msg("Parakeet 110M. English only.")),
    downloadBytes: 243_000_000,
    minimumMemoryBytes: 3_500_000_000,
    englishOnly: true,
  },
  {
    id: "parakeet-v3",
    name: "Balanced",
    summary: m(msg("Parakeet v3. 25 European languages.")),
    downloadBytes: 491_000_000,
    minimumMemoryBytes: 3_500_000_000,
    englishOnly: false,
  },
  {
    id: "parakeet-ultra",
    name: "Most accurate",
    summary: m(msg("Parakeet Ultra. 25 European languages.")),
    downloadBytes: 637_000_000,
    minimumMemoryBytes: 5_500_000_000,
    englishOnly: false,
  },
];

export function isLocalDictationModelId(value: unknown): value is LocalDictationModelId {
  return LOCAL_DICTATION_MODEL_IDS.some((id) => id === value);
}

export function isDictationModelId(value: unknown): value is DictationModelId {
  return value === "apple" || isLocalDictationModelId(value);
}

export function localDictationModel(id: LocalDictationModelId): LocalDictationModel {
  return LOCAL_DICTATION_MODELS.find((model) => model.id === id)!;
}

export function dictationModelName(id: DictationModelId): string {
  return id === "apple" ? m(msg("Apple")) : localDictationModel(id).name;
}

export function deviceCanRun(model: LocalDictationModel, physicalMemoryBytes: number): boolean {
  return physicalMemoryBytes >= model.minimumMemoryBytes;
}

const isEnglish = (locale: string) => /^en([-_]|$)/i.test(locale);

/** The model to suggest: the smallest one that covers the device language and fits its memory. */
export function recommendedDictationModel(input: {
  readonly physicalMemoryBytes: number;
  readonly locale: string;
}): DictationModelId {
  const fits = LOCAL_DICTATION_MODELS.filter(
    (model) =>
      deviceCanRun(model, input.physicalMemoryBytes) &&
      (!model.englishOnly || isEnglish(input.locale)),
  );
  return fits[0]?.id ?? "apple";
}

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
