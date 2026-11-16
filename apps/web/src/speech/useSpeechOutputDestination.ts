import type { SpeechPlaybackRate, SpeechOutputDestination } from "@t3tools/contracts";
import { useClientSettings, updateClientSettings } from "../hooks/useSettings";
import { voiceOutput } from "./voiceOutput";

export function useSpeechOutputDestination() {
  const destination = useClientSettings((settings) => settings.speechOutputDestination);
  const playbackRate = useClientSettings((settings) => settings.speechPlaybackRate);
  const setPlaybackRate = (rate: SpeechPlaybackRate) => {
    voiceOutput.setPlaybackRate(rate);
    void updateClientSettings({ speechPlaybackRate: rate });
  };
  const choose = (destination: SpeechOutputDestination | null) => {
    voiceOutput.stop();
    void updateClientSettings({ speechOutputDestination: destination });
  };
  return { destination, choose, playbackRate, setPlaybackRate };
}
