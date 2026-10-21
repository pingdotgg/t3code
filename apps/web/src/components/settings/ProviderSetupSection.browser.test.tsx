import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const setup = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  installation: null as ProviderInstallState | null,
  authState: vi.fn(() => "auth"),
  installState: vi.fn(() => "installation"),
  startAuth: vi.fn(),
  completeAuth: vi.fn(),
  respondAuth: vi.fn(),
  cancelAuth: vi.fn(),
  logoutAuth: vi.fn(),
  startInstall: vi.fn(),
  cancelInstall: vi.fn(),
  removeInstall: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providerAuthState: setup.authState as never,
      providerInstallState: setup.installState as never,
      startProviderAuth: setup.startAuth as never,
      completeProviderAuth: setup.completeAuth as never,
      respondProviderAuth: setup.respondAuth as never,
      cancelProviderAuth: setup.cancelAuth as never,
      logoutProviderAuth: setup.logoutAuth as never,
      startProviderInstall: setup.startInstall as never,
      cancelProviderInstall: setup.cancelInstall as never,
      removeProviderInstallation: setup.removeInstall as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
// The queries behave like live subscriptions: changing `setup.auth` and calling
// `publish()` re-renders the sections that read them.
const queryListeners = vi.hoisted(() => new Set<() => void>());
vi.mock(import("../../state/query"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    queryListeners.add(listener);
    return () => queryListeners.delete(listener);
  };
  return {
    ...(await original()),
    useEnvironmentQuery: ((atom: string) => ({
      data: useSyncExternalStore(subscribe, () =>
        atom === "auth" ? setup.auth : setup.installation,
      ),
      error: null,
      isPending: false,
      refresh: vi.fn(),
    })) as never,
  };
});
const publish = () =>
  act(async () => {
    for (const listener of queryListeners) listener();
  });
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: () => ({ dialogs: { confirm: setup.confirm } }) as never,
}));

import { ProviderSetupSection } from "./ProviderSetupSection";

const environmentId = EnvironmentId.make("remote-google");
const instanceId = ProviderInstanceId.make("antigravity_work");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("antigravity"),
  installed: true,
  enabled: true,
  version: "test-version",
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-09-02T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  setup: { canAuthenticate: true, canInstall: true },
};

function authState(patch: Partial<ProviderAuthState> = {}): ProviderAuthState {
  return {
    instanceId,
    phase: "waiting",
    flowId: "flow-1",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-only",
    expiresAt: "2026-09-02T00:05:00.000Z",
    message: null,
    ...patch,
  };
}

interface SectionOptions {
  readOnly?: boolean;
  provider?: ServerProvider;
  enabled?: boolean;
  binaryPath?: string;
}

function section(options: SectionOptions = {}) {
  return (
    <ProviderSetupSection
      environmentId={environmentId}
      environmentLabel="Remote Google device"
      instanceId={instanceId}
      provider={options.provider ?? provider}
      binaryPath={options.binaryPath}
      enabled={options.enabled ?? true}
      readOnly={options.readOnly ?? false}
      onEnable={vi.fn()}
    />
  );
}

async function renderSetup(options: SectionOptions = {}) {
  const screen = await render(section(options));
  const { container } = screen;
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (element) => element.textContent === label || element.getAttribute("aria-label") === label,
    ) ?? null;
  return Object.assign(screen, {
    button,
    async click(label: string) {
      const target = button(label);
      expect(target, `button ${label}`).not.toBeNull();
      expect(target!.disabled, `${label} disabled`).toBe(false);
      await act(async () => target!.click());
    },
    occurrences: (text: string) => (container.textContent ?? "").split(text).length - 1,
    callbackInput: () =>
      container.querySelector<HTMLInputElement>(`[id="provider-callback-${instanceId}"]`)!,
  });
}

function resetSetup() {
  vi.clearAllMocks();
  setup.auth = authState();
  setup.installation = {
    driver: ProviderDriverKind.make("antigravity"),
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    version: null,
    installedVersion: null,
    canRemove: false,
    message: null,
  };
  for (const command of [
    setup.startAuth,
    setup.completeAuth,
    setup.cancelAuth,
    setup.logoutAuth,
    setup.startInstall,
    setup.cancelInstall,
    setup.removeInstall,
  ]) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  }
  setup.confirm.mockReset().mockResolvedValue(false);
}

describe("Antigravity setup", () => {
  it("waits for verified auth after submitting a callback to the selected environment", async () => {
    resetSetup();
    const callbackUrl = "http://127.0.0.1:5555/?state=test-only&code=test-only";
    await using screen = await renderSetup();
    await userEvent.fill(screen.callbackInput(), callbackUrl);
    await screen.click("Continue");

    expect(setup.completeAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1", callbackUrl },
    });
    expect(screen.occurrences("Signed in.")).toBe(0);
    expect(screen.callbackInput().value).toBe("");

    setup.auth = authState({ phase: "verifying", authorizationUrl: null });
    await publish();
    expect(screen.occurrences("Signed in.")).toBe(0);
    setup.auth = authState({ phase: "succeeded", authorizationUrl: null });
    await screen.rerender(
      section({
        provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
      }),
    );
    expect(screen.occurrences("Signed in.")).toBe(1);
  });

  it("does not send a callback left over from a replaced sign-in flow", async () => {
    resetSetup();
    const interaction = {
      type: "browser" as const,
      id: "same-interaction",
      url: "https://example.com/login",
      requiresConsent: false,
      acceptsCallback: true,
    };
    setup.auth = authState({ interaction });
    await using screen = await renderSetup();
    await userEvent.fill(
      screen.callbackInput(),
      "http://127.0.0.1:5555/?state=old-flow&code=test-only",
    );
    setup.auth = authState({ flowId: "flow-2", interaction });
    await publish();
    expect(screen.callbackInput().value).toBe("");
    await act(async () => screen.callbackInput().form!.requestSubmit());

    expect(setup.completeAuth).not.toHaveBeenCalled();
    expect(setup.authState).toHaveBeenLastCalledWith({ environmentId, input: { instanceId } });
  });

  it("does not let a shared managed install hide an invalid custom binary path", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      installedVersion: "test-version",
      canRemove: true,
    };
    await using screen = await renderSetup({
      provider: { ...provider, installed: false },
      binaryPath: "/missing/antigravity",
    });
    expect(screen.button("Sign in")?.disabled).toBe(true);
    expect(setup.startAuth).not.toHaveBeenCalled();
  });
});
