import type { EnvironmentSpeechModel } from "@t3tools/contracts";
import catalog from "./catalog.json" with { type: "json" };

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
  readonly benchmark: NonNullable<EnvironmentSpeechModel["benchmark"]>;
  readonly recommended: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsLanguageDetection: boolean;
  readonly supportsTranslation: boolean;
};

// Scores remain required by the wire schema but are not displayed.
export const SPEECH_MODELS: readonly SpeechModel[] = catalog.models.map((model) => ({
  ...model,
  accuracy: 0,
  speed: 0,
}));

export const DEFAULT_SPEECH_MODEL_ID = "handy-computer/parakeet-unified-en-0.6b-gguf";
export const getSpeechModel = (modelId: string): SpeechModel | undefined =>
  SPEECH_MODELS.find((model) => model.id === modelId);

export { effectiveSpeechLanguage } from "@t3tools/shared/speech";
