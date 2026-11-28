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
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "voice-host",
        label: "Laptop",
        connection: { phase: "available" },
        serverConfig: {
          featureFlags: { secretProviders: true },
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

const id = EnvironmentId.make("voice-host");
const grantKey = "t3code:voice-audio-grant:v1";

async function withVoicePanel(
  route: (url: URL, request: RequestInfo | URL, init?: RequestInit) => Promise<Response> | null,
  body: (screen: Awaited<ReturnType<typeof render>>) => Promise<void>,
) {
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
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
    const url = new URL(request instanceof Request ? request.url : request, window.location.href);
    return route(url, request, init) ?? fetch(request, init);
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
          await body(screen);
        },
      );
    },
  );
}

it("cancelling a provider's setup keeps the current destination and writes nothing", async () => {
  chooseAudioDestination({ kind: "environment", environmentId: id });
  const writes: unknown[] = [];
  await withVoicePanel(
    (url, request, init) => {
      if (url.pathname === "/api/voice/cloud/keys")
        return Promise.resolve(Response.json({ openai: false, xai: true }));
      if (url.pathname !== "/api/voice/cloud/openai/key") return null;
      return new Request(request, init).json().then((body) => {
        writes.push(body);
        return new Response(null, { status: 204 });
      });
    },
    async (screen) => {
      const destination = screen.getByRole("combobox", { name: "Transcribe with" });
      await expect.element(destination).toHaveTextContent("Laptop");
      await destination.click();
      await page.getByRole("option", { name: "OpenAI via Laptop" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect.element(dialog).not.toBeInTheDocument();
      await expect.element(destination).toHaveTextContent("Laptop");
      expect(writes).toEqual([]);
    },
  );
});

it("enables the chosen provider only after a successful setup", async () => {
  chooseAudioDestination({ kind: "environment", environmentId: id });
  const writes: unknown[] = [];
  let rejectNextWrite = true;
  await withVoicePanel(
    (url, request, init) => {
      if (url.pathname === "/api/voice/cloud/keys")
        return Promise.resolve(Response.json({ openai: writes.length > 0, xai: true }));
      if (url.pathname !== "/api/voice/cloud/openai/key") return null;
      if (rejectNextWrite) {
        rejectNextWrite = false;
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      return new Request(request, init).json().then((body) => {
        writes.push(body);
        return new Response(null, { status: 204 });
      });
    },
    async (screen) => {
      const destination = screen.getByRole("combobox", { name: "Transcribe with" });
      await destination.click();
      await page.getByRole("option", { name: "OpenAI via Laptop" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("combobox", { name: "OpenAI API key source" }).click();
      await page.getByRole("option", { name: "Work vault" }).click();
      await dialog.getByLabelText("OpenAI API key reference").fill("op://Work/Voice/key");
      await userEvent.keyboard("{Enter}");
      await expect.element(dialog.getByRole("alert")).toBeVisible();
      expect(writes).toEqual([]);
      await expect.element(dialog.getByRole("button", { name: "Save and enable" })).toBeEnabled();
      await dialog.getByLabelText("OpenAI API key reference").click();
      await userEvent.keyboard("{Enter}");
      await expect.element(dialog).not.toBeInTheDocument();
      await expect.element(destination).toHaveTextContent("OpenAI via Laptop");
      expect(writes).toEqual([{ key: { provider: "work", reference: "op://Work/Voice/key" } }]);
    },
  );
});

it("keeps the active provider's grant when editing its key", async () => {
  chooseAudioDestination({ kind: "cloud", provider: "openai", environmentId: id });
  const grant = window.localStorage.getItem(grantKey);
  const writes: unknown[] = [];
  await withVoicePanel(
    (url, request, init) => {
      if (url.pathname === "/api/voice/cloud/keys")
        return Promise.resolve(Response.json({ openai: true, xai: true }));
      if (url.pathname !== "/api/voice/cloud/openai/key") return null;
      return new Request(request, init).json().then((body) => {
        writes.push(body);
        return new Response(null, { status: 204 });
      });
    },
    async (screen) => {
      await screen.getByRole("button", { name: "Manage key" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabelText("OpenAI API key", { exact: true }).fill("replacement");
      await userEvent.keyboard("{Enter}");
      await expect.element(dialog).not.toBeInTheDocument();
      expect(writes).toEqual([{ key: "replacement" }]);
      expect(window.localStorage.getItem(grantKey)).toBe(grant);
    },
  );
});

it("uses a provider's saved key without writing it, and turns dictation off", async () => {
  chooseAudioDestination({ kind: "environment", environmentId: id });
  await withVoicePanel(
    (url) =>
      url.pathname === "/api/voice/cloud/keys"
        ? Promise.resolve(Response.json({ openai: false, xai: true }))
        : null,
    async (screen) => {
      const destination = screen.getByRole("combobox", { name: "Transcribe with" });
      await destination.click();
      await page.getByRole("option", { name: "Grok Voice Transcribe via Laptop" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Use Grok Voice Transcribe" })
        .click();
      await expect.element(destination).toHaveTextContent("Grok Voice Transcribe via Laptop");
      await destination.click();
      await page.getByRole("option", { name: "Off", exact: true }).click();
      await expect.element(destination).toHaveTextContent("Off");
    },
  );
});

it("OpenRouter needs an exact model, and changing it writes no credential", async () => {
  chooseAudioDestination(null);
  const writes: unknown[] = [];
  const grantModel = () => {
    const raw = window.localStorage.getItem(grantKey);
    const parsed = raw ? (JSON.parse(raw) as { destination?: { model?: string } }) : null;
    return parsed?.destination?.model ?? null;
  };
  await withVoicePanel(
    (url, request, init) => {
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
      return null;
    },
    async (screen) => {
      const destination = screen.getByRole("combobox", { name: "Transcribe with" });
      await destination.click();
      await page.getByRole("option", { name: "OpenRouter via Laptop" }).click();
      const dialog = page.getByRole("dialog");
      const save = dialog.getByRole("button", { name: "Save and enable" });
      await expect.element(save).toBeDisabled();
      const picker = dialog.getByRole("combobox", { name: "OpenRouter model" });
      await expect.element(picker).toBeVisible();
      await picker.fill("listen");
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
      await current.fill("acme");
      await page.getByRole("option", { name: /Acme: Transcribe 1/ }).click();
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect.element(dialog).not.toBeInTheDocument();
      await expect.element(destination).toHaveTextContent("OpenRouter via Laptop");
      expect(grantModel()).toBe("acme/transcribe-1");
      expect(writes).toEqual([]);
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
          await dialog.getByLabelText("Model").fill("whisper-1");
          const endpoint = dialog.getByLabelText("Endpoint URL");
          await endpoint.fill("not-a-url");
          await expect.element(save).toBeDisabled();
          await expect.element(dialog.getByText("Enter an http or https URL.")).toBeVisible();
          await endpoint.fill("https://stt.example.com/v1");
          await expect
            .element(dialog.getByText("your endpoint at stt.example.com", { exact: false }))
            .toBeVisible();
          await userEvent.keyboard("{Enter}");
          await expect.element(dialog).not.toBeInTheDocument();
          await expect.element(destination).toHaveTextContent("Custom endpoint via Laptop");
          // The URL and the key are one consent: one settings write, no separate key request.
          expect(persistedSettings).toEqual([
            {
              environmentId: id,
              input: {
                patch: {
                  cloudSpeechCustomBaseUrl: "https://stt.example.com/v1",
                  cloudSpeechCredentials: { custom: "custom-key" },
                },
              },
            },
          ]);
          expect(writes).toEqual([]);
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

it("a grant for another endpoint asks for approval and writes no settings", async () => {
  setup();
  configuredEndpoint = "https://stt.example.com/v1";
  chooseAudioDestination({
    kind: "cloud",
    environmentId: EnvironmentId.make("voice-host"),
    provider: "custom",
    model: "whisper-1",
    endpoint: "https://old.example.com/v1",
  });
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
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
    const url = new URL(request instanceof Request ? request.url : request, window.location.href);
    if (url.pathname === "/api/voice/cloud/keys")
      return Promise.resolve(Response.json({ openai: true, xai: true, custom: true }));
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
          await destination.click();
          await page.getByRole("option", { name: "Custom endpoint via Laptop" }).click();
          const dialog = page.getByRole("dialog");
          await expect
            .element(dialog.getByText("Use Custom endpoint for dictation?"))
            .toBeVisible();
          const endpoint = dialog.getByLabelText("Endpoint URL");
          await expect.element(endpoint).toHaveValue("https://stt.example.com/v1");
          // Re-approving binds the device to the saved endpoint, and moves no server setting.
          await dialog.getByRole("button", { name: "Save and enable" }).click();
          await expect.element(dialog).not.toBeInTheDocument();
          expect(persistedSettings).toEqual([]);
          const raw = window.localStorage.getItem("t3code:voice-audio-grant:v1");
          expect(raw).toContain("https://stt.example.com/v1");
        },
      );
    },
  );
});

it("changing a saved endpoint asks for the key again", async () => {
  setup();
  configuredEndpoint = "https://stt.example.com/v1";
  chooseAudioDestination(null);
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
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
    const url = new URL(request instanceof Request ? request.url : request, window.location.href);
    if (url.pathname === "/api/voice/cloud/keys")
      return Promise.resolve(Response.json({ openai: true, xai: true, custom: true }));
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
          await destination.click();
          await page.getByRole("option", { name: "Custom endpoint via Laptop" }).click();
          const dialog = page.getByRole("dialog");
          await dialog.getByLabelText("Model").fill("whisper-1");
          const save = dialog.getByRole("button", { name: "Save and enable" });
          await expect.element(save).toBeEnabled();
          await dialog.getByLabelText("Endpoint URL").fill("https://other.example.com/v1");
          // The saved key does not follow a new URL, so the key is required again.
          await expect
            .element(dialog.getByText("Enter the key again for the new URL."))
            .toBeVisible();
          await expect.element(save).toBeDisabled();
          await dialog.getByLabelText("Custom endpoint API key", { exact: true }).fill("new-key");
          await expect.element(save).toBeEnabled();
          await save.click();
          await expect.element(dialog).not.toBeInTheDocument();
          expect(persistedSettings).toEqual([
            {
              environmentId: id,
              input: {
                patch: {
                  cloudSpeechCustomBaseUrl: "https://other.example.com/v1",
                  cloudSpeechCredentials: { custom: "new-key" },
                },
              },
            },
          ]);
        },
      );
    },
  );
});
