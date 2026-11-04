import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId, type EnvironmentSpeechModel } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { useVoiceTranscriptionDestination } from "../../speech/useEnvironmentSpeechInput";
import { chooseAudioDestination, chooseTranscriptCleanup } from "../../speech/voiceConsent";
import { toastManager } from "../ui/toast";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { SpeechLanguageSelect } from "./SpeechLanguageSelect";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

vi.mock(import("../../speech/useEnvironmentSpeechInput"), { spy: true });

it("recovers from a failed download progress poll without notifying, but reports a failed initial load", async () => {
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("voice-progress"),
    label: "Test environment",
    httpBaseUrl: window.location.origin,
    wsBaseUrl: "ws://localhost",
  });
  const prepared = { ...target, target, socketUrl: target.wsBaseUrl, httpAuthorization: null };
  const model: EnvironmentSpeechModel = {
    id: "tiny",
    name: "Tiny",
    description: "",
    size: 100,
    languages: ["en"],
    accuracy: 1,
    speed: 1,
    recommended: false,
    supportsStreaming: false,
    supportsTranslation: false,
    supportsLanguageDetection: false,
    active: false,
    state: "downloading",
  };
  const status = {
    supported: true,
    state: "missing-model",
    modelId: model.id,
    model: model.name,
    size: model.size,
    supportsStreaming: false,
    supportsTranslation: false,
    acceleration: "cpu",
    modelUnloadTimeout: "never",
    gpuDevices: [],
  };
  const unavailable = () => new Response(null, { status: 503 });
  const readModels = vi
    .fn(unavailable)
    .mockImplementationOnce(() => Response.json({ models: [model] }))
    .mockImplementationOnce(unavailable)
    .mockImplementationOnce(() => Response.json({ models: [{ ...model, state: "installed" }] }));
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, window.location.href);
    if (url.pathname === "/api/voice/status") return Promise.resolve(Response.json(status));
    if (url.pathname === "/api/voice/models") return Promise.resolve(readModels());
    return fetch(input, init);
  });
  using notify = vi.spyOn(toastManager, "add").mockReturnValue("test");
  await vi.mocked(useVoiceTranscriptionDestination).withImplementation(
    () => ({ environmentId: target.environmentId, label: target.label, grantId: "test", prepared }),
    async () => {
      const panel = (key: string) => (
        <SettingsScopeProvider search={{}} onChange={() => {}}>
          <VoiceSettingsPanel key={key} />
        </SettingsScopeProvider>
      );
      await using screen = await render(panel("first"));
      await expect.element(screen.getByRole("button", { name: "Use model" })).toBeVisible();
      expect(notify).not.toHaveBeenCalled();
      await screen.rerender(panel("reopened"));
      await vi.waitFor(() =>
        expect(notify).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Could not load transcription models" }),
        ),
      );
    },
  );
});

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
    await vi.waitFor(() => expect(document.activeElement?.id).toBe(prerequisite));
    await expect
      .element(screen.getByRole("combobox", { name: "Send microphone audio to" }))
      .toHaveTextContent("Off");
    await expect
      .element(screen.getByRole("switch", { name: "Clean up transcripts with a provider" }))
      .not.toBeChecked();
  },
);

it("keeps a missing destination selected without claiming it cannot transcribe", async () => {
  __setClientSettingsForTests(getClientSettings());
  using cleanup = new DisposableStack();
  cleanup.defer(() => chooseAudioDestination(null));
  chooseAudioDestination({ kind: "environment", environmentId: EnvironmentId.make("missing") });
  await using screen = await render(
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <VoiceSettingsPanel />
    </SettingsScopeProvider>,
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Send microphone audio to" }))
    .toHaveTextContent("Chosen environment (unavailable)");
  await expect.element(screen.getByText(/cannot transcribe audio/)).not.toBeInTheDocument();
});

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
