import type { SpeechOutputDestination } from "@t3tools/contracts";
import { useClientSettings, updateClientSettings } from "../hooks/useSettings";
import { voiceOutput } from "./voiceOutput";

export function useSpeechOutputDestination() {
  const destination = useClientSettings((settings) => settings.speechOutputDestination);
  const choose = (destination: SpeechOutputDestination | null) => {
    voiceOutput.stop();
    void updateClientSettings({ speechOutputDestination: destination });
  };
  return { destination, choose };
}
