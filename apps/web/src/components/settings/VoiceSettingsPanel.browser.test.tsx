import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { chooseAudioDestination, chooseTranscriptCleanup } from "../../speech/voiceConsent";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { SpeechLanguageSelect } from "./SpeechLanguageSelect";
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

it("shows the model's effective language and restores the saved preference when supported again", async () => {
  const previous = getClientSettings();
  using cleanup = new DisposableStack();
  cleanup.defer(() => __setClientSettingsForTests(previous));
  __setClientSettingsForTests({ ...previous, speechLanguage: "fr" });
  await using screen = await render(<SpeechLanguageSelect model={{ languages: ["en"] }} />);
  const picker = screen.getByRole("combobox", { name: "Transcription language" });
  await expect.element(picker).toHaveTextContent("English (French unavailable)");
  await screen.rerender(
    <SpeechLanguageSelect model={{ languages: ["en", "de"], supportsLanguageDetection: true }} />,
  );
  await expect.element(picker).toHaveTextContent("Auto-detect (French unavailable)");
  await screen.rerender(<SpeechLanguageSelect model={{ languages: ["en", "fr"] }} />);
  await expect.element(picker).toHaveTextContent("French");
  expect(getClientSettings().speechLanguage).toBe("fr");
});

it("keeps punctuation in a saved dictionary term and its alias", async () => {
  const previous = getClientSettings();
  using cleanup = new DisposableStack();
  cleanup.defer(() => __setClientSettingsForTests(previous));
  __setClientSettingsForTests({ ...previous, speechCustomWords: [] });
  await using screen = await render(
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <VoiceSettingsPanel />
    </SettingsScopeProvider>,
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Add a word or phrase to the dictionary" }),
    "O'Reilly{Enter}",
  );
  expect(getClientSettings().speechCustomWords[0]?.term).toBe("O'Reilly");
  await userEvent.click(screen.getByRole("button", { name: "Add an alias for O'Reilly" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Alias for O'Reilly" }),
    '"Oh Really"{Enter}',
  );
  expect(getClientSettings().speechCustomWords).toEqual([
    { term: "O'Reilly", aliases: ['"Oh Really"'] },
  ]);
});
