import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;

function renderSetup(
  options: {
    readOnly?: boolean;
    provider?: ServerProvider;
    enabled?: boolean;
    binaryPath?: string;
  } = {},
) {
  return act(async () =>
    root.render(
      <ProviderSetupSection
        environmentId={environmentId}
        environmentLabel="Remote Google device"
        instanceId={instanceId}
        provider={options.provider ?? provider}
        binaryPath={options.binaryPath}
        enabled={options.enabled ?? true}
        readOnly={options.readOnly ?? false}
        onEnable={vi.fn()}
      />,
    ),
  );
}

function button(label: string) {
  return (
    [...container.querySelectorAll("button")].find(
      (element) => element.textContent === label || element.getAttribute("aria-label") === label,
    ) ?? null
  );
}
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).not.toBeNull();
  expect(target!.disabled, `${label} disabled`).toBe(false);
  await act(async () => target!.click());
}
function occurrences(text: string) {
  return (container.textContent ?? "").split(text).length - 1;
}
const callbackInput = () =>
  container.querySelector<HTMLInputElement>(`[id="provider-callback-${instanceId}"]`)!;

describe("Antigravity setup", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("waits for verified auth after submitting a callback to the selected environment", async () => {
    const callbackUrl = "http://127.0.0.1:5555/?state=test-only&code=test-only";
    await renderSetup();
    await act(async () => userEvent.fill(callbackInput(), callbackUrl));
    await click("Continue");

    expect(setup.completeAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1", callbackUrl },
    });
    expect(occurrences("Signed in.")).toBe(0);
    expect(callbackInput().value).toBe("");

    setup.auth = authState({ phase: "verifying", authorizationUrl: null });
    await publish();
    expect(occurrences("Signed in.")).toBe(0);
    setup.auth = authState({ phase: "succeeded", authorizationUrl: null });
    await renderSetup({
      provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
    });
    expect(occurrences("Signed in.")).toBe(1);
  });

  it("offers sign-in again when credentials expire after a completed auth flow", async () => {
    setup.auth = authState({
      phase: "succeeded",
      authorizationUrl: null,
      message: "Google sign-in complete.",
    });
    await renderSetup({
      provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
    });
    await renderSetup();
    expect(button("Sign in")).not.toBeNull();
    expect(occurrences("Signed in.")).toBe(0);
    expect(occurrences("Google sign-in complete.")).toBe(0);
  });

  it("does not send a callback left over from a replaced sign-in flow", async () => {
    const interaction = {
      type: "browser" as const,
      id: "same-interaction",
      url: "https://example.com/login",
      requiresConsent: false,
      acceptsCallback: true,
    };
    setup.auth = authState({ interaction });
    await renderSetup();
    await act(async () =>
      userEvent.fill(callbackInput(), "http://127.0.0.1:5555/?state=old-flow&code=test-only"),
    );
    setup.auth = authState({ flowId: "flow-2", interaction });
    await publish();
    expect(callbackInput().value).toBe("");
    await act(async () => callbackInput().form!.requestSubmit());

    expect(setup.completeAuth).not.toHaveBeenCalled();
    expect(setup.authState).toHaveBeenLastCalledWith({ environmentId, input: { instanceId } });
  });

  it("coalesces repeated sign-in clicks while start is pending", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    const pending = deferred<{ _tag: "Success"; value: undefined }>();
    setup.startAuth.mockReturnValueOnce(pending.promise);
    await renderSetup();
    const signIn = button("Sign in")!;
    // Both clicks land before React re-renders the button as disabled.
    await act(async () => {
      signIn.click();
      signIn.click();
    });

    expect(setup.startAuth).toHaveBeenCalledTimes(1);
    expect(setup.startAuth).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    await act(async () => pending.resolve({ _tag: "Success", value: undefined }));
  });

  it("shows a repeated runtime status message only once", async () => {
    setup.installation = {
      ...setup.installation!,
      operationId: "install-1",
      phase: "verifying",
      message: "Checking the downloaded runtime.",
    };

    await renderSetup();
    expect(occurrences("Checking the downloaded runtime.")).toBe(1);
  });

  it("exposes download progress as a bounded progressbar only while the total is known", async () => {
    const downloading = (downloadedBytes: number, totalBytes: number | null) => {
      setup.installation = {
        ...setup.installation!,
        operationId: "install-1",
        phase: "downloading",
        downloadedBytes,
        totalBytes,
      };
      return publish();
    };
    const progressbar = page.getByRole("progressbar", { name: "Antigravity download" });
    await renderSetup();

    await downloading(40_000_000, 100_000_000);
    await expect.element(progressbar).toHaveValue(40_000_000);
    // The wire contract does not cap downloaded bytes at the advertised total.
    await downloading(110_000_000, 100_000_000);
    await expect.element(progressbar).toHaveValue(100_000_000);
    await downloading(40_000_000, null);
    expect(progressbar.query()).toBeNull();
  });

  it("removes an owned damaged runtime only after confirmation", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      phase: "failed",
      canRemove: true,
      installedVersion: null,
    };
    await renderSetup();
    await click("Remove downloaded runtime");
    expect(setup.confirm).toHaveBeenCalledOnce();
    expect(setup.removeInstall).not.toHaveBeenCalled();

    setup.confirm.mockResolvedValue(true);
    await click("Remove downloaded runtime");
    expect(setup.removeInstall).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  });

  it.each([true, false])(
    "can sign out a verified account when its instance is enabled=%s",
    async (enabled) => {
      setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
      setup.confirm.mockResolvedValue(true);
      await renderSetup({
        enabled,
        provider: {
          ...provider,
          enabled,
          installed: false,
          status: enabled ? "warning" : "disabled",
          auth: { status: "authenticated" },
        },
      });
      await click("Sign out");
      expect(setup.logoutAuth).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    },
  );

  it.each(["unauthenticated", "unknown"] as const)(
    "does not offer sign-out for an unverified %s account",
    async (status) => {
      setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
      await renderSetup({
        provider: { ...provider, auth: { status, canLogout: true } },
      });
      expect(button("Sign in")).not.toBeNull();
      expect(button("Sign out")).toBeNull();
      expect(button("Change account")).toBeNull();
    },
  );

  it("offers account actions after verified login when discovery cannot identify auth", async () => {
    setup.auth = authState({ phase: "succeeded", flowId: null, authorizationUrl: null });
    await renderSetup({ provider: { ...provider, auth: { status: "unknown" } } });
    expect(button("Change account")).not.toBeNull();
    expect(button("Sign out")).not.toBeNull();
    expect(button("Sign in")).toBeNull();
  });

  it("does not let a shared managed install hide an invalid custom binary path", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      installedVersion: "test-version",
      canRemove: true,
    };
    await renderSetup({
      provider: { ...provider, installed: false },
      binaryPath: "/missing/antigravity",
    });
    expect(button("Sign in")?.disabled).toBe(true);
    expect(setup.startAuth).not.toHaveBeenCalled();
  });

  it.each(["read-only", "older-server"] as const)(
    "does not open private setup subscriptions for a %s view",
    async (mode) => {
      const { setup: _setup, ...olderProvider } = provider;
      await renderSetup(mode === "read-only" ? { readOnly: true } : { provider: olderProvider });
      expect(setup.authState).not.toHaveBeenCalled();
      expect(setup.installState).not.toHaveBeenCalled();
      expect(setup.startAuth).not.toHaveBeenCalled();
    },
  );
});
