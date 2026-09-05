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
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  registry: null as AtomRegistry.AtomRegistry | null,
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

vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("@t3tools/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
  }),
}));
vi.mock("../../rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [primaryEnvironment, remoteEnvironment] }),
  usePrimaryEnvironment: () => primaryEnvironment,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: (id: EnvironmentId) => state.providers.get(id)!,
    configValueAtom: (id: EnvironmentId) => state.configs.get(id)!,
    refreshProviders: "refresh",
  },
}));
vi.mock("../../state/terminal", () => ({
  terminalEnvironment: { open: "open", write: "write", close: "close" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (
    command: "open" | "write" | "close" | "refresh" | "pair" | "createProject" | "importThreads",
  ) => state[command],
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: "pair" }));
vi.mock("../../state/agentSessions", () => ({
  agentSessionImport: "importThreads",
  agentSessionScan: vi.fn(),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "createProject" } }));
vi.mock("../../state/entities", () => ({ readProjects: () => [], useProjects: () => [] }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { candidates: [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => state.complete }));
vi.mock("../../hooks/useTheme", () => ({ mountOnboardingTheme: () => undefined }));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: () => [false, vi.fn()] }));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: vi.fn() }));
vi.mock("@clerk/react", () => ({ useAuth: vi.fn() }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../providerInstances", () => ({ resolveDefaultProviderModelSelection: vi.fn() }));
vi.mock("../settings/providerDriverMeta", () => ({
  getDriverOption: (driver: string) => ({ label: driver }),
}));
vi.mock("../settings/providerStatus", () => ({
  getProviderSummary: () => ({ headline: "Setup required" }),
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../ThreadTerminalDrawer", () => ({
  TerminalViewport: () => <div data-terminal-viewport />,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("../ui/collapsible", () => ({
  Collapsible: "div",
  CollapsiblePanel: "div",
  CollapsibleTrigger: "button",
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn(), update: vi.fn(), close: vi.fn() },
}));

import { WelcomeWizard } from "./WelcomeWizard";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("paired-remote");
const primaryEnvironment = {
  environmentId: primaryId,
  label: "This computer",
  connection: { phase: "connected" },
  entry: {
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
  state.registry!.set(
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
function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}
let renderer: ReactTestRenderer | undefined;
function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => text(node) === label)!;
}
async function click(label: string) {
  const node = button(label);
  expect(node).toBeDefined();
  expect(node.props.disabled).not.toBe(true);
  await act(async () => node.props.onClick());
}
function hasViewport() {
  return renderer!.root.findAllByProps({ "data-terminal-viewport": true }).length > 0;
}
async function enterRemoteAgents() {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={state.registry!}>
        <WelcomeWizard localAvailable onDone={state.done} />
      </RegistryContext.Provider>,
    );
  });
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((node) => text(node).startsWith("Pair a server"))!
      .props.onClick();
  });
  await click("Continue");
  await act(async () => {
    renderer!.root.findByType("input").props.onChange({
      currentTarget: { value: "http://paired.example/pair#token=fixture" },
    });
  });
  await click("Connect");
  expect(text(renderer!.root)).toContain("Detected on Paired computer.");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.registry = AtomRegistry.make();
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
              config: { binaryPath: "/opt/codex-work" },
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
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  state.sessions.clear();
  state.providers.clear();
  state.configs.clear();
  vi.unstubAllGlobals();
});

describe("welcome agent terminal setup", () => {
  it("disables both setup actions for the paired read-only connection and preserves local completion", async () => {
    setAccess(remoteId, false);
    await enterRemoteAgents();
    expect(button("Install").props.disabled).toBe(true);
    expect(button("Sign in").props.disabled).toBe(true);
    expect(text(renderer!.root)).toContain("This connection cannot control terminals.");
    await act(async () => {
      button("Install").props.onClick();
      button("Sign in").props.onClick();
    });
    expect(state.open).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
    await click("Continue");
    await click("Start coding");
    expect(state.complete).toHaveBeenCalledOnce();
    expect(state.done).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("rejects a retained install action after revocation and allows a terminal-only regrant", async () => {
    setAccess(primaryId, false);
    await enterRemoteAgents();
    const install = button("Install").props.onClick;
    await act(async () => {
      setAccess(remoteId, false);
      install();
    });
    expect(state.open).not.toHaveBeenCalled();
    expect(button("Install").props.disabled).toBe(true);
    await act(async () => setAccess(remoteId, true));
    expect(button("Install").props.disabled).toBe(false);
    await act(async () => install());
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
        data: "npm install -g @anthropic-ai/claude-code",
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
    expect(text(renderer!.root)).toContain("Review the command, then press Enter to run it.");
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
    expect(button("Retry").props.disabled).toBe(true);
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
    expect(text(renderer!.root)).toContain("This connection cannot control terminals.");
    await act(async () => setAccess(remoteId, true));
    expect(state.open).toHaveBeenCalledOnce();
    expect(state.write).not.toHaveBeenCalled();
    expect(text(renderer!.root)).toContain(
      "Run npm install -g @anthropic-ai/claude-code in this terminal.",
    );
    await act(async () => setAccess(remoteId, false));
    await click("Close");
    expect(hasViewport()).toBe(false);
    expect(state.close).not.toHaveBeenCalled();
    await click("Skip");
    expect(text(renderer!.root)).toContain("Your projects");
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
    expect(text(renderer!.root)).toContain("Review the command, then press Enter to run it.");
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
    await click("Back");
    expect(state.close).not.toHaveBeenCalled();
    await act(async () => {
      setAccess(remoteId, false);
      writing.resolve(AsyncResult.success(undefined));
    });
    expect(state.close).not.toHaveBeenCalled();
    expect(text(renderer!.root)).toContain("Pair a server");
  });
});
