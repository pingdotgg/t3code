export const VOICE_INPUT_PLUGIN_ID = "t3.voice-input";

export const VOICE_INPUT_ACTION_ID = "voice-input";

export const VOICE_INPUT_COMMANDS = {
  settingsGet: "voiceInput.settings.get",
  settingsUpdate: "voiceInput.settings.update",
  clientStateGet: "voiceInput.clientState.get",
  dependenciesStatus: "voiceInput.dependencies.status",
  modelDownload: "voiceInput.model.download",
  transcribe: "voiceInput.transcribe",
  transcriptionTest: "voiceInput.transcription.test",
} as const;

export const VOICE_INPUT_CLIENT_COMMANDS = {
  toggleRecording: "toggleRecording",
  cancelRecording: "cancelRecording",
} as const;

export const VOICE_INPUT_KEYBINDING_COMMANDS = {
  toggleRecording: `plugin.${VOICE_INPUT_PLUGIN_ID}.${VOICE_INPUT_CLIENT_COMMANDS.toggleRecording}`,
  cancelRecording: `plugin.${VOICE_INPUT_PLUGIN_ID}.${VOICE_INPUT_CLIENT_COMMANDS.cancelRecording}`,
} as const;

export const VOICE_INPUT_EVENTS = {
  changed: "voiceInput.changed",
  modelDownloadStarted: "voiceInput.modelDownload.started",
  modelDownloadProgress: "voiceInput.modelDownload.progress",
  modelDownloadCompleted: "voiceInput.modelDownload.completed",
  modelDownloadFailed: "voiceInput.modelDownload.failed",
} as const;
