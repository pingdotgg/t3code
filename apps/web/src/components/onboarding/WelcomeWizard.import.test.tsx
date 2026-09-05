import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProjectId,
  type AgentSessionProjectCandidate,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type Project = { id: ProjectId; environmentId: EnvironmentId; workspaceRoot: string };
type CreateProjectInput = {
  environmentId: EnvironmentId;
  input: { projectId: ProjectId; workspaceRoot: string };
};
const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  projects: null as Atom.Writable<ReadonlyArray<Project>> | null,
  providers: null as Atom.Atom<ReadonlyArray<never>> | null,
  config: null as Atom.Atom<null> | null,
  candidates: [] as AgentSessionProjectCandidate[],
  createProject: vi.fn(),
  importThreads: vi.fn(),
  refreshProviders: vi.fn(),
  connectPairing: vi.fn(),
  completeOnboarding: vi.fn(),
  onDone: vi.fn(),
  scan: vi.fn(),
  refreshScan: vi.fn(),
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
vi.mock("@clerk/react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("../../hooks/useTheme", () => ({ mountOnboardingTheme: () => () => {} }));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: () => [false, () => {}] }));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), copied: false }),
}));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: vi.fn() }));
vi.mock("../../onboarding/firstRun", () => ({
  useCompleteOnboarding: () => state.completeOnboarding,
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/environments", () => {
  const environment = (environmentId: string) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    entry: { target: { _tag: "DirectConnectionTarget" } },
  });
  const primary = environment("primary");
  return {
    usePrimaryEnvironment: () => primary,
    useEnvironments: () => ({ environments: [primary, environment("remote")] }),
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => state.providers,
    configValueAtom: () => state.config,
    refreshProviders: "refreshProviders",
  },
}));
vi.mock("../../state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useProjects: () => useAtomValue(state.projects!),
    readProjects: () => state.registry!.get(state.projects!),
  };
});
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "createProject" } }));
vi.mock("../../state/agentSessions", () => ({
  agentSessionScan: (query: { environmentId: EnvironmentId }) => query,
  agentSessionImport: "importThreads",
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { environmentId: EnvironmentId }) => {
    state.scan(query);
    return {
      data: { candidates: state.candidates, truncated: false },
      isPending: false,
      error: null,
      refresh: state.refreshScan,
    };
  },
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: "connectPairing" }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (
    command: "createProject" | "importThreads" | "refreshProviders" | "connectPairing",
  ) => state[command],
}));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: "div" }));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({ CloudEnvironmentConnectRows: "div" }));
vi.mock("../settings/providerDriverMeta", () => ({ getDriverOption: () => ({ label: "Agent" }) }));
vi.mock("../settings/providerStatus", () => ({
  getProviderSummary: () => ({ headline: "Checking", detail: null }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("../ui/collapsible", () => ({
  Collapsible: "div",
  CollapsiblePanel: "div",
  CollapsibleTrigger: "button",
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn(), close: vi.fn(), update: vi.fn() } }));

import { WelcomeWizard } from "./WelcomeWizard";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const permissionMessage = "This connection cannot import projects or thread history.";
let renderer: ReactTestRenderer | undefined;

function session(scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState {
  return {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope, ...scopes],
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  };
}

function setGrant(environmentId: EnvironmentId, allowed: boolean) {
  state.registry!.set(
    state.sessions.get(environmentId)!,
    AsyncResult.success(session(allowed ? [AuthOrchestrationOperateScope] : [])),
  );
}

function candidate(path: string): AgentSessionProjectCandidate {
  return {
    path,
    title: path.split("/").at(-1)!,
    sources: ["codex"],
    threadCount: 1,
    lastActiveAt: new Date(Date.now() - 60_000).toISOString(),
    alreadyImported: false,
  };
}

function recordProject({ environmentId, input }: CreateProjectInput) {
  state.registry!.set(state.projects!, [
    ...state.registry!.get(state.projects!),
    { id: input.projectId, environmentId, workspaceRoot: input.workspaceRoot },
  ]);
  return AsyncResult.success(undefined);
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

function button(label: string) {
  const found = renderer!.root.findAllByType("button").find((node) => text(node) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) {
  const target = button(label);
  expect(target.props.disabled).not.toBe(true);
  await act(async () => target.props.onClick());
}

async function mountImport(remote = false) {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={state.registry!}>
        <WelcomeWizard localAvailable={!remote} onDone={state.onDone} />
      </RegistryContext.Provider>,
    );
  });
  await click("Continue");
  if (remote) {
    await act(async () => {
      renderer!.root.findByProps({ id: "onboarding-pairing-url" }).props.onChange({
        currentTarget: { value: "https://remote.example/pair#token=test" },
      });
    });
    await click("Connect");
  }
  await click("Skip");
  expect(text(renderer!.root)).toContain("Your recent projects");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.registry = AtomRegistry.make();
  for (const id of [primaryId, remoteId]) {
    state.sessions.set(
      id,
      Atom.make<SessionResult>(AsyncResult.success(session([AuthOrchestrationOperateScope]))).pipe(
        Atom.keepAlive,
      ),
    );
  }
  state.projects = Atom.make<ReadonlyArray<Project>>([]).pipe(Atom.keepAlive);
  state.providers = Atom.make<ReadonlyArray<never>>([]).pipe(Atom.keepAlive);
  state.config = Atom.make(null).pipe(Atom.keepAlive);
  state.candidates = [candidate("/projects/first"), candidate("/projects/second")];
  state.createProject
    .mockReset()
    .mockImplementation(async (input: CreateProjectInput) => recordProject(input));
  state.importThreads
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ importedCount: 1, skippedCount: 0 }));
  state.refreshProviders.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.connectPairing.mockReset().mockResolvedValue(AsyncResult.success(remoteId));
  state.completeOnboarding.mockReset().mockResolvedValue(undefined);
  state.onDone.mockReset();
  state.scan.mockReset();
  state.refreshScan.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  state.sessions.clear();
  vi.unstubAllGlobals();
});

it("keeps scanning, choosing and skipping available to a paired read-only environment", async () => {
  setGrant(remoteId, false);
  await mountImport(true);
  expect(state.scan).toHaveBeenCalledWith(expect.objectContaining({ environmentId: remoteId }));
  expect(text(renderer!.root)).toContain("/projects/first");
  expect(button("Import 2 projects").props.disabled).toBe(true);
  await click("Choose");
  expect(button("Import 2").props.disabled).toBe(true);
  expect(text(renderer!.root)).toContain(permissionMessage);
  await click("Skip");
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.importThreads).not.toHaveBeenCalled();
  expect(state.completeOnboarding).toHaveBeenCalledOnce();
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("waits for the selected grant and enables import when it arrives", async () => {
  state.registry!.set(state.sessions.get(primaryId)!, AsyncResult.initial());
  await mountImport();
  expect(button("Import 2 projects").props.disabled).toBe(true);
  await act(async () => setGrant(primaryId, true));
  await click("Import 2 projects");
  expect(state.createProject).toHaveBeenCalledTimes(2);
  expect(state.importThreads).toHaveBeenCalledTimes(2);
  expect(state.onDone).toHaveBeenCalledWith(expect.objectContaining({ environmentId: primaryId }));
});

it("preserves selections and denies a retained action using the paired environment's fresh grant", async () => {
  await mountImport(true);
  await click("Choose");
  await act(async () => {
    renderer!.root.findAllByType("input")[1]!.props.onCheckedChange(false);
  });
  const retainedImport = button("Import 1").props.onClick;
  await act(async () => {
    setGrant(remoteId, false);
    retainedImport();
  });
  expect(button("Import 1").props.disabled).toBe(true);
  expect(renderer!.root.findAllByType("input")[1]!.props.checked).toBe(false);
  expect(text(renderer!.root)).toContain(permissionMessage);
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.importThreads).not.toHaveBeenCalled();
  expect(state.onDone).not.toHaveBeenCalled();

  await act(async () => setGrant(remoteId, true));
  expect(text(renderer!.root)).not.toContain(permissionMessage);
  await click("Import 1");
  expect(state.createProject).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ environmentId: remoteId }),
  );
  expect(state.importThreads).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ environmentId: remoteId }),
  );
});

it("rechecks after project creation and can retry its history without recreating the project", async () => {
  const creation = deferred<void>();
  state.createProject.mockImplementationOnce(async (input: CreateProjectInput) => {
    await creation.promise;
    return recordProject(input);
  });
  await mountImport();
  await click("Import 2 projects");
  expect(state.createProject).toHaveBeenCalledOnce();
  await act(async () => {
    setGrant(primaryId, false);
    creation.resolve();
    await creation.promise;
  });
  expect(state.importThreads).not.toHaveBeenCalled();
  expect(state.createProject).toHaveBeenCalledOnce();
  expect(state.onDone).not.toHaveBeenCalled();
  expect(text(renderer!.root)).toContain(permissionMessage);

  await act(async () => setGrant(primaryId, true));
  await click("Import 2 projects");
  expect(state.createProject).toHaveBeenCalledTimes(2);
  expect(state.importThreads).toHaveBeenCalledTimes(2);
  expect(state.onDone).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "rechecks after history import before the next project write (existing: %s)",
  async (existing) => {
    if (existing) {
      const projectId = ProjectId.make("second-existing");
      state.candidates[1] = { ...state.candidates[1]!, projectId };
      state.registry!.set(state.projects!, [
        { id: projectId, environmentId: primaryId, workspaceRoot: "/projects/second" },
      ]);
    }
    const imported = deferred<{ importedCount: number; skippedCount: number }>();
    state.importThreads.mockImplementationOnce(async () =>
      AsyncResult.success(await imported.promise),
    );
    await mountImport();
    await click("Import 2 projects");
    expect(state.createProject).toHaveBeenCalledOnce();
    expect(state.importThreads).toHaveBeenCalledOnce();
    await act(async () => {
      setGrant(primaryId, false);
      imported.resolve({ importedCount: 1, skippedCount: 0 });
      await imported.promise;
    });
    expect(state.createProject).toHaveBeenCalledOnce();
    expect(state.importThreads).toHaveBeenCalledOnce();
    expect(state.onDone).not.toHaveBeenCalled();
    expect(text(renderer!.root)).toContain(permissionMessage);

    await act(async () => setGrant(primaryId, true));
    await click("Import 2 projects");
    expect(state.createProject).toHaveBeenCalledTimes(existing ? 1 : 2);
    expect(state.importThreads).toHaveBeenCalledTimes(2);
    expect(state.onDone).toHaveBeenCalledOnce();
  },
);

it("completes accepted imports when permission is revoked after the final server write", async () => {
  state.candidates = state.candidates.slice(0, 1);
  const imported = deferred<{ importedCount: number; skippedCount: number }>();
  state.importThreads.mockImplementationOnce(async () =>
    AsyncResult.success(await imported.promise),
  );
  await mountImport();
  await click("Import 1 project");
  await act(async () => {
    setGrant(primaryId, false);
    imported.resolve({ importedCount: 1, skippedCount: 0 });
    await imported.promise;
  });
  expect(state.createProject).toHaveBeenCalledOnce();
  expect(state.importThreads).toHaveBeenCalledOnce();
  expect(state.completeOnboarding).toHaveBeenCalledOnce();
  expect(state.onDone).toHaveBeenCalledOnce();
});
