import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { nativeSpeechVoices } from "../../speech/nativeSpeech";
import { useSpeechOutputDestination } from "../../speech/useSpeechOutputDestination";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

export function SystemSpeechSettings() {
  const gt = useGT();
  const { destination, selectVoice, canManage } = useSpeechOutputDestination();
  const [voices, setVoices] = useState(nativeSpeechVoices);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- browsers populate native voices asynchronously through voiceschanged
  useEffect(() => {
    const refresh = () => setVoices(nativeSpeechVoices());
    window.speechSynthesis?.addEventListener("voiceschanged", refresh);
    refresh();
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", refresh);
  }, []);
  return (
    <SettingsRow
      title={gt("System voice")}
      description={gt(
        "Uses the voices available on this device. Some voices may use an online service.",
      )}
      settingKeys={["speechPlaybackDestination"]}
      control={
        <Select
          value={destination?.voice ?? "default"}
          disabled={!canManage}
          onValueChange={(value) => selectVoice(value === "default" ? null : value)}
        >
          <SelectTrigger size="sm" aria-label={gt("System voice")}>
            <SelectValue>
              {destination?.voice
                ? (voices.find((voice) => voice.id === destination.voice)?.name ??
                  gt("Unavailable"))
                : gt("System default")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="default">{gt("System default")}</SelectItem>
            {voices.map((voice) => (
              <SelectItem key={voice.id} value={voice.id}>
                {voice.name} · {voice.language}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
