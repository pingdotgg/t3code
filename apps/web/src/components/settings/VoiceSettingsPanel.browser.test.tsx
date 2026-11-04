import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { chooseAudioDestination, chooseTranscriptCleanup } from "../../speech/voiceConsent";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

it.each([
  ["speech-models", "voice-transcription-destination"],
  ["transcription-test", "voice-transcription-destination"],
  ["speech-correction-word", "speech-post-processing"],
  ["speech-post-processing-model", "speech-post-processing"],
])(
  "searching for disabled %s focuses its opt-in without enabling it",
  async (target, prerequisite) => {
    chooseAudioDestination(null);
    chooseTranscriptCleanup(false);
    await using screen = await render(
      <SettingsScopeProvider search={{}} onChange={() => {}}>
        <VoiceSettingsPanel />
      </SettingsScopeProvider>,
      { router: `/#${target}` },
    );
    expect(document.activeElement?.id).toBe(prerequisite);
    await expect
      .element(screen.getByRole("combobox", { name: "Send microphone audio to" }))
      .toHaveTextContent("Off");
    await expect
      .element(screen.getByRole("switch", { name: "Clean up transcripts with a provider" }))
      .not.toBeChecked();
  },
);
