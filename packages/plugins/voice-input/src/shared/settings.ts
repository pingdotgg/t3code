import {
  DEFAULT_VOICE_INPUT_SETTINGS,
  type VoiceInputDependenciesStatusResult,
  type VoiceInputSettings,
  type VoiceInputSettingsPatch,
} from "./schema.ts";

export function normalizeVoiceInputSettings(
  settings: VoiceInputSettings | null,
): VoiceInputSettings {
  return {
    ...DEFAULT_VOICE_INPUT_SETTINGS,
    ...settings,
    pythonCommand: settings?.pythonCommand ?? "",
  };
}

export function applyVoiceInputSettingsPatch(
  current: VoiceInputSettings,
  patch: VoiceInputSettingsPatch,
): VoiceInputSettings {
  return {
    enabled: patch.enabled ?? current.enabled,
    provider: patch.provider ?? current.provider,
    model: patch.model ?? current.model,
    language: patch.language ?? current.language,
    device: patch.device ?? current.device,
    pythonCommand: patch.pythonCommand ?? current.pythonCommand ?? "",
    maxRecordingSeconds: patch.maxRecordingSeconds ?? current.maxRecordingSeconds,
    maxUploadBytes: patch.maxUploadBytes ?? current.maxUploadBytes,
    transcriptionTimeoutSeconds:
      patch.transcriptionTimeoutSeconds ?? current.transcriptionTimeoutSeconds,
    promptHint: patch.promptHint ?? current.promptHint,
  };
}

export function sameVoiceInputSettings(
  left: VoiceInputSettings | null | undefined,
  right: VoiceInputSettings | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left === right;
  }
  const normalizedLeft = normalizeVoiceInputSettings(left);
  const normalizedRight = normalizeVoiceInputSettings(right);
  return (
    normalizedLeft.enabled === normalizedRight.enabled &&
    normalizedLeft.provider === normalizedRight.provider &&
    normalizedLeft.model === normalizedRight.model &&
    normalizedLeft.language === normalizedRight.language &&
    normalizedLeft.device === normalizedRight.device &&
    normalizedLeft.pythonCommand === normalizedRight.pythonCommand &&
    normalizedLeft.maxRecordingSeconds === normalizedRight.maxRecordingSeconds &&
    normalizedLeft.maxUploadBytes === normalizedRight.maxUploadBytes &&
    normalizedLeft.transcriptionTimeoutSeconds === normalizedRight.transcriptionTimeoutSeconds &&
    normalizedLeft.promptHint === normalizedRight.promptHint
  );
}

export function getModelDownloadBlockedReason(
  status: VoiceInputDependenciesStatusResult | null,
  hasChanges: boolean,
): string | null {
  if (hasChanges) {
    return "Save Voice Input settings before downloading the selected model.";
  }
  if (!status) {
    return "Dependency check is still running.";
  }
  if (!status.python.available) {
    return status.python.detail ?? "Python is required before downloading a Whisper model.";
  }
  if (!status.fasterWhisper.available) {
    return status.fasterWhisper.detail ?? `Install faster-whisper with: ${status.installCommand}`;
  }
  return null;
}
