import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type PiperRuntimeStatus,
  type SpeechSynthesisVoices,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { page, userEvent } from "vite-plus/test/browser";
import {
  __setClientSettingsForTests,
  getClientSettings,
  updateClientSettings,
  mergeEnvironmentSettings,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../hooks/useSettings";
import { useEnvironments, type EnvironmentPresentation } from "../state/environments";
import { SpeechOutputSettings } from "../components/settings/SpeechOutputSettings";
import { render } from "../../test/render";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import {
  installEnvironmentSpeechRuntime,
  downloadEnvironmentSpeechVoice,
  getEnvironmentSpeechVoices,
  getElevenLabsSpeechVoices,
  selectEnvironmentSpeechVoice,
  removeEnvironmentSpeechVoice,
} from "@t3tools/client-runtime/voice-input";
import { useSpeechVoiceCatalog } from "./useSpeechVoiceCatalog";

vi.mock(import("../state/environments"), { spy: true });
vi.mock(import("../state/session"), { spy: true });
vi.mock(import("@t3tools/client-runtime/voice-input"), { spy: true });
const cloudSettings = vi.hoisted(() => ({ save: vi.fn(), voice: vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => cloudSettings.save }));
vi.mock(import("../hooks/useSettings"), { spy: true });
vi.mock("../env", async (original) => ({
  ...(await original<typeof import("../env")>()),
  isSecretsFeatureEnabled: true,
}));
vi.mock("./runEnvironmentSpeech", () => ({
  runEnvironmentSpeech: Effect.runPromise,
  inEnvironmentSpeechRuntime: (effect: unknown) => effect,
}));

function setup() {
  cloudSettings.save.mockReset();
  cloudSettings.voice.mockReset();
  vi.mocked(useEnvironmentScope).mockReset();
  vi.mocked(useEnvironments).mockReset();
  vi.mocked(usePreparedConnection).mockReset();
  vi.mocked(getEnvironmentSpeechVoices)
    .mockReset()
    .mockImplementation(() => Effect.succeed({ voices: [] }));
  vi.mocked(getElevenLabsSpeechVoices).mockReset();
  vi.mocked(downloadEnvironmentSpeechVoice).mockReset();
  vi.mocked(selectEnvironmentSpeechVoice).mockReset();
  vi.mocked(installEnvironmentSpeechRuntime).mockReset();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function connection(id: string): PreparedConnection {
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make(id),
    label: id,
    httpBaseUrl: window.location.origin,
    wsBaseUrl: "ws://localhost",
  });
  return { ...target, target, socketUrl: target.wsBaseUrl, httpAuthorization: null };
}

it("clears pending downloads when switching environments before returning", async () => {
  setup();
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  const a = connection("a");
  const b = connection("b");
  const empty: SpeechSynthesisVoices = { voices: [] };
  const download = deferred<SpeechSynthesisVoices>();
  const completed = deferred<void>();
  vi.mocked(usePreparedConnection).mockImplementation((id) =>
    Option.some(id === a.environmentId ? a : b),
  );
  vi.mocked(getEnvironmentSpeechVoices).mockImplementation(() => Effect.succeed(empty));
  vi.mocked(downloadEnvironmentSpeechVoice).mockImplementation(() =>
    Effect.promise(() => download.promise),
  );
  vi.mocked(selectEnvironmentSpeechVoice).mockImplementation(() => Effect.succeed(empty));
  function Catalog({ environmentId }: { environmentId: EnvironmentId }) {
    const catalog = useSpeechVoiceCatalog(environmentId);
    return (
      <>
        <p role="status">{catalog.downloading ? "Downloading" : "Ready"}</p>
        <button
          onClick={() => void catalog.run("voice", "download").then(() => completed.resolve())}
        >
          Download
        </button>
      </>
    );
  }
  await using screen = await render(<Catalog environmentId={a.environmentId} />, {
    // The hook reads its environment directly and does not use routes.
    router: false,
  });
  await screen.getByRole("button", { name: "Download" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Downloading");
  await screen.rerender(<Catalog environmentId={b.environmentId} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Ready");
  download.resolve(empty);
  await completed.promise;
  await screen.rerender(<Catalog environmentId={a.environmentId} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Ready");
});

it("starts off, checks the selected environment, and offers managed Piper installation", async () => {
  setup();
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const prepared = connection("speech-server");
  const environment = {
    environmentId: prepared.environmentId,
    label: "Speech server",
    connection: { phase: "connected" },
    serverConfig: {
      settings: DEFAULT_SERVER_SETTINGS,
      environment: { capabilities: { voiceSynthesis: true } },
    },
  } as unknown as EnvironmentPresentation;
  vi.mocked(useEnvironments).mockReturnValue({
    environments: [environment],
    isReady: true,
    networkStatus: "online",
    presentationById: new Map(),
  } as ReturnType<typeof useEnvironments>);
  vi.mocked(usePreparedConnection).mockReturnValue(Option.some(prepared));
  let runtime: PiperRuntimeStatus = { state: "not-installed", platform: "linux-x64" };
  let voices: SpeechSynthesisVoices["voices"] = [
    {
      id: "pt_BR-faber-medium",
      name: "Faber",
      language: "pt_BR",
      languageName: "Portuguese",
      quality: "medium",
      size: 1,
      modelCardUrl: "https://example.com/voice",
      active: false,
      state: "installed",
    },
  ];
  vi.mocked(getEnvironmentSpeechVoices).mockImplementation(() =>
    Effect.succeed({ voices, runtime }),
  );
  vi.mocked(installEnvironmentSpeechRuntime).mockImplementation(() =>
    Effect.sync(() => {
      runtime = { state: "ready", platform: "linux-x64" };
      return { voices, runtime };
    }),
  );
  await using screen = await render(<SpeechOutputSettings />);
  expect(getClientSettings().speechOutputDestination).toBeNull();
  await expect
    .element(screen.getByRole("button", { name: "Download Piper" }))
    .not.toBeInTheDocument();
  await screen.getByRole("combobox", { name: "Read aloud with" }).click();
  await page.getByRole("option", { name: "Speech server", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Download Piper" })).toBeVisible();
  expect(getClientSettings().speechOutputDestination).toEqual({
    environmentId: prepared.environmentId,
    engine: "piper",
  });
  await screen.getByRole("button", { name: "Download Piper" }).click();
  await expect.element(screen.getByRole("button", { name: "Remove Piper" })).toBeVisible();
  vi.mocked(useEnvironmentScope).mockReturnValue(false);
  await screen.rerender(<SpeechOutputSettings key="read-only-destination" />);
  await expect.element(screen.getByRole("button", { name: "Remove Piper" })).toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Use voice", exact: true }))
    .toBeEnabled();
  await screen.getByRole("button", { name: "Use voice", exact: true }).click();
  expect(getClientSettings().speechOutputDestination).toEqual({
    environmentId: prepared.environmentId,
    engine: "piper",
    voice: "pt_BR-faber-medium",
  });
  expect(selectEnvironmentSpeechVoice).not.toHaveBeenCalled();
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  const removal = Promise.withResolvers<SpeechSynthesisVoices>();
  vi.mocked(removeEnvironmentSpeechVoice).mockImplementation(() =>
    Effect.promise(() => removal.promise),
  );
  await screen.rerender(<SpeechOutputSettings key="remove-selected" />);
  await screen.getByRole("button", { name: "Remove voice", exact: true }).click();
  const otherVoice = { ...voices[0]!, id: "pt_BR-other-medium", name: "Other" };
  await updateClientSettings({
    speechOutputDestination: {
      environmentId: prepared.environmentId,
      engine: "piper",
      voice: otherVoice.id,
    },
  });
  await screen.rerender(<SpeechOutputSettings key="remove-selected" />);
  voices = [{ ...voices[0]!, state: "downloadable", active: false }, otherVoice];
  removal.resolve({ voices, runtime });
  await expect.element(screen.getByRole("button", { name: "Selected", exact: true })).toBeVisible();
  expect(getClientSettings().speechOutputDestination?.voice).toBe(otherVoice.id);

  voices = [{ ...voices[0]!, state: "installed" }, otherVoice];
  await updateClientSettings({
    speechOutputDestination: {
      environmentId: prepared.environmentId,
      engine: "piper",
      voice: voices[0]!.id,
    },
  });
  vi.mocked(removeEnvironmentSpeechVoice).mockImplementation(() =>
    Effect.sync(() => {
      voices = [{ ...voices[0]!, state: "downloadable", active: false }, otherVoice];
      return { voices, runtime };
    }),
  );
  await screen.rerender(<SpeechOutputSettings key="remove-current-selection" />);
  await screen.getByRole("button", { name: "Remove voice", exact: true }).click();
  await vi.waitFor(() => expect(getClientSettings().speechOutputDestination?.voice).toBeNull());
  await screen.getByRole("combobox", { name: "Read aloud with" }).click();
  await page.getByRole("option", { name: "Off", exact: true }).click();
  expect(getClientSettings().speechOutputDestination).toBeNull();
  await screen.getByRole("combobox", { name: "Playback speed" }).click();
  await page.getByRole("option", { name: "1.5×", exact: true }).click();
  expect(getClientSettings().speechPlaybackRate).toBe(1.5);
  await screen.getByRole("combobox", { name: "Read aloud with" }).click();
  await page.getByRole("option", { name: "System voices", exact: true }).click();
  await screen.getByRole("combobox", { name: "Read aloud with" }).click();
  await expect
    .element(page.getByRole("option", { name: "Chosen environment (unavailable)" }))
    .not.toBeInTheDocument();
});

it("configures cloud keys in a dialog before loading and choosing account voices", async () => {
  setup();
  vi.mocked(useEnvironmentScope).mockReturnValue(true);

  const prepared = connection("cloud-speech");
  vi.mocked(getEnvironmentSpeechVoices).mockImplementation(() =>
    Effect.succeed({
      voices: [],
      providers: [
        {
          id: "openai" as const,
          name: "OpenAI",
          configured: true,
          defaultVoice: "coral",
          voices: [
            { id: "coral", name: "Clear" },
            { id: "nova", name: "Warm" },
          ],
        },
      ],
    }),
  );
  let settings = {
    ...DEFAULT_SERVER_SETTINGS,
    secretProviders: {
      work: { kind: "one_password", label: "Work vault", config: { account: "work" } },
    },
  };
  const environment = {
    environmentId: prepared.environmentId,
    label: "Cloud server",
    connection: { phase: "connected" },
    serverConfig: {
      settings,
      secretReferences: true,
      environment: { capabilities: { voiceSynthesis: true } },
    },
  } as unknown as EnvironmentPresentation;
  vi.mocked(useEnvironments).mockReturnValue({
    environments: [environment],
    isReady: true,
    networkStatus: "online",
    presentationById: new Map(),
  } as ReturnType<typeof useEnvironments>);
  vi.mocked(usePreparedConnection).mockReturnValue(Option.some(prepared));
  const merged = () => mergeEnvironmentSettings(settings, DEFAULT_CLIENT_SETTINGS);
  const read = ((_id, selector) =>
    selector ? selector(merged()) : merged()) as typeof useEnvironmentSettings;
  const write: ReturnType<typeof useUpdateEnvironmentSettings> = (patch) =>
    cloudSettings.voice(patch);
  cloudSettings.save.mockImplementation(async ({ input }) => {
    if (input.patch.speechOutput)
      settings = {
        ...settings,
        speechOutput: {
          ...settings.speechOutput,
          elevenLabsApiKey:
            typeof input.patch.speechOutput.elevenLabsApiKey === "string"
              ? "••••••"
              : input.patch.speechOutput.elevenLabsApiKey,
        },
      };
    else
      settings = {
        ...settings,
        cloudSpeechCredentials: { ...settings.cloudSpeechCredentials, openai: "••••••" },
      };
    Object.assign(environment, { serverConfig: { ...environment.serverConfig, settings } });
    return { _tag: "Success" };
  });
  vi.mocked(getElevenLabsSpeechVoices).mockImplementation((_connection, payload) =>
    Effect.succeed(
      payload?.pageToken
        ? {
            voices: [
              { id: "george", name: "George" },
              { id: "lia", name: "Lia" },
            ],
          }
        : { voices: [{ id: "george", name: "George" }], nextPageToken: "next" },
    ),
  );
  vi.mocked(getElevenLabsSpeechVoices).mockClear();
  await vi.mocked(useEnvironmentSettings).withImplementation(read, async () => {
    await vi.mocked(useUpdateEnvironmentSettings).withImplementation(
      () => write,
      async () => {
        await using screen = await render(<SpeechOutputSettings />);
        await screen.getByRole("combobox", { name: "Read aloud with" }).click();
        await page.getByRole("option", { name: "OpenAI", exact: true }).click();
        await expect
          .element(page.getByRole("dialog", { name: "Add OpenAI API key" }))
          .toBeVisible();
        expect(getClientSettings().speechOutputDestination).toBeNull();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
        await screen.getByRole("combobox", { name: "Read aloud with" }).click();
        await page.getByRole("option", { name: "Cloud server", exact: true }).click();
        const previous = { environmentId: prepared.environmentId, engine: "piper" };
        expect(getClientSettings().speechOutputDestination).toEqual(previous);
        for (const provider of ["OpenAI", "ElevenLabs"]) {
          for (const dismissal of ["Cancel", "Close", "Escape"]) {
            await screen.getByRole("combobox", { name: "Read aloud with" }).click();
            await page.getByRole("option", { name: provider, exact: true }).click();
            await expect
              .element(page.getByRole("dialog", { name: `Add ${provider} API key` }))
              .toBeVisible();
            await page
              .getByLabelText(`${provider} API key`, { exact: true })
              .fill("unsaved-fixture");
            expect(getClientSettings().speechOutputDestination).toEqual(previous);
            if (dismissal === "Escape") await userEvent.keyboard("{Escape}");
            else await page.getByRole("button", { name: dismissal, exact: true }).click();
            await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
            expect(getClientSettings().speechOutputDestination).toEqual(previous);
            await expect
              .element(screen.getByRole("combobox", { name: "Read aloud with" }))
              .toHaveTextContent("Cloud server");
          }
        }
        await screen.getByRole("combobox", { name: "Read aloud with" }).click();
        await page.getByRole("option", { name: "ElevenLabs", exact: true }).click();
        await expect.element(page.getByRole("dialog")).toBeVisible();
        await page.getByLabelText("ElevenLabs API key", { exact: true }).fill("lost-on-reload");
        await screen.rerender(<SpeechOutputSettings key="reloaded" />);
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
        expect(getClientSettings().speechOutputDestination).toEqual(previous);
        expect(cloudSettings.save).not.toHaveBeenCalled();
        await screen.getByRole("combobox", { name: "Read aloud with" }).click();
        await page.getByRole("option", { name: "ElevenLabs", exact: true }).click();
        await expect
          .element(page.getByRole("dialog", { name: "Add ElevenLabs API key" }))
          .toBeVisible();
        await expect
          .element(screen.getByRole("combobox", { name: "ElevenLabs voice" }))
          .not.toBeInTheDocument();
        expect(getElevenLabsSpeechVoices).not.toHaveBeenCalled();
        await page.getByLabelText("ElevenLabs API key", { exact: true }).fill("eleven-fixture");
        cloudSettings.save.mockResolvedValueOnce({ _tag: "Failure" });
        await page.getByRole("button", { name: "Save key", exact: true }).click();
        await vi.waitFor(() => expect(cloudSettings.save).toHaveBeenCalledOnce());
        await expect.element(page.getByRole("dialog")).toBeVisible();
        expect(getClientSettings().speechOutputDestination).toEqual(previous);
        await page.getByRole("button", { name: "Save key", exact: true }).click();
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
        expect(getClientSettings().speechOutputDestination).toEqual({
          environmentId: prepared.environmentId,
          engine: "elevenlabs",
        });
        expect(cloudSettings.save).toHaveBeenLastCalledWith({
          environmentId: prepared.environmentId,
          input: { patch: { speechOutput: { elevenLabsApiKey: "eleven-fixture" } } },
        });
        await screen.getByRole("button", { name: "Load more voices" }).click();
        await vi.waitFor(() =>
          expect(getElevenLabsSpeechVoices).toHaveBeenLastCalledWith(prepared, {
            pageToken: "next",
          }),
        );
        await screen.getByRole("combobox", { name: "ElevenLabs voice" }).click();
        await page.getByRole("option", { name: "Lia", exact: true }).click();
        expect(getClientSettings().speechOutputDestination).toEqual({
          environmentId: environment.environmentId,
          engine: "elevenlabs",
          voice: "lia",
        });
        expect(cloudSettings.voice).not.toHaveBeenCalled();
        await screen.getByRole("button", { name: "Manage key…", exact: true }).click();
        await page.getByRole("combobox", { name: "ElevenLabs API key source" }).click();
        await page.getByRole("option", { name: "Work vault", exact: true }).click();
        await page
          .getByLabelText("ElevenLabs API key reference", { exact: true })
          .fill("op://Private/Voice/key");
        await page.getByRole("button", { name: "Save key", exact: true }).click();
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
        expect(cloudSettings.save).toHaveBeenLastCalledWith({
          environmentId: prepared.environmentId,
          input: {
            patch: {
              speechOutput: {
                elevenLabsApiKey: { provider: "work", reference: "op://Private/Voice/key" },
              },
            },
          },
        });
        await screen.getByRole("combobox", { name: "Read aloud with" }).click();
        await page.getByRole("option", { name: "OpenAI", exact: true }).click();
        await expect
          .element(page.getByRole("dialog", { name: "Add OpenAI API key" }))
          .toBeVisible();
        await expect
          .element(screen.getByRole("combobox", { name: "Speech output voice" }))
          .not.toBeInTheDocument();
        expect(getClientSettings().speechOutputDestination).toEqual({
          environmentId: prepared.environmentId,
          engine: "elevenlabs",
          voice: "lia",
        });
        await page.getByLabelText("OpenAI API key", { exact: true }).fill("openai-fixture");
        await page.getByRole("button", { name: "Save key", exact: true }).click();
        await expect
          .element(screen.getByRole("combobox", { name: "Speech output voice" }))
          .toBeVisible();
        expect(cloudSettings.save).toHaveBeenLastCalledWith({
          environmentId: prepared.environmentId,
          input: { patch: { cloudSpeechCredentials: { openai: "openai-fixture" } } },
        });
        await screen.getByRole("combobox", { name: "Speech output voice" }).click();
        await page.getByRole("option", { name: "Warm", exact: true }).click();
        expect(getClientSettings().speechOutputDestination).toMatchObject({
          engine: "openai",
          voice: "nova",
        });
        expect(getClientSettings().speechOutputDestination).toEqual({
          environmentId: prepared.environmentId,
          engine: "openai",
          voice: "nova",
        });
        await screen.getByRole("combobox", { name: "Read aloud with" }).click();
        await page.getByRole("option", { name: "ElevenLabs", exact: true }).click();
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
        expect(getClientSettings().speechOutputDestination).toEqual({
          environmentId: prepared.environmentId,
          engine: "elevenlabs",
        });
      },
    );
  });
});
