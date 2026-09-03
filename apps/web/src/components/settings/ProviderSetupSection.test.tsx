import { isValidElement, type FunctionComponent, type ReactElement } from "react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const setup = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  installation: null as ProviderInstallState | null,
  authState: vi.fn(() => "auth"),
  installState: vi.fn(() => "installation"),
  startAuth: vi.fn(),
  completeAuth: vi.fn(),
  cancelAuth: vi.fn(),
  logoutAuth: vi.fn(),
  startInstall: vi.fn(),
  cancelInstall: vi.fn(),
  removeInstall: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: setup.authState,
    providerInstallState: setup.installState,
    startProviderAuth: setup.startAuth,
    completeProviderAuth: setup.completeAuth,
    cancelProviderAuth: setup.cancelAuth,
    logoutProviderAuth: setup.logoutAuth,
    startProviderInstall: setup.startInstall,
    cancelProviderInstall: setup.cancelInstall,
    removeProviderInstallation: setup.removeInstall,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string) => ({
    data: atom === "auth" ? setup.auth : setup.installation,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: setup.confirm } }),
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

function renderSetup(
  options: {
    readOnly?: boolean;
    provider?: ServerProvider;
    enabled?: boolean;
    binaryPath?: string;
  } = {},
) {
  hooks.beginRender();
  const view = ProviderSetupSection({
    environmentId,
    environmentLabel: "Remote Google device",
    instanceId,
    provider: options.provider ?? provider,
    binaryPath: options.binaryPath,
    enabled: options.enabled ?? true,
    readOnly: options.readOnly ?? false,
    onEnable: vi.fn(),
  });
  const actions = visitElements(
    view,
    (element) =>
      typeof element.type === "function" &&
      element.props.environmentId === environmentId &&
      element.props.instanceId === instanceId,
  );
  if (!actions) return view;
  const Actions = actions.type as FunctionComponent<Record<string, unknown>>;
  return Actions(actions.props) as ReactElement<Record<string, unknown>>;
}

function button(view: unknown, label: string) {
  return visitElements(
    view,
    (element) => element.props.children === label && typeof element.props.onClick === "function",
  );
}

function countElements(
  node: unknown,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): number {
  if (Array.isArray(node)) {
    return node.reduce((total, child) => total + countElements(child, predicate), 0);
  }
  if (!isValidElement<Record<string, unknown>>(node)) return 0;
  return (
    Number(predicate(node)) +
    Object.values(node.props).reduce<number>(
      (total, value) => total + countElements(value, predicate),
      0,
    )
  );
}

function click(view: unknown, label: string) {
  const target = button(view, label);
  if (!target) throw new Error(`Missing button: ${label}`);
  if (target.props.disabled) throw new Error(`Button is disabled: ${label}`);
  (target.props.onClick as () => void)();
}

function setCallback(view: unknown, value: string) {
  const input = visitElements(
    view,
    (element) => element.props.id === `provider-callback-${instanceId}`,
  );
  if (!input) throw new Error("Missing callback input.");
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

function submitCallback(view: unknown) {
  const form = visitElements(view, (element) => element.type === "form");
  if (!form) throw new Error("Missing callback form.");
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
    preventDefault: vi.fn(),
  });
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Antigravity setup", () => {
  beforeEach(() => {
    hooks.reset();
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
  });

  it("waits for verified auth after submitting a callback to the selected environment", async () => {
    const callbackUrl = "http://127.0.0.1:5555/?state=test-only&code=test-only";
    setCallback(renderSetup(), callbackUrl);
    submitCallback(renderSetup());
    await flushPromises();

    expect(setup.completeAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1", callbackUrl },
    });
    let view = renderSetup();
    expect(
      visitElements(view, (element) => element.props.children === "Signed in with Google."),
    ).toBeNull();
    expect(
      visitElements(view, (element) => element.props.id === `provider-callback-${instanceId}`)
        ?.props.value,
    ).toBe("");

    setup.auth = authState({ phase: "verifying", authorizationUrl: null });
    expect(
      visitElements(
        renderSetup(),
        (element) => element.props.children === "Signed in with Google.",
      ),
    ).toBeNull();
    setup.auth = authState({ phase: "succeeded", authorizationUrl: null });
    view = renderSetup({
      provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
    });
    expect(
      visitElements(view, (element) => element.props.children === "Signed in with Google."),
    ).not.toBeNull();
  });

  it("offers sign-in again when credentials expire after a completed auth flow", () => {
    setup.auth = authState({
      phase: "succeeded",
      authorizationUrl: null,
      message: "Google sign-in complete.",
    });
    renderSetup({
      provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
    });
    const expired = renderSetup();
    expect(button(expired, "Sign in with Google")).not.toBeNull();
    expect(
      visitElements(expired, (element) => element.props.children === "Signed in with Google."),
    ).toBeNull();
    expect(
      visitElements(expired, (element) => element.props.children === "Google sign-in complete."),
    ).toBeNull();
  });

  it("does not send a callback left over from a replaced sign-in flow", async () => {
    setCallback(renderSetup(), "http://127.0.0.1:5555/?state=old-flow&code=test-only");
    setup.auth = authState({ flowId: "flow-2" });
    submitCallback(renderSetup());
    await flushPromises();

    expect(setup.completeAuth).not.toHaveBeenCalled();
    expect(setup.authState).toHaveBeenLastCalledWith({ environmentId, input: { instanceId } });
  });

  it("coalesces repeated sign-in clicks while start is pending", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    let completeStart: (value: { _tag: "Success"; value: undefined }) => void = () => {
      throw new Error("Missing start resolver.");
    };
    const pending = new Promise<{ _tag: "Success"; value: undefined }>((resolve) => {
      completeStart = resolve;
    });
    setup.startAuth.mockReturnValueOnce(pending);
    const view = renderSetup();
    click(view, "Sign in with Google");
    click(view, "Sign in with Google");

    expect(setup.startAuth).toHaveBeenCalledTimes(1);
    expect(setup.startAuth).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    completeStart({ _tag: "Success", value: undefined });
    await flushPromises();
  });

  it("shows a repeated runtime status message only once", () => {
    setup.installation = {
      ...setup.installation!,
      operationId: "install-1",
      phase: "verifying",
      message: "Checking the downloaded runtime.",
    };

    const view = renderSetup();
    expect(
      countElements(
        view,
        (element) => element.props.children === "Checking the downloaded runtime.",
      ),
    ).toBe(1);
  });

  it("removes an owned damaged runtime only after confirmation", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      phase: "failed",
      canRemove: true,
      installedVersion: null,
    };
    const view = renderSetup();
    click(view, "Remove downloaded runtime");
    await flushPromises();
    expect(setup.removeInstall).not.toHaveBeenCalled();

    setup.confirm.mockResolvedValue(true);
    click(view, "Remove downloaded runtime");
    await flushPromises();
    expect(setup.removeInstall).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  });

  it.each([true, false])(
    "can sign out an unchecked account when its instance is enabled=%s",
    async (enabled) => {
      setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
      setup.confirm.mockResolvedValue(true);
      const view = renderSetup({
        enabled,
        provider: {
          ...provider,
          enabled,
          installed: false,
          status: enabled ? "warning" : "disabled",
          auth: { status: "unknown" },
        },
      });
      click(view, "Sign out of Google");
      await flushPromises();
      expect(setup.logoutAuth).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    },
  );

  it("does not let a shared managed install hide an invalid custom binary path", () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      installedVersion: "test-version",
      canRemove: true,
    };
    const view = renderSetup({
      provider: { ...provider, installed: false },
      binaryPath: "/missing/antigravity",
    });
    expect(button(view, "Sign in with Google")?.props.disabled).toBe(true);
    expect(setup.startAuth).not.toHaveBeenCalled();
  });

  it.each(["read-only", "older-server"] as const)(
    "does not open private setup subscriptions for a %s view",
    (mode) => {
      const { setup: _setup, ...olderProvider } = provider;
      renderSetup(mode === "read-only" ? { readOnly: true } : { provider: olderProvider });
      expect(setup.authState).not.toHaveBeenCalled();
      expect(setup.installState).not.toHaveBeenCalled();
      expect(setup.startAuth).not.toHaveBeenCalled();
    },
  );
});
