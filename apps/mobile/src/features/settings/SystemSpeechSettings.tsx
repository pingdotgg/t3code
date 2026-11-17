import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { useGT } from "gt-react-native";
import { nativeSpeechVoices } from "../voice-output/nativeSpeech";
import { useSpeechOutputDestination } from "../voice-output/useSpeechOutputDestination";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { Sheet } from "../../components/ui/Sheet";
import { SettingsSection } from "./components/SettingsSection";

export function SystemSpeechSettings() {
  const gt = useGT();
  const { destination, selectVoice, canManage } = useSpeechOutputDestination();
  const [voices, setVoices] = useState<Awaited<ReturnType<typeof nativeSpeechVoices>>>([]);
  const [choosing, setChoosing] = useState(false);
  const [failed, setFailed] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the voices provided asynchronously by the operating system
  useEffect(() => {
    let active = true;
    void nativeSpeechVoices().then(
      (voices) => {
        if (active) setVoices(voices);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <>
      <SettingsSection
        title={gt("System voice")}
        footer={gt(
          "Uses the voices available on this device. Some voices may use an online service.",
        )}
      >
        <ListActionRow
          label={gt("Voice")}
          detail={
            destination?.voice
              ? (voices.find((voice) => voice.id === destination.voice)?.name ?? gt("Unavailable"))
              : gt("System default")
          }
          disabled={!canManage || failed}
          onPress={() => setChoosing(true)}
        />
      </SettingsSection>
      {choosing ? (
        <Sheet title={gt("System voice")} onClose={() => setChoosing(false)}>
          <ScrollView>
            <ListChoiceRow
              label={gt("System default")}
              selected={!destination?.voice}
              onPress={() => {
                selectVoice(null);
                setChoosing(false);
              }}
            />
            {voices.map((voice) => (
              <ListChoiceRow
                key={voice.id}
                label={`${voice.name} · ${voice.language}`}
                selected={destination?.voice === voice.id}
                onPress={() => {
                  selectVoice(voice.id);
                  setChoosing(false);
                }}
              />
            ))}
          </ScrollView>
        </Sheet>
      ) : null}
    </>
  );
}
