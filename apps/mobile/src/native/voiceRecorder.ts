import { AudioModule } from "expo-audio";

export function createVoiceRecorder(
  options: ConstructorParameters<typeof AudioModule.AudioRecorder>[0],
) {
  return new AudioModule.AudioRecorder(options);
}
