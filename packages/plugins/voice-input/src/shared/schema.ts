import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "@t3tools/plugin-api/schema";
import * as Schema from "effect/Schema";

export const WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v3"] as const;
export const WHISPER_DEVICES = ["auto", "cpu", "cuda"] as const;

export const DEFAULT_MAX_RECORDING_SECONDS = 120;
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_TRANSCRIPTION_TIMEOUT_SECONDS = 120;
export const MAX_TRANSCRIPTION_TIMEOUT_SECONDS = 600;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_AUDIO_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
export const MODEL_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
export const AUDIO_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const LanguageCode = Schema.String.check(Schema.isMaxLength(32));
const PythonCommand = Schema.String.check(Schema.isMaxLength(1_024));
const PromptHint = Schema.String.check(Schema.isMaxLength(2_000));
const PositiveSeconds = PositiveInt.check(Schema.isLessThanOrEqualTo(600));
const PositiveUploadBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_UPLOAD_BYTES));
const AudioBase64Payload = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_AUDIO_BASE64_CHARS),
  Schema.isPattern(AUDIO_BASE64_PATTERN),
);

export const VoiceInputProvider = Schema.Literal("localWhisper");
export type VoiceInputProvider = typeof VoiceInputProvider.Type;

export const WhisperModel = Schema.Literals(WHISPER_MODELS);
export type WhisperModel = typeof WhisperModel.Type;

export const WhisperDevice = Schema.Literals(WHISPER_DEVICES);
export type WhisperDevice = typeof WhisperDevice.Type;

export const VoiceInputSettings = Schema.Struct({
  enabled: Schema.Boolean,
  provider: VoiceInputProvider,
  model: WhisperModel,
  language: LanguageCode,
  device: WhisperDevice,
  pythonCommand: Schema.optional(PythonCommand),
  maxRecordingSeconds: PositiveSeconds,
  maxUploadBytes: PositiveUploadBytes,
  transcriptionTimeoutSeconds: PositiveSeconds.check(
    Schema.isLessThanOrEqualTo(MAX_TRANSCRIPTION_TIMEOUT_SECONDS),
  ),
  promptHint: PromptHint,
});
export type VoiceInputSettings = typeof VoiceInputSettings.Type;

export const VoiceInputSettingsPatch = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  provider: Schema.optional(VoiceInputProvider),
  model: Schema.optional(WhisperModel),
  language: Schema.optional(LanguageCode),
  device: Schema.optional(WhisperDevice),
  pythonCommand: Schema.optional(PythonCommand),
  maxRecordingSeconds: Schema.optional(PositiveSeconds),
  maxUploadBytes: Schema.optional(PositiveUploadBytes),
  transcriptionTimeoutSeconds: Schema.optional(
    PositiveSeconds.check(Schema.isLessThanOrEqualTo(MAX_TRANSCRIPTION_TIMEOUT_SECONDS)),
  ),
  promptHint: Schema.optional(PromptHint),
});
export type VoiceInputSettingsPatch = typeof VoiceInputSettingsPatch.Type;

export const VoiceInputSettingsGetInput = Schema.Struct({});
export type VoiceInputSettingsGetInput = typeof VoiceInputSettingsGetInput.Type;

export const VoiceInputSettingsGetResult = Schema.Struct({
  settings: VoiceInputSettings,
  cachePath: Schema.String,
});
export type VoiceInputSettingsGetResult = typeof VoiceInputSettingsGetResult.Type;

export const VoiceInputSettingsUpdateInput = Schema.Struct({
  patch: VoiceInputSettingsPatch,
});
export type VoiceInputSettingsUpdateInput = typeof VoiceInputSettingsUpdateInput.Type;

export const VoiceInputSettingsUpdateResult = VoiceInputSettingsGetResult;
export type VoiceInputSettingsUpdateResult = typeof VoiceInputSettingsUpdateResult.Type;

export const VoiceInputDependencyCheck = Schema.Struct({
  available: Schema.Boolean,
  detail: Schema.optional(Schema.String),
});
export type VoiceInputDependencyCheck = typeof VoiceInputDependencyCheck.Type;

export const VoiceInputDependenciesStatusInput = Schema.Struct({});
export type VoiceInputDependenciesStatusInput = typeof VoiceInputDependenciesStatusInput.Type;

export const VoiceInputDependenciesStatusResult = Schema.Struct({
  python: VoiceInputDependencyCheck,
  venvPython: VoiceInputDependencyCheck,
  fasterWhisper: VoiceInputDependencyCheck,
  ffmpeg: VoiceInputDependencyCheck,
  selectedModelCached: Schema.Boolean,
  cachePath: Schema.String,
  installCommand: Schema.String,
  venvPath: Schema.String,
  venvPythonCommand: Schema.String,
  venvSetupCommand: Schema.String,
});
export type VoiceInputDependenciesStatusResult = typeof VoiceInputDependenciesStatusResult.Type;

export const VoiceInputClientStateGetInput = Schema.Struct({});
export type VoiceInputClientStateGetInput = typeof VoiceInputClientStateGetInput.Type;

export const VoiceInputClientStateGetResult = Schema.Struct({
  settings: VoiceInputSettings,
  status: VoiceInputDependenciesStatusResult,
  cachePath: Schema.String,
});
export type VoiceInputClientStateGetResult = typeof VoiceInputClientStateGetResult.Type;

export const VoiceInputTranscribeInput = Schema.Struct({
  audioBase64: AudioBase64Payload,
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  sizeBytes: PositiveUploadBytes,
});
export type VoiceInputTranscribeInput = typeof VoiceInputTranscribeInput.Type;

export const VoiceInputTranscribeResult = Schema.Struct({
  text: Schema.String,
  language: Schema.optional(Schema.String),
  durationMs: NonNegativeInt,
});
export type VoiceInputTranscribeResult = typeof VoiceInputTranscribeResult.Type;

export const VoiceInputModelDownloadInput = Schema.Struct({});
export type VoiceInputModelDownloadInput = typeof VoiceInputModelDownloadInput.Type;

export const VoiceInputModelDownloadResult = Schema.Struct({
  model: WhisperModel,
  cached: Schema.Boolean,
});
export type VoiceInputModelDownloadResult = typeof VoiceInputModelDownloadResult.Type;

export const VoiceInputTranscriptionTestInput = Schema.Struct({});
export type VoiceInputTranscriptionTestInput = typeof VoiceInputTranscriptionTestInput.Type;

export const VoiceInputTranscriptionTestResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
});
export type VoiceInputTranscriptionTestResult = typeof VoiceInputTranscriptionTestResult.Type;

export const DEFAULT_VOICE_INPUT_SETTINGS = {
  enabled: true,
  provider: "localWhisper",
  model: "base",
  language: "auto",
  device: "auto",
  pythonCommand: "",
  maxRecordingSeconds: DEFAULT_MAX_RECORDING_SECONDS,
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  transcriptionTimeoutSeconds: DEFAULT_TRANSCRIPTION_TIMEOUT_SECONDS,
  promptHint: "",
} satisfies VoiceInputSettings;
