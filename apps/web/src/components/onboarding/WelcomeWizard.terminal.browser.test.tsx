import { RegistryContext } from "@effect/atom-react";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  AuthTerminalOperateScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  type ServerSettings,
  type TerminalCloseInput,
  type TerminalOpenInput,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type CommandResult = AsyncResult.AsyncResult<void, Error>;
type Request<Input> = { environmentId: EnvironmentId; input: Input };
type SetupConfig = {
  cwd: string;
  settings: ServerSettings;
  environment: { platform: { os: "darwin" } };
  keybindings: ResolvedKeybindingsConfig;
};
const state = vi.hoisted(() => ({
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  providers: new Map<EnvironmentId, Atom.Writable<ReadonlyArray<ServerProvider>>>(),
  configs: new Map<EnvironmentId, Atom.Atom<SetupConfig>>(),
  open: vi.fn<(request: Request<TerminalOpenInput>) => Promise<CommandResult>>(),
  write: vi.fn<(request: Request<TerminalWriteInput>) => Promise<CommandResult>>(),
  close: vi.fn<(request: Request<TerminalCloseInput>) => Promise<CommandResult>>(),
  refresh: vi.fn(),
  pair: vi.fn(),
  createProject: vi.fn(),
  importThreads: vi.fn(),
  complete: vi.fn<() => Promise<void>>(),
  done: vi.fn(),
}));

// Session grants come from per-test atoms so a test can revoke or regrant mid-flow; the
// real scope checks in ~/state/session read them through the app registry, which the
// wizard is also rendered with.
vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((runtime: never) => ({
      ...actual.createEnvironmentSessionAtoms(runtime),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
    })) as never,
  };
});
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [remoteEnvironment] })) as never,
  usePrimaryEnvironment: (() => primaryEnvironment) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: ((id: EnvironmentId) => state.providers.get(id)!) as never,
      configValueAtom: ((id: EnvironmentId) => state.configs.get(id)!) as never,
      refreshProviders: "refresh" as never,
    },
  };
});
vi.mock(import("../../state/terminal"), async (original) => ({
  ...(await original()),
  terminalEnvironment: { open: "open", write: "write", close: "close" } as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((
    command: "open" | "write" | "close" | "refresh" | "pair" | "createProject" | "importThreads",
  ) => state[command]) as never,
}));
vi.mock(import("../../connection/onboarding"), async (original) => ({
  ...(await original()),
  connectPairing: "pair" as never,
}));
vi.mock(import("../../state/agentSessions"), async (original) => ({
  ...(await original()),
  agentSessionImport: "importThreads" as never,
}));
vi.mock(import("../../state/projects"), async (original) => ({
  ...(await original()),
  projectEnvironment: { create: "createProject" } as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  readProjects: () => [],
  useProjects: () => [],
}));
vi.mock(import("../../onboarding/useProjectScans"), async (original) => ({
  ...(await original()),
  useProjectScans: () => [],
}));
vi.mock(import("../../onboarding/firstRun"), async (original) => ({
  ...(await original()),
  completeOnboarding: state.complete,
}));
vi.mock(import("../../cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => false,
}));
vi.mock(import("../settings/ChatGptWelcomeCoordinator"), async (original) => ({
  ...(await original()),
  ChatGptWelcomeCoordinator: () => <></>,
}));
// The real viewport mounts a Ghostty terminal against the PTY; these tests only need to
// see whether the wizard shows it.
vi.mock(import("../ThreadTerminalDrawer"), async (original) => ({
  ...(await original()),
  TerminalViewport: () => <div data-terminal-viewport />,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { WelcomeWizard } from "./WelcomeWizard";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("paired-remote");
const primaryEnvironment = {
  environmentId: primaryId,
  label: "This computer",
  connection: { phase: "connected" },
  entry: {
    enabled: true,
    target: new PrimaryConnectionTarget({
      environmentId: primaryId,
      label: "This computer",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
    }),
  },
} as const;
const remoteEnvironment = {
  environmentId: remoteId,
  label: "Paired computer",
  connection: { phase: "connected" },
  entry: {
    enabled: true,
    target: new BearerConnectionTarget({
      environmentId: remoteId,
      label: "Paired computer",
      connectionId: "paired-remote",
    }),
  },
} as const;
const missingClaude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude-work"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-09-05T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const signedOutCodex: ServerProvider = {
  ...missingClaude,
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  installed: true,
  auth: { status: "unauthenticated" },
};
const session = (scopes: readonly AuthEnvironmentScope[]): AuthSessionState => ({
  authenticated: true,
  scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
});
function setAccess(environmentId: EnvironmentId, allowed: boolean) {
  appAtomRegistry.set(
    state.sessions.get(environmentId)!,
    AsyncResult.success(session(allowed ? [AuthTerminalOperateScope] : [])),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const roots: Root[] = [];
function pageText() {
  return document.body.textContent ?? "";
}
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label || element.ariaLabel === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) {
  const node = button(label);
  expect(node.disabled).toBe(false);
  await act(async () => node.click());
}
function hasViewport() {
  return document.querySelector("[data-terminal-viewport]") !== null;
}
async function enterRemoteAgents() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <WelcomeWizard localAvailable onDone={state.done} />
      </RegistryContext.Provider>,
    ),
  );
  await click("Continue");
  expect(pageText()).toContain("Paired computer");
}

beforeEach(() => {
  for (const id of [primaryId, remoteId]) {
    state.sessions.set(
      id,
      Atom.make<SessionResult>(AsyncResult.success(session([AuthTerminalOperateScope]))).pipe(
        Atom.keepAlive,
      ),
    );
    state.providers.set(
      id,
      Atom.make<ReadonlyArray<ServerProvider>>([missingClaude, signedOutCodex]).pipe(
        Atom.keepAlive,
      ),
    );
    state.configs.set(
      id,
      Atom.make<SetupConfig>({
        cwd: `/fixtures/${id}`,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [signedOutCodex.instanceId]: {
              driver: signedOutCodex.driver,
              config: { binaryPath: "/opt/codex-work", setupMode: "existing" },
            },
          },
        },
        environment: { platform: { os: "darwin" } },
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      }),
    );
  }
  state.open.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.write.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.close.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.pair.mockReset().mockResolvedValue(AsyncResult.success(remoteId));
  state.complete.mockReset().mockResolvedValue(undefined);
  state.done.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  state.sessions.clear();
  state.providers.clear();
  state.configs.clear();
});

describe("welcome agent terminal setup", () => {
  it("disables both setup actions for the paired read-only connection and preserves local completion", async () => {
    setAccess(remoteId, false);
    await enterRemoteAgents();
    expect(button("Install").disabled).toBe(true);
    expect(button("Sign in").disabled).toBe(true);
    expect(pageText()).toContain("This connection cannot control terminals.");
    await act(async () => {
      button("Install").click();
      button("Sign in").click();
    });
    expect(state.open).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
    await click("Continue");
    await click("Do not import projects");
    expect(state.complete).toHaveBeenCalledOnce();
    expect(state.done).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("rejects a retained install action after revocation and allows a terminal-only regrant", async () => {
    setAccess(primaryId, false);
    await enterRemoteAgents();
    const install = button("Install");
    // The click reaches the still-enabled button before React re-renders the revocation.
    await act(async () => {
      setAccess(remoteId, false);
      install.click();
    });
    expect(state.open).not.toHaveBeenCalled();
    expect(button("Install").disabled).toBe(true);
    await act(async () => setAccess(remoteId, true));
    expect(button("Install").disabled).toBe(false);
    await click("Install");
    expect(state.open).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        threadId: "onboarding-agent-setup",
        terminalId: expect.any(String),
        cwd: "/fixtures/paired-remote",
        providerInstanceId: missingClaude.instanceId,
      },
    });
    expect(state.write).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        threadId: "onboarding-agent-setup",
        terminalId: state.open.mock.calls[0]![0].input.terminalId,
        data: "curl -fsSL https://claude.ai/install.sh | bash",
      },
    });
    expect(hasViewport()).toBe(true);
    await click("Close");
    expect(state.close).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        threadId: "onboarding-agent-setup",
        terminalId: state.open.mock.calls[0]![0].input.terminalId,
        deleteHistory: true,
      },
    });
  });

  it("pretypes the selected provider's sign-in command without executing it", async () => {
    setAccess(primaryId, false);
    await enterRemoteAgents();
    await click("Sign in");
    expect(state.open).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        threadId: "onboarding-agent-setup",
        terminalId: expect.any(String),
        cwd: "/fixtures/paired-remote",
        providerInstanceId: signedOutCodex.instanceId,
      },
    });
    expect(state.write).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        threadId: "onboarding-agent-setup",
        terminalId: state.open.mock.calls[0]![0].input.terminalId,
        data: "/opt/codex-work login",
      },
    });
    expect(pageText()).toContain("Review the command, then press Enter to run it.");
  });

  it("checks access when a queued retry starts and recovers after regrant", async () => {
    state.open.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Could not open"))));
    await enterRemoteAgents();
    await click("Install");
    const closing = deferred<CommandResult>();
    state.close.mockReturnValueOnce(closing.promise);
    await click("Retry");
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.open).toHaveBeenCalledOnce();
    await act(async () => {
      setAccess(remoteId, false);
      closing.resolve(AsyncResult.success(undefined));
    });
    expect(state.open).toHaveBeenCalledOnce();
    expect(button("Retry").disabled).toBe(true);
    expect(state.write).not.toHaveBeenCalled();
    await act(async () => setAccess(remoteId, true));
    await click("Retry");
    expect(state.open).toHaveBeenCalledTimes(2);
    expect(state.write).toHaveBeenCalledOnce();
    expect(hasViewport()).toBe(true);
  });

  it("keeps an accepted terminal visible without pretyping when access is revoked during open", async () => {
    const opening = deferred<CommandResult>();
    state.open.mockReturnValueOnce(opening.promise);
    await enterRemoteAgents();
    await click("Install");
    await act(async () => {
      setAccess(remoteId, false);
      opening.resolve(AsyncResult.success(undefined));
    });
    expect(state.write).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
    expect(hasViewport()).toBe(true);
    expect(pageText()).toContain("This connection cannot control terminals.");
    await act(async () => setAccess(remoteId, true));
    expect(state.open).toHaveBeenCalledOnce();
    expect(state.write).not.toHaveBeenCalled();
    expect(pageText()).toContain("Run curl -fsSL https://claude.ai/install.sh | bash in this");
    await act(async () => setAccess(remoteId, false));
    await click("Close");
    expect(hasViewport()).toBe(false);
    expect(state.close).not.toHaveBeenCalled();
    await click("Continue");
    expect(pageText()).toContain("Import your projects");
  });

  it("settles accepted pretyping locally after revocation without closing the PTY", async () => {
    const writing = deferred<CommandResult>();
    state.write.mockReturnValueOnce(writing.promise);
    await enterRemoteAgents();
    await click("Sign in");
    await act(async () => {
      setAccess(remoteId, false);
      writing.resolve(AsyncResult.success(undefined));
    });
    expect(state.open).toHaveBeenCalledOnce();
    expect(state.write).toHaveBeenCalledOnce();
    expect(hasViewport()).toBe(true);
    await act(async () => setAccess(remoteId, true));
    expect(pageText()).toContain("Review the command, then press Enter to run it.");
    expect(state.open).toHaveBeenCalledOnce();
    expect(state.write).toHaveBeenCalledOnce();
    await act(async () => setAccess(remoteId, false));
    await click("Close");
    expect(state.close).not.toHaveBeenCalled();
  });

  it("rechecks the original environment when cleanup runs after pending pretyping", async () => {
    const writing = deferred<CommandResult>();
    state.write.mockReturnValueOnce(writing.promise);
    await enterRemoteAgents();
    await click("Install");
    await click("Connect, step 1");
    expect(state.close).not.toHaveBeenCalled();
    await act(async () => {
      setAccess(remoteId, false);
      writing.resolve(AsyncResult.success(undefined));
    });
    expect(state.close).not.toHaveBeenCalled();
    expect(pageText()).toContain("Connect your computers");
  });
});
