import { speechPlaybackSelection } from "@t3tools/client-runtime/voice-output";
import { SpeechPlaybackSettingsContext } from "../../speech/useSpeechOutputDestination";
import { useClientSettings } from "../../hooks/useSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer } from "./settingsLayout";
import { SpeechOutputSettings } from "./SpeechOutputSettings";
import {
  useScopedSettings,
  useUpdateScopedSettings,
  useScopedSettingsWriteAllowed,
} from "./useScopedSettings";

export function SpeechSettingsPanel() {
  const { search, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const fallback = useClientSettings();
  const update = useUpdateScopedSettings();
  const canManage = useScopedSettingsWriteAllowed();
  const destination =
    settings.speechPlaybackDestination === undefined
      ? fallback.speechOutputDestination
      : settings.speechPlaybackDestination;
  const controls = {
    ...speechPlaybackSelection(
      targets.map((target) => ({
        destination:
          target.settings.speechPlaybackDestination === undefined
            ? fallback.speechOutputDestination
            : target.settings.speechPlaybackDestination,
        playbackRate: target.settings.speechPlaybackRate ?? fallback.speechPlaybackRate,
      })),
    ),
    destination,
    playbackRate: settings.speechPlaybackRate ?? fallback.speechPlaybackRate,
    canManage,
    choose: (destination: typeof fallback.speechOutputDestination) => {
      update({
        speechPlaybackDestination: destination
          ? { ...destination, voice: destination.voice ?? null }
          : null,
      });
    },
    setPlaybackRate: (rate: typeof fallback.speechPlaybackRate) => {
      update({ speechPlaybackRate: rate });
    },
    selectVoice: (voice: string | null) => {
      if (destination) update({ speechPlaybackDestination: { ...destination, voice } });
    },
  };
  return (
    <SettingsPageContainer>
      <SpeechPlaybackSettingsContext value={controls}>
        <SpeechOutputSettings key={JSON.stringify(search)} />
      </SpeechPlaybackSettingsContext>
    </SettingsPageContainer>
  );
}
