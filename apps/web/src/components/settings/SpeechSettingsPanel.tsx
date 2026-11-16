import { SettingsPageContainer } from "./settingsLayout";
import { SpeechOutputSettings } from "./SpeechOutputSettings";

export function SpeechSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SpeechOutputSettings />
    </SettingsPageContainer>
  );
}
