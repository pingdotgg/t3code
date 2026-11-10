import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "~/index.css";
import { chooseAudioDestination } from "../../speech/voiceConsent";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";
import { SettingsScopeProvider } from "./SettingsScopeContext";

vi.mock(import("../../state/session"), { spy: true });
const persistedSettings: unknown[] = [];
let configuredEndpoint = "";
function setup() {
  persistedSettings.length = 0;
  configuredEndpoint = "";
}
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: (() => async (input: unknown) => {
    persistedSettings.push(input);
    configuredEndpoint =
      typeof input === "object" &&
      input !== null &&
      "input" in input &&
      typeof input.input === "object" &&
      input.input !== null &&
      "patch" in input.input &&
      typeof input.input.patch === "object" &&
      input.input.patch !== null &&
      "cloudSpeechCustomBaseUrl" in input.input.patch &&
      typeof input.input.patch.cloudSpeechCustomBaseUrl === "string"
        ? input.input.patch.cloudSpeechCustomBaseUrl
        : configuredEndpoint;
    return { _tag: "Success" };
  }) as never,
}));
vi.mock("../../env", async (original) => ({
  ...(await original<typeof import("../../env")>()),
  isSecretsFeatureEnabled: true,
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "voice-host",
        label: "Laptop",
        connection: { phase: "available" },
        serverConfig: {
          secretReferences: true,
          settings: {
            secretProviders: {
              work: { kind: "one_password", label: "Work vault", config: { account: "work" } },
            },
            cloudSpeechCustomBaseUrl: configuredEndpoint,
          },
          environment: {
            platform: { os: "linux", arch: "x64" },
            capabilities: { voiceTranscription: true, cloudVoiceTranscription: true },
          },
        },
      },
    ],
  }),
}));

it("enables the chosen provider only after a successful setup and keeps its grant when editing the key", async () => {
  const id = EnvironmentId.make("voice-host");
  const target = new PrimaryConnectionTarget({
    environmentId: id,
    label: "Laptop",
    httpBaseUrl: window.location.origin,
    wsBaseUrl: "ws://localhost",
  });
  const prepared = Option.some({
    ...target,
    target,
    socketUrl: target.wsBaseUrl,
    httpAuthorization: null,
  });
  using cleanup = new DisposableStack();
  cleanup.defer(() => chooseAudioDestination(null));
  chooseAudioDestination({ kind: "environment", environmentId: id });
  const writes: unknown[] = [];
  let rejectNextWrite = true;
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
    const url = new URL(request instanceof Request ? request.url : request, window.location.href);
    if (url.pathname === "/api/voice/cloud/keys")
      return Promise.resolve(Response.json({ openai: writes.length > 0, xai: true }));
    if (url.pathname === "/api/voice/cloud/openai/key") {
      if (rejectNextWrite) {
        rejectNextWrite = false;
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      return new Request(request, init).json().then((body) => {
        writes.push(body);
        return new Response(null, { status: 204 });
      });
    }
    return fetch(request, init);
  });
  await vi.mocked(useEnvironmentScope).withImplementation(
    () => true,
    async () => {
      await vi.mocked(usePreparedConnection).withImplementation(
        () => prepared,
        async () => {
          await using screen = await render(
            <SettingsScopeProvider search={{}} onChange={() => {}}>
              <VoiceSettingsPanel />
            </SettingsScopeProvider>,
          );
          const destination = screen.getByRole("combobox", { name: "Transcribe with" });
          await expect.element(destination).toHaveTextContent("Laptop");
          await destination.click();
          await page.getByRole("option", { name: "OpenAI via Laptop" }).click();
          const dialog = page.getByRole("dialog");
          await dialog.getByRole("button", { name: "Cancel" }).click();
          await expect.element(destination).toHaveTextContent("Laptop");
          expect(writes).toEqual([]);
          await destination.click();
          await page.getByRole("option", { name: "OpenAI via Laptop" }).click();
          await dialog.getByRole("combobox", { name: "OpenAI API key source" }).click();
          await page.getByRole("option", { name: "Work vault" }).click();
          await dialog.getByLabelText("OpenAI API key reference").fill("op://Work/Voice/key");
          await userEvent.keyboard("{Enter}");
          await expect.element(dialog.getByRole("alert")).toBeVisible();
          expect(writes).toEqual([]);
          await expect
            .element(dialog.getByRole("button", { name: "Save and enable" }))
            .toBeEnabled();
          await dialog.getByLabelText("OpenAI API key reference").click();
          await userEvent.keyboard("{Enter}");
          await expect.element(dialog).not.toBeInTheDocument();
          await expect.element(destination).toHaveTextContent("OpenAI via Laptop");
          expect(writes).toEqual([{ key: { provider: "work", reference: "op://Work/Voice/key" } }]);
          const grant = window.localStorage.getItem("t3code:voice-audio-grant:v1");
          await screen.getByRole("button", { name: "Manage key" }).click();
          await dialog.getByLabelText("OpenAI API key", { exact: true }).fill("replacement");
          await userEvent.keyboard("{Enter}");
          await expect.element(dialog).not.toBeInTheDocument();
          expect(writes.at(-1)).toEqual({ key: "replacement" });
          expect(window.localStorage.getItem("t3code:voice-audio-grant:v1")).toBe(grant);
          await destination.click();
          await page.getByRole("option", { name: "Grok Voice Transcribe via Laptop" }).click();
          await dialog.getByRole("button", { name: "Use Grok Voice Transcribe" }).click();
          await expect.element(destination).toHaveTextContent("Grok Voice Transcribe via Laptop");
          await destination.click();
          await page.getByRole("option", { name: "Off", exact: true }).click();
          await expect.element(destination).toHaveTextContent("Off");
        },
      );
    },
  );
});

it("OpenRouter needs an exact model, and changing it writes no credential", async () => {
  const id = EnvironmentId.make("voice-host");
  const target = new PrimaryConnectionTarget({
    environmentId: id,
    label: "Laptop",
    httpBaseUrl: window.location.origin,
    wsBaseUrl: "ws://localhost",
  });
  const prepared = Option.some({
    ...target,
    target,
    socketUrl: target.wsBaseUrl,
    httpAuthorization: null,
  });
  using cleanup = new DisposableStack();
  cleanup.defer(() => chooseAudioDestination(null));
  chooseAudioDestination(null);
  const writes: unknown[] = [];
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
    const url = new URL(request instanceof Request ? request.url : request, window.location.href);
    if (url.pathname === "/api/voice/cloud/keys")
      return Promise.resolve(Response.json({ openai: false, xai: false, openrouter: true }));
    if (url.pathname === "/api/voice/cloud/openrouter/models")
      return Promise.resolve(
        Response.json({
          models: [
            { id: "acme/transcribe-1", name: "Acme: Transcribe 1" },
            { id: "other/listen-2", name: "Other: Listen 2" },
          ],
        }),
      );
    if (url.pathname === "/api/voice/cloud/openrouter/key")
      return new Request(request, init).json().then((body) => {
        writes.push(body);
        return new Response(null, { status: 204 });
      });
    return fetch(request, init);
  });
  const grantKey = "t3code:voice-audio-grant:v1";
  const grantModel = () => {
    const raw = window.localStorage.getItem(grantKey);
    const parsed = raw ? (JSON.parse(raw) as { destination?: { model?: string } }) : null;
    return parsed?.destination?.model ?? null;
  };
  await vi.mocked(useEnvironmentScope).withImplementation(
    () => true,
    async () => {
      await vi.mocked(usePreparedConnection).withImplementation(
        () => prepared,
        async () => {
          await using screen = await render(
            <SettingsScopeProvider search={{}} onChange={() => {}}>
              <VoiceSettingsPanel />
            </SettingsScopeProvider>,
          );
          const destination = screen.getByRole("combobox", { name: "Transcribe with" });
          await destination.click();
          await page.getByRole("option", { name: "OpenRouter via Laptop" }).click();
          const dialog = page.getByRole("dialog");
          const save = dialog.getByRole("button", { name: "Save and enable" });
          await expect.element(save).toBeDisabled();
          const picker = dialog.getByRole("combobox", { name: "OpenRouter model" });
          await expect.element(picker).toBeVisible();
          await picker.click();
          await userEvent.keyboard("listen");
          await expect.element(page.getByRole("option", { name: /Other: Listen 2/ })).toBeVisible();
          await page.getByRole("option", { name: /Other: Listen 2/ }).click();
          await expect.element(save).toBeEnabled();
          const key = dialog.getByLabelText("OpenRouter API key", { exact: true });
          await key.fill("op://not-a-literal-key");
          await expect.element(save).toBeDisabled();
          await key.fill("");
          await save.click();
          await expect.element(dialog).not.toBeInTheDocument();
          await expect.element(destination).toHaveTextContent("OpenRouter via Laptop");
          expect(grantModel()).toBe("other/listen-2");
          expect(writes).toEqual([]);
          await screen.getByRole("button", { name: "Manage OpenRouter" }).click();
          const current = dialog.getByRole("combobox", { name: "OpenRouter model" });
          await expect.element(current).toHaveValue("Other: Listen 2");
          await userEvent.clear(current);
          await userEvent.type(current, "acme");
          await page.getByRole("option", { name: /Acme: Transcribe 1/ }).click();
          await dialog.getByRole("button", { name: "Save" }).click();
          await expect.element(dialog).not.toBeInTheDocument();
          await expect.element(destination).toHaveTextContent("OpenRouter via Laptop");
          expect(grantModel()).toBe("acme/transcribe-1");
          expect(writes).toEqual([]);
        },
      );
    },
  );
});

it("configures a custom OpenAI-compatible endpoint with its URL, model, and key", async () => {
  setup();
  const id = EnvironmentId.make("voice-host");
  const target = new PrimaryConnectionTarget({
    environmentId: id,
    label: "Laptop",
    httpBaseUrl: window.location.origin,
    wsBaseUrl: "ws://localhost",
  });
  const prepared = Option.some({
    ...target,
    target,
    socketUrl: target.wsBaseUrl,
    httpAuthorization: null,
  });
  using cleanup = new DisposableStack();
  cleanup.defer(() => chooseAudioDestination(null));
  chooseAudioDestination(null);
  const writes: unknown[] = [];
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
    const url = new URL(request instanceof Request ? request.url : request, window.location.href);
    if (url.pathname === "/api/voice/cloud/keys")
      return Promise.resolve(Response.json({ openai: true, xai: true, custom: true }));
    if (url.pathname === "/api/voice/cloud/openrouter/models")
      return Promise.resolve(Response.json({ models: [] }));
    if (url.pathname === "/api/voice/cloud/custom/key")
      return new Request(request, init).json().then((body) => {
        writes.push(body);
        return new Response(null, { status: 204 });
      });
    return fetch(request, init);
  });
  const grantDestination = () => {
    const raw = window.localStorage.getItem("t3code:voice-audio-grant:v1");
    const parsed = raw
      ? (JSON.parse(raw) as {
          destination?: Record<string, unknown>;
          pending?: { destination?: Record<string, unknown> };
        })
      : null;
    return parsed?.destination ?? parsed?.pending?.destination ?? null;
  };
  await vi.mocked(useEnvironmentScope).withImplementation(
    () => true,
    async () => {
      await vi.mocked(usePreparedConnection).withImplementation(
        () => prepared,
        async () => {
          await using screen = await render(
            <SettingsScopeProvider search={{}} onChange={() => {}}>
              <VoiceSettingsPanel />
            </SettingsScopeProvider>,
          );
          const destination = screen.getByRole("combobox", { name: "Transcribe with" });
          await destination.click();
          await page.getByRole("option", { name: "Custom endpoint via Laptop" }).click();
          const dialog = page.getByRole("dialog");
          const save = dialog.getByRole("button", { name: "Save and enable" });
          await expect.element(save).toBeDisabled();
          await dialog
            .getByLabelText("Custom endpoint API key", { exact: true })
            .fill("custom-key");
          await dialog.getByRole("textbox", { name: "Transcription model" }).fill("whisper-1");
          const endpoint = dialog.getByRole("textbox", { name: "Endpoint base URL" });
          await endpoint.fill("http://insecure.example.com/v1");
          await expect.element(save).toBeDisabled();
          await endpoint.fill("https://stt.example.com/v1");
          await expect
            .element(dialog.getByText("your endpoint at stt.example.com", { exact: false }))
            .toBeVisible();
          await userEvent.keyboard("{Enter}");
          await expect.element(dialog).not.toBeInTheDocument();
          await expect.element(destination).toHaveTextContent("Custom endpoint via Laptop");
          expect(persistedSettings).toEqual([
            {
              environmentId: id,
              input: { patch: { cloudSpeechCustomBaseUrl: "https://stt.example.com/v1" } },
            },
          ]);
          expect(writes).toEqual([{ key: "custom-key" }]);
          expect(grantDestination()).toMatchObject({
            provider: "custom",
            environmentId: "voice-host",
            model: "whisper-1",
            endpoint: "https://stt.example.com/v1",
          });
        },
      );
    },
  );
});
