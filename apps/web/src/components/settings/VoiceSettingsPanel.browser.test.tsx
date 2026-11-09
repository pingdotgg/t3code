import { PrimaryConnectionTarget, RelayConnectionTarget } from "@t3tools/client-runtime/connection";
import type * as Effect from "effect/Effect";
import {
  EnvironmentId,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import {
  useEnvironmentSpeechInput,
  useVoiceTranscriptionDestination,
} from "../../speech/useEnvironmentSpeechInput";
import { chooseAudioDestination, chooseTranscriptCleanup } from "../../speech/voiceConsent";
import { useEnvironmentScope } from "../../state/session";
import { toastManager } from "../ui/toast";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { SpeechLanguageSelect } from "./SpeechLanguageSelect";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

vi.mock(import("../../speech/useEnvironmentSpeechInput"), { spy: true });
// MT Code's realtime voice section talks to the primary environment; these tests cover dictation.
vi.mock(import("./RealtimeVoiceSettings"), () => ({ RealtimeVoiceSettings: () => <></> }));
vi.mock(import("../../state/session"), { spy: true });

// The real connection runtime authorizes relay requests with a signed-in cloud session.
vi.mock("../../connection/runtime", async () => {
  const [{ ManagedRelay }, rpc, { Atom }, Context, Effect, Layer] = await Promise.all([
    import("@t3tools/client-runtime/relay"),
    import("@t3tools/client-runtime/rpc"),
    import("effect/reactivity"),
    import("effect/Context"),
    import("effect/Effect"),
    import("effect/Layer"),
  ]);
  type AuthorizedHttp =
    import("@t3tools/client-runtime/authorization").AuthorizedRemoteHttpEnvironment;
  // Services resolve by key, and client-runtime does not export this one.
  class RemoteEnvironmentAuthorization extends Context.Service<
    RemoteEnvironmentAuthorization,
    {
      readonly authorizeDpopHttp: (input: {
        readonly expectedEnvironmentId: AuthorizedHttp["environmentId"];
      }) => Effect.Effect<AuthorizedHttp>;
    }
    // @effect-diagnostics-next-line deterministicKeys:off
  >()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.mergeAll(
        rpc.layerRemoteHttpClient((input, init) => globalThis.fetch(input, init)),
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, {
          thumbprint: Effect.succeed("thumbprint"),
          createProof: () => Effect.succeed("proof"),
        }),
        Layer.succeed(RemoteEnvironmentAuthorization, {
          authorizeDpopHttp: ({ expectedEnvironmentId }) =>
            Effect.succeed({
              environmentId: expectedEnvironmentId,
              label: "MacBook Pro",
              httpBaseUrl: window.location.origin,
              httpAuthorization: {
                _tag: "Dpop",
                accessToken: "relay-access-token",
                expiresAtEpochMs: 4_102_444_800_000,
              },
            }),
        }),
      ),
    ),
  };
});

it("tests the selected model after download and preserves its transcript across filters", async () => {
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("voice-filter"),
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
    active: true,
    state: "installed",
  };
  const status = {
    supported: true,
    state: "ready",
    modelId: model.id,
    model: model.name,
    size: model.size,
    supportsStreaming: false,
    supportsTranslation: false,
    acceleration: "cpu",
    modelUnloadTimeout: "never",
    gpuDevices: [],
  } satisfies EnvironmentSpeechStatus;
  let installed = false;
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, window.location.href);
    if (url.pathname === "/api/voice/status")
      return Promise.resolve(
        Response.json(installed ? status : { ...status, state: "missing-model" }),
      );
    if (url.pathname === "/api/voice/models/download") {
      installed = true;
      return Promise.resolve(Response.json({ models: [model] }));
    }
    if (url.pathname === "/api/voice/models")
      return Promise.resolve(
        Response.json({
          models: [
            installed ? model : { ...model, state: "downloadable", active: false },
            {
              ...model,
              id: "both",
              name: "Bilingual",
              active: false,
              languages: ["en", "fr"],
              ...(url.searchParams.has("benchmarks")
                ? {
                    benchmark: {
                      accuracy: {
                        en: { grade: "A-", errorPercent: 4 },
                        fr: { grade: "B+", errorPercent: 5.5 },
                      },
                      secondsPer30s: 2.1,
                    },
                  }
                : {}),
            },
          ],
        }),
      );
    return fetch(input, init);
  });
  const transcript = "Keep this transcript.";
  using _scope = vi.mocked(useEnvironmentScope).mockReturnValue(true);
  await vi.mocked(useVoiceTranscriptionDestination).withImplementation(
    () => ({ environmentId: target.environmentId, label: target.label, grantId: "test", prepared }),
    async () => {
      await vi.mocked(useEnvironmentSpeechInput).withImplementation(
        (input) => ({
          available: true,
          status,
          transcriptionEnvironmentId: target.environmentId,
          transcriptionEnvironmentLabel: target.label,
          setup: {
            open: false,
            step: 0,
            model: null,
            language: null,
            downloading: false,
            catalogFailed: false,
            retryCatalog: null,
            error: null,
            setOpen: () => {},
            download: async () => {},
            cancelDownload: async () => {},
            startRecording: async () => {},
          },
          state: { phase: "idle", error: null, errorAction: null },
          preview: null,
          level: 0,
          preparing: false,
          blocksSubmission: false,
          freezesEditor: false,
          start: async () => {
            input.commitDraft(transcript, { start: transcript.length, end: transcript.length });
          },
          submitAfterDictation: () => {},
          stop: async () => {},
          cancel: () => {},
          skipPostProcessing: () => {},
        }),
        async () => {
          await using screen = await render(
            <SettingsScopeProvider search={{}} onChange={() => {}}>
              <VoiceSettingsPanel />
            </SettingsScopeProvider>,
          );
          const testModel = screen.getByRole("button", { name: "Test model", exact: true });
          const download = screen.getByRole("button", { name: "Download", exact: true });
          await expect.element(download).toBeVisible();
          expect(testModel.query()).toBeNull();
          expect(screen.getByRole("button", { name: "Set up voice input" }).query()).toBeNull();
          await userEvent.click(download);
          await expect.element(testModel).toBeVisible();
          expect(screen.getByRole("button", { name: "Set up voice input" }).query()).toBeNull();
          await userEvent.click(testModel);
          const result = screen.getByRole("status", { name: "Test transcript" });
          await expect.element(result).toHaveTextContent(transcript);

          const search = screen.getByRole("textbox", { name: "Search transcription models" });
          await userEvent.fill(search, "no matching model");
          await expect.element(screen.getByText("No models match.")).toBeVisible();
          await userEvent.clear(search);
          await userEvent.fill(screen.getByRole("textbox", { name: "Search languages" }), "fr");
          const french = screen.getByRole("button", { name: "French", exact: true });
          await userEvent.click(french);
          await expect.element(screen.getByText("Bilingual", { exact: true })).toBeVisible();
          await expect.element(screen.getByText("B+", { exact: true })).toBeVisible();
          expect(screen.container.querySelector("#transcription-test")).toHaveAttribute("hidden");
          await userEvent.click(french);
          await expect.element(result).toBeVisible();
          await vi.waitFor(() =>
            expect(
              screen.container.querySelector('[aria-label="Test transcript"]')?.textContent,
            ).toBe(transcript),
          );
        },
      );
    },
  );
});

it("loads the models of a relay-connected destination", async () => {
  const target = new RelayConnectionTarget({
    environmentId: EnvironmentId.make("voice-relay"),
    label: "MacBook Pro",
  });
  const prepared = {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: window.location.origin,
    socketUrl: "ws://localhost",
    httpAuthorization: {
      _tag: "Dpop" as const,
      accessToken: "stale-access-token",
      expiresAtEpochMs: 4_102_444_800_000,
    },
    target,
  };
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
    state: "downloadable",
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
  } satisfies EnvironmentSpeechStatus;
  const authorizations: Array<string | null> = [];
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, window.location.href);
    if (url.pathname === "/api/voice/status") {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Promise.resolve(Response.json(status));
    }
    if (url.pathname === "/api/voice/models")
      return Promise.resolve(Response.json({ models: [model] }));
    return fetch(input, init);
  });
  using notify = vi.spyOn(toastManager, "add").mockReturnValue("test");
  // Restored even when an assertion fails, unlike `withImplementation`.
  using _destination = vi.mocked(useVoiceTranscriptionDestination).mockImplementation(() => ({
    environmentId: target.environmentId,
    label: target.label,
    grantId: "test",
    prepared,
  }));
  await using screen = await render(
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <VoiceSettingsPanel />
    </SettingsScopeProvider>,
  );
  await vi.waitFor(() => expect(authorizations.length + notify.mock.calls.length).not.toBe(0));
  expect(notify).not.toHaveBeenCalled();
  expect(authorizations).toEqual(["DPoP relay-access-token"]);
  await expect.element(screen.getByText("Tiny", { exact: true })).toBeVisible();
});

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
    .fn((_withBenchmarks: boolean) => unavailable())
    .mockImplementationOnce(() => Response.json({ models: [model] }))
    .mockImplementationOnce(unavailable)
    .mockImplementationOnce(() => Response.json({ models: [{ ...model, state: "installed" }] }));
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, window.location.href);
    if (url.pathname === "/api/voice/status") return Promise.resolve(Response.json(status));
    if (url.pathname === "/api/voice/models")
      return Promise.resolve(readModels(url.searchParams.has("benchmarks")));
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
      expect(readModels.mock.calls.map(([withBenchmarks]) => withBenchmarks)).toEqual([
        true,
        false,
        false,
      ]);
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
  ["speech-hardware", "voice-transcription-destination"],
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
      .element(screen.getByRole("combobox", { name: "Transcribe with" }))
      .toHaveTextContent("Off");
    await expect
      .element(screen.getByRole("switch", { name: "Clean up transcripts" }))
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
    .element(screen.getByRole("combobox", { name: "Transcribe with" }))
    .toHaveTextContent("Chosen environment (unavailable)");
  await expect.element(screen.getByText(/can’t transcribe audio/)).not.toBeInTheDocument();
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
