// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  start: vi.fn(),
  refresh: vi.fn(),
  openExternal: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string | null) => ({
    data:
      query === "auth"
        ? mocks.auth
        : query === "install"
          ? {
              phase: "idle",
              installedVersion: "0.156.1",
              version: "0.156.1",
              source: "local",
            }
          : null,
    error: null,
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: () => "auth",
    providerInstallState: () => "install",
    startProviderAuth: "start",
    refreshProviders: "refresh",
    cancelProviderAuth: "cancel",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "start"
      ? mocks.start
      : command === "refresh"
        ? mocks.refresh
        : command === "cancel"
          ? mocks.cancel
          : vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => "http://127.0.0.1:15041",
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
  useEnvironment: () => null,
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));
vi.mock("./ChatGptAccountPicker", () => ({ ChatGptAccountPicker: () => null }));
vi.mock("./ChatGptUsageButton", () => ({ ChatGptUsageButton: () => null }));
vi.mock("./AddCodexAccountDialog", () => ({ AddCodexAccountDialog: () => null }));
vi.mock("./RedactedSensitiveText", () => ({
  RedactedSensitiveText: () => <span>Account email</span>,
}));

import { CodexSetupSection } from "./CodexSetupSection";

const environmentId = EnvironmentId.make("test");
const instanceId = ProviderInstanceId.make("codex_test");
let root: Root;
let container: HTMLDivElement;
let provider: ServerProvider;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.auth = {
    instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    methods: [],
  };
  mocks.start.mockReset().mockImplementation(async () => {
    mocks.auth = {
      ...mocks.auth!,
      phase: "starting",
      flowId: "flow-test" as ProviderAuthState["flowId"],
    };
    return { _tag: "Success", value: mocks.auth };
  });
  mocks.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.openExternal.mockReset().mockResolvedValue(undefined);
  mocks.cancel.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  provider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "ChatGPT - Personal",
    installed: true,
    enabled: true,
    version: "0.156.1",
    status: "ready",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-09-28T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
    setup: { canAuthenticate: true, canInstall: true },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(
  autoStart = false,
  currentProvider: ServerProvider | null = provider,
  presentation: "onboarding" | "settings" = "onboarding",
  onSignInCancelled?: () => void,
) {
  await act(async () =>
    root.render(
      <CodexSetupSection
        environmentId={environmentId}
        instanceId={instanceId}
        provider={currentProvider ?? undefined}
        displayName="ChatGPT - Personal"
        autoStart={autoStart}
        mode="managed"
        enabled
        presentation={presentation}
        onModeChange={() => {}}
        onSignInCancelled={onSignInCancelled}
      />,
    ),
  );
}
async function signIn() {
  await render();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Continue with ChatGPT"))!
      .click(),
  );
  mocks.auth = { ...mocks.auth!, phase: "verifying", message: "Checking provider sign-in." };
  await render();
}
it("keeps successful sign-in pending until the provider snapshot arrives", async () => {
  await signIn();
  mocks.auth = {
    ...mocks.auth!,
    phase: "succeeded",
    message: "Sign-in complete.",
    methods: [{ id: "chatgpt-profile:test", name: "Personal", description: null, type: "agent" }],
  };
  await render();
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.refresh).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  expect(container.textContent).toContain("Finishing sign-in...");
  expect(container.textContent).not.toContain("Reconnect account");
  expect(container.textContent).not.toContain("Use a different account");
  expect(container.textContent).not.toContain("Cancel");
  expect(container.querySelector("button")?.disabled).toBe(true);
  provider = { ...provider, auth: { status: "authenticated", subscriptionSharing: true } };
  await render();
  expect(container.textContent).toContain("Ready");
  expect(container.textContent).not.toContain("Finishing sign-in...");
  // A later loss of credentials must allow reconnecting rather than wait forever.
  provider = { ...provider, auth: { status: "unauthenticated" } };
  await render();
  expect(container.textContent).toContain("Reconnect account");
  expect(container.textContent).not.toContain("Finishing sign-in...");
});
it("lets a failed sign-in retry instead of waiting for an authenticated snapshot", async () => {
  await signIn();
  mocks.auth = { ...mocks.auth!, phase: "failed", message: "Sign-in could not finish." };
  await render();
  expect(container.textContent).toContain("Sign-in could not finish.");
  expect(container.textContent).not.toContain("Finishing sign-in...");
  expect(
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Continue with ChatGPT"),
    )?.disabled,
  ).toBe(false);
});
it("keeps one subtitle while starting sign-in and exposes help on that line", async () => {
  vi.stubGlobal("desktopBridge", {
    receiveProviderAuthCallback: vi.fn(() => new Promise<string>(() => {})),
  });
  await render();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Continue with ChatGPT"))!
      .click(),
  );
  mocks.auth = { ...mocks.auth!, phase: "starting", message: "Starting sign-in." };
  await render();
  expect(container.textContent).not.toContain("Starting sign-in.");
  expect(container.textContent).toContain("Complete sign-in in your browser.");
  mocks.auth = {
    ...mocks.auth!,
    phase: "waiting",
    message: "Complete sign-in to continue.",
    authorizationUrl: "https://auth.openai.com/test-sign-in",
  };
  await render();
  expect(container.textContent?.match(/Complete sign-in in your browser\./g)).toHaveLength(1);
  expect(container.textContent).not.toContain("Complete sign-in to continue.");
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Having trouble signing in?"]',
  );
  expect(trigger?.textContent).toBe("Complete sign-in in your browser.");
  expect(container.querySelector('input[aria-label="ChatGPT sign-in redirect URL"]')).toBeNull();
  await act(async () => trigger!.click());
  expect(
    container.querySelector('input[aria-label="ChatGPT sign-in redirect URL"]'),
  ).not.toBeNull();
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="ChatGPT sign-in redirect URL"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "http://localhost/callback?code=test",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => trigger!.click());
  expect(container.querySelector('input[aria-label="ChatGPT sign-in redirect URL"]')).toBeNull();
  await act(async () => trigger!.click());
  expect(
    container.querySelector<HTMLInputElement>('input[aria-label="ChatGPT sign-in redirect URL"]')
      ?.value,
  ).toBe("http://localhost/callback?code=test");
  expect(mocks.start).toHaveBeenCalledTimes(1);
});

it("keeps a newly added account pending across delayed provider and auth snapshots", async () => {
  let finishStart = () => {};
  mocks.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishStart = () => resolve({ _tag: "Success", value: mocks.auth });
      }),
  );
  await render(true, null);
  expect(container.textContent).toContain("ChatGPT - Personal");
  expect(container.textContent).toContain("Complete sign-in in your browser.");
  expect(container.textContent).not.toContain("Continue with ChatGPT");
  expect(mocks.start).not.toHaveBeenCalled();

  await render(true);
  expect(mocks.start).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain("Continue with ChatGPT");
  expect(container.textContent).not.toContain("Starting sign-in");
  expect(container.textContent).toContain("Open sign-in page");
  await act(async () => finishStart());
  await render(false);
  expect(container.textContent).not.toContain("Finishing sign-in");
  expect(container.textContent).not.toContain("Continue with ChatGPT");
  expect(container.textContent).toContain("Open sign-in page");
  expect(container.textContent).toContain("Complete sign-in in your browser.");
  const idleAuth = mocks.auth;
  mocks.auth = null;
  await render(false);
  expect(container.textContent).not.toContain("Finishing sign-in");
  expect(container.textContent).not.toContain("Continue with ChatGPT");
  expect(container.textContent).toContain("Open sign-in page");
  expect(container.textContent).toContain("Complete sign-in in your browser.");
  mocks.auth = idleAuth;
  mocks.auth = {
    ...mocks.auth!,
    phase: "waiting",
    authorizationUrl: "https://auth.openai.com/test",
  };
  await render(false);
  expect(container.textContent).toContain("Open sign-in page");
  expect(mocks.start).toHaveBeenCalledTimes(1);
});

it("offers callback recovery in the local web settings dialog with a server-owned callback", async () => {
  mocks.auth = {
    ...mocks.auth!,
    phase: "waiting",
    flowId: "flow-test" as ProviderAuthState["flowId"],
    authorizationUrl: "https://auth.openai.com/test-sign-in",
  };
  await render(false, provider, "settings");
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Having trouble signing in?"]',
  );
  expect(trigger).not.toBeNull();
  expect(container.querySelector('input[aria-label="ChatGPT sign-in redirect URL"]')).toBeNull();
  await act(async () => trigger!.click());
  expect(
    container.querySelector('input[aria-label="ChatGPT sign-in redirect URL"]'),
  ).not.toBeNull();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Try sign-in in your browser"))!
      .click(),
  );
  expect(mocks.openExternal).toHaveBeenCalledWith("https://auth.openai.com/test-sign-in");
});

it("dismisses account setup immediately when cancelling a pending sign-in", async () => {
  let finishCancellation!: () => void;
  mocks.cancel.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishCancellation = () => resolve({ _tag: "Success", value: undefined });
      }),
  );
  mocks.auth = {
    ...mocks.auth!,
    phase: "waiting",
    flowId: "flow-test" as ProviderAuthState["flowId"],
    authorizationUrl: "https://auth.openai.com/test-sign-in",
  };
  await render(false, provider, "settings", () => root.render(null));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Cancel")!
      .click(),
  );
  expect(container.querySelector('[aria-label="Codex setup"]')).toBeNull();
  expect(container.textContent).not.toContain("Continue with ChatGPT");
  expect(mocks.cancel).toHaveBeenCalledWith({
    environmentId,
    input: { instanceId, flowId: "flow-test" },
  });
  await act(async () => finishCancellation());
});
