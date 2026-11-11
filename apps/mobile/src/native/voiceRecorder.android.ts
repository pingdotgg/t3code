import { AudioModule } from "expo-audio";
import { createLiveVoiceRecorder } from "./voiceTranscription.android";

export function createVoiceRecorder(
  options: ConstructorParameters<typeof AudioModule.AudioRecorder>[0],
) {
  return createLiveVoiceRecorder() ?? new AudioModule.AudioRecorder(options);
}
