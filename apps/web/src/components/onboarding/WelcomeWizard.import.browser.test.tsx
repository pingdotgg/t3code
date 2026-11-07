import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentSessionProjectCandidate,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type Project = { id: ProjectId; environmentId: EnvironmentId; workspaceRoot: string };
type CreateProjectInput = {
  environmentId: EnvironmentId;
  input: { projectId: ProjectId; workspaceRoot: string };
};
const state = vi.hoisted(() => ({
  selectedEnvironment: "primary",
  addedEnvironments: [] as string[],
  sessions: new Map<string, unknown>(),
  projects: null as unknown,
  providers: null as unknown,
  config: null as unknown,
  authState: null as unknown,
  installState: null as unknown,
  candidates: [] as AgentSessionProjectCandidate[],
  createProject: vi.fn(),
  importThreads: vi.fn(),
  refreshProviders: vi.fn(),
  updateSettings: vi.fn(),
  startProviderAuth: vi.fn(),
  connectPairing: vi.fn(),
  completeOnboarding: vi.fn(),
  onDone: vi.fn(),
  scan: vi.fn(),
  refreshScan: vi.fn(),
  waitForProject: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((runtime: never) => ({
      ...actual.createEnvironmentSessionAtoms(runtime),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id),
    })) as never,
  };
});
vi.mock(import("../../cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => false,
}));
vi.mock(import("../../onboarding/firstRun"), async (original) => ({
  ...(await original()),
  completeOnboarding: state.completeOnboarding,
}));
vi.mock(import("../../state/environments"), async (original) => {
  const environment = (environmentId: string) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    entry: { enabled: true, target: { _tag: "DirectConnectionTarget" } },
  });
  const primary = environment("primary");
  return {
    ...(await original()),
    usePrimaryEnvironment: (() => primary) as never,
    useEnvironments: (() => ({
      environments: [state.selectedEnvironment, ...state.addedEnvironments].map(environment),
    })) as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => state.providers) as never,
      configValueAtom: (() => state.config) as never,
      refreshProviders: "refreshProviders" as never,
      providerAuthState: (() => state.authState) as never,
      providerInstallState: (() => state.installState) as never,
      updateSettings: "updateSettings" as never,
      startProviderAuth: "startProviderAuth" as never,
    },
  };
});
vi.mock(import("../../state/entities"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useProjects: (() => useAtomValue(state.projects as Atom.Atom<Project[]>)) as never,
    readProjects: (() => appAtomRegistry.get(state.projects as Atom.Atom<Project[]>)) as never,
    waitForProject: ((ref: unknown) => state.waitForProject(ref)) as never,
  };
});
vi.mock(import("../../state/projects"), async (original) => ({
  ...(await original()),
  projectEnvironment: { create: "createProject" } as never,
}));
vi.mock(import("../../state/agentSessions"), async (original) => ({
  ...(await original()),
  agentSessionImport: "importThreads" as never,
}));
vi.mock(import("../../onboarding/useProjectScans"), async (original) => ({
  ...(await original()),
  useProjectScans: (ids: readonly EnvironmentId[]) =>
    ids.map((environmentId) => {
      state.scan({ environmentId });
      return {
        environmentId,
        data: { candidates: state.candidates, truncated: false } as never,
        isPending: false,
        error: null,
        refresh: state.refreshScan,
      };
    }),
}));
vi.mock(import("../../connection/onboarding"), async (original) => ({
  ...(await original()),
  connectPairing: "connectPairing" as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((
    command:
      | "createProject"
      | "importThreads"
      | "refreshProviders"
      | "updateSettings"
      | "startProviderAuth"
      | "connectPairing",
  ) => state[command]) as never,
}));
vi.mock(import("../settings/ChatGptWelcomeCoordinator"), async (original) => ({
  ...(await original()),
  ChatGptWelcomeCoordinator: () => <></>,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { WelcomeWizard } from "./WelcomeWizard";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const permissionMessage = "This connection cannot import projects or thread history.";

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

function sessionAtom(environmentId: EnvironmentId) {
  return state.sessions.get(environmentId) as Atom.Writable<SessionResult>;
}

function projectsAtom() {
  return state.projects as Atom.Writable<ReadonlyArray<Project>>;
}

function setGrant(environmentId: EnvironmentId, allowed: boolean) {
  appAtomRegistry.set(
    sessionAtom(environmentId),
    AsyncResult.success(session(allowed ? [AuthOrchestrationOperateScope] : [])),
  );
}

// Default selection only picks recently active projects, so pin "now".
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function candidate(path: string): AgentSessionProjectCandidate {
  return {
    path,
    title: path.split("/").at(-1)!,
    sources: ["codex"],
    threadCount: 10,
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    alreadyImported: false,
  };
}

function recordProject({ environmentId, input }: CreateProjectInput) {
  appAtomRegistry.set(projectsAtom(), [
    ...appAtomRegistry.get(projectsAtom()),
    { id: input.projectId, environmentId, workspaceRoot: input.workspaceRoot },
  ]);
  return AsyncResult.success(undefined);
}

// Resolves once the project reaches the mocked projects atom; the real helper's timeout is
// replaced per test with a rejection.
function waitForRecordedProject(ref: { environmentId: EnvironmentId; projectId: string }) {
  const find = () =>
    appAtomRegistry
      .get(projectsAtom())
      .find(
        (project) => project.id === ref.projectId && project.environmentId === ref.environmentId,
      );
  return new Promise<Project>((resolve) => {
    const current = find();
    if (current) return resolve(current);
    const unsubscribe = appAtomRegistry.subscribe(projectsAtom(), () => {
      const project = find();
      if (!project) return;
      unsubscribe();
      resolve(project);
    });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function pageText() {
  return document.body.textContent ?? "";
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) {
  const target = button(label);
  expect(target.disabled).toBe(false);
  await act(async () => target.click());
}

async function clickStage(label: string) {
  const stage = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(stage?.disabled).toBe(false);
  await act(async () => stage?.click());
}

async function mountImport(remote = false) {
  state.selectedEnvironment = remote ? "remote" : "primary";
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <WelcomeWizard localAvailable={!remote} onDone={state.onDone} />
      </RegistryContext.Provider>,
    ),
  );
  await click("Continue");
  await click("Continue");
  expect(pageText()).toContain("Import your projects");
  stack.move();
  return screen;
}

const codexId = ProviderInstanceId.make("codex");

function authState(phase: ProviderAuthState["phase"]) {
  const active = phase !== "idle";
  return {
    instanceId: codexId,
    phase,
    flowId: active ? "flow-1" : null,
    authorizationUrl: active ? "https://auth.openai.com/oauth/authorize" : null,
    expiresAt: null,
    message: null,
  } as ProviderAuthState;
}

function configAtom() {
  return state.config as Atom.Writable<ServerConfig | null>;
}

// The server replaces its settings with the patch, so later reads see the new setup mode.
async function applySettingsPatch({
  input,
}: {
  input: { patch: Partial<ServerConfig["settings"]> };
}) {
  const config = appAtomRegistry.get(configAtom())!;
  appAtomRegistry.set(configAtom(), {
    ...config,
    settings: { ...config.settings, ...input.patch },
  });
  return AsyncResult.success(undefined);
}

function codexSetupMode() {
  const config = appAtomRegistry.get(configAtom())?.settings.providerInstances[codexId]?.config;
  return config !== null && typeof config === "object" && "setupMode" in config
    ? config.setupMode
    : undefined;
}

// A signed-out Codex CLI with no Codex entry in settings, as on a fresh install.
async function mountCodexAgents() {
  appAtomRegistry.set(configAtom(), {
    settings: DEFAULT_SERVER_SETTINGS,
    cwd: "/projects",
    environment: { platform: { os: "linux" } },
    keybindings: [],
  } as unknown as ServerConfig);
  appAtomRegistry.set(state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>, [
    {
      instanceId: codexId,
      driver: ProviderDriverKind.make("codex"),
      installed: true,
      enabled: true,
      version: "0.163.0",
      status: "error",
      auth: { status: "unauthenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      skills: [],
      slashCommands: [],
      setup: { canAuthenticate: true, canInstall: true },
    },
  ]);
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <WelcomeWizard localAvailable onDone={state.onDone} />
      </RegistryContext.Provider>,
    ),
  );
  await click("Continue");
  expect(pageText()).toContain("Connect your agents");
  stack.move();
  return screen;
}

// The mocked modules read `state`, so every test starts by replacing all of it.
// Returns the clock spy so each test can `using` it; the spy would otherwise outlive the test.
function setup() {
  const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  state.addedEnvironments = [];
  state.sessions.clear();
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
  state.authState = Atom.make(AsyncResult.success(authState("idle"))).pipe(Atom.keepAlive);
  state.installState = Atom.make(
    AsyncResult.success<ProviderInstallState>({
      driver: ProviderDriverKind.make("codex"),
      operationId: null,
      phase: "idle",
      downloadedBytes: 0,
      totalBytes: null,
      version: "0.163.0",
      installedVersion: "0.163.0",
      source: "managed",
      canRemove: true,
      message: null,
    }),
  ).pipe(Atom.keepAlive);
  state.candidates = [candidate("/projects/first"), candidate("/projects/second")];
  state.createProject
    .mockReset()
    .mockImplementation(async (input: CreateProjectInput) => recordProject(input));
  state.importThreads
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ importedCount: 1, skippedCount: 0 }));
  state.refreshProviders.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateSettings.mockReset().mockImplementation(applySettingsPatch);
  state.startProviderAuth.mockReset().mockImplementation(async () => {
    const waiting = authState("waiting");
    appAtomRegistry.set(state.authState as Atom.Writable<unknown>, AsyncResult.success(waiting));
    return AsyncResult.success(waiting);
  });
  state.connectPairing.mockReset().mockResolvedValue(AsyncResult.success(remoteId));
  state.completeOnboarding.mockReset().mockResolvedValue(undefined);
  state.onDone.mockReset();
  state.scan.mockReset();
  state.refreshScan.mockReset();
  state.waitForProject.mockReset().mockImplementation(waitForRecordedProject);
  return now;
}

it("keeps the project selection after going back a stage", async () => {
  using _now = setup();
  await using _screen = await mountImport();
  await click("Select none");
  expect(pageText()).toContain("0 of 2 selected");

  await clickStage("Agents, step 2");
  await click("Continue");
  expect(pageText()).toContain("Import your projects");
  expect(pageText()).toContain("0 of 2 selected");
});

it("ticks the recent projects of a computer added after the selection changed", async () => {
  using _now = setup();
  await using _screen = await mountImport();
  await click("Select none");

  state.addedEnvironments = ["remote"];
  await clickStage("Connect, step 1");
  await click("Continue");
  await click("Continue");
  expect(pageText()).toContain("2 of 4 selected");

  await click("Import 2 projects");
  const created = state.createProject.mock.calls as Array<[CreateProjectInput]>;
  expect(created.map(([call]) => call.environmentId)).toEqual([remoteId, remoteId]);
});

it("rechecks after project creation and can retry its history without recreating the project", async () => {
  using _now = setup();
  const creation = deferred<void>();
  state.createProject.mockImplementationOnce(async (input: CreateProjectInput) => {
    await creation.promise;
    return recordProject(input);
  });
  await using _screen = await mountImport();
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
  expect(pageText()).toContain(permissionMessage);

  await act(async () => setGrant(primaryId, true));
  await click("Import 2 projects");
  expect(state.createProject).toHaveBeenCalledTimes(2);
  expect(state.importThreads).toHaveBeenCalledTimes(2);
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("completes accepted imports when permission is revoked after the final server write", async () => {
  using _now = setup();
  state.candidates = state.candidates.slice(0, 1);
  const imported = deferred<{ importedCount: number; skippedCount: number }>();
  state.importThreads.mockImplementationOnce(async () =>
    AsyncResult.success(await imported.promise),
  );
  await using _screen = await mountImport();
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

it("finishes setup without landing when the imported project never reaches the client", async () => {
  using _now = setup();
  state.candidates = state.candidates.slice(0, 1);
  // The server accepts the project, but it never shows up in the client's projects.
  state.createProject.mockResolvedValue(AsyncResult.success(undefined));
  state.waitForProject.mockRejectedValue(new Error("The project did not appear."));
  state.completeOnboarding.mockRejectedValueOnce(new Error("offline"));
  await using _screen = await mountImport();

  await click("Import 1 project");
  await vi.waitFor(() => expect(state.completeOnboarding).toHaveBeenCalledOnce());
  // A failed completion hands the step back instead of leaving it importing.
  await vi.waitFor(() => expect(button("Import 1 project").disabled).toBe(false));
  expect(state.onDone).not.toHaveBeenCalled();

  await click("Import 1 project");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.onDone).toHaveBeenCalledWith(undefined);
});

it("can switch Codex back to ChatGPT sign-in after choosing the existing CLI", async () => {
  using _now = setup();
  await using _screen = await mountCodexAgents();

  await click("Use existing CLI");
  await vi.waitFor(() => expect(codexSetupMode()).toBe("existing"));
  await vi.waitFor(() =>
    expect(
      [...document.querySelectorAll("button")]
        .map((element) => element.textContent?.trim())
        .join(" | "),
      "the signed-out Codex card must still offer ChatGPT sign-in",
    ).toContain("Continue with ChatGPT"),
  );

  await click("Continue with ChatGPT");
  await vi.waitFor(() => expect(state.startProviderAuth).toHaveBeenCalledOnce());
  expect(codexSetupMode()).toBe("managed");
});

it("keeps the Codex ChatGPT fallback disabled without permission to manage providers", async () => {
  using _now = setup();
  await using _screen = await mountCodexAgents();

  await click("Use existing CLI");
  await vi.waitFor(() => expect(codexSetupMode()).toBe("existing"));
  await act(async () =>
    appAtomRegistry.set(
      sessionAtom(primaryId),
      AsyncResult.success({
        ...session([AuthOrchestrationOperateScope]),
        permissions: [
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
          AuthSettingsWriteScope,
        ],
      }),
    ),
  );
  await vi.waitFor(() => expect(button("Continue with ChatGPT").disabled).toBe(true));

  await act(async () => button("Continue with ChatGPT").click());
  expect(state.startProviderAuth).not.toHaveBeenCalled();
  expect(codexSetupMode()).toBe("existing");
});
