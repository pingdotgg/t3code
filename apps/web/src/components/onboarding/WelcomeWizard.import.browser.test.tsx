import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
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
  cancelProviderAuth: vi.fn(),
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
      cancelProviderAuth: "cancelProviderAuth" as never,
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
      | "cancelProviderAuth"
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

function authState(phase: ProviderAuthState["phase"], message: string | null = null) {
  const active = phase !== "idle";
  return {
    instanceId: codexId,
    phase,
    flowId: active ? "flow-1" : null,
    authorizationUrl: active ? "https://auth.openai.com/oauth/authorize" : null,
    expiresAt: null,
    message,
  } as ProviderAuthState;
}

function authStateAtom() {
  return state.authState as Atom.Writable<AsyncResult.AsyncResult<ProviderAuthState>>;
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
async function mountCodexSignIn() {
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
  expect(codexSetupMode()).toBeUndefined();
  await click("Continue with ChatGPT");
  await vi.waitFor(() => expect(state.startProviderAuth).toHaveBeenCalledOnce());
  // The server only signs in to its own runtime, so the attempt switches to managed first.
  expect(codexSetupMode()).toBe("managed");
  await vi.waitFor(() => button("Cancel"));
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
    const waiting = authState("waiting", "Complete sign-in in your browser.");
    appAtomRegistry.set(authStateAtom(), AsyncResult.success(waiting));
    return AsyncResult.success(waiting);
  });
  state.cancelProviderAuth.mockReset().mockImplementation(async () => {
    appAtomRegistry.set(
      authStateAtom(),
      AsyncResult.success(authState("cancelled", "Sign-in cancelled.")),
    );
    return AsyncResult.success(undefined);
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

it("restores the Codex setup mode when ChatGPT sign-in from onboarding is cancelled", async () => {
  using _now = setup();
  await using _screen = await mountCodexSignIn();

  await click("Cancel");
  expect(state.cancelProviderAuth).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(codexSetupMode(), "a cancelled sign-in must not leave Codex managed").toBeUndefined(),
  );
});

it("restores the Codex setup mode when ChatGPT sign-in from onboarding fails", async () => {
  using _now = setup();
  await using _screen = await mountCodexSignIn();
  // Another client adds a provider and disables Codex while sign-in is pending.
  const otherId = ProviderInstanceId.make("codex-work");
  const config = appAtomRegistry.get(configAtom())!;
  appAtomRegistry.set(configAtom(), {
    ...config,
    settings: {
      ...config.settings,
      providerInstances: {
        ...config.settings.providerInstances,
        [codexId]: { ...config.settings.providerInstances[codexId]!, enabled: false },
        [otherId]: { driver: ProviderDriverKind.make("codex"), config: {} },
      },
    },
  });

  await act(async () =>
    appAtomRegistry.set(
      authStateAtom(),
      AsyncResult.success(
        authState("failed", "ChatGPT sign-in was declined. Sign in again when you are ready."),
      ),
    ),
  );
  await vi.waitFor(() =>
    expect(codexSetupMode(), "a failed sign-in must not leave Codex managed").toBeUndefined(),
  );
  const instances = appAtomRegistry.get(configAtom())?.settings.providerInstances;
  expect(instances?.[otherId]).toBeDefined();
  expect(instances?.[codexId]?.enabled).toBe(false);
  await vi.waitFor(() =>
    expect(pageText()).toContain("ChatGPT sign-in was declined. Sign in again when you are ready."),
  );

  // A later CLI login makes the earlier ChatGPT failure stale.
  const [codex] = appAtomRegistry.get(
    state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>,
  );
  await act(async () =>
    appAtomRegistry.set(state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>, [
      { ...codex!, status: "ready", auth: { status: "authenticated" } },
    ]),
  );
  await vi.waitFor(() => expect(pageText()).toContain("Ready"));
  expect(pageText()).not.toContain("ChatGPT sign-in was declined");
});

it("keeps the Codex setup mode managed when ChatGPT sign-in from onboarding succeeds", async () => {
  using _now = setup();
  await using _screen = await mountCodexSignIn();

  await act(async () =>
    appAtomRegistry.set(authStateAtom(), AsyncResult.success(authState("succeeded"))),
  );
  // The card asks for a provider refresh once it sees the flow succeed.
  await vi.waitFor(() =>
    expect(state.refreshProviders).toHaveBeenCalledWith(
      expect.objectContaining({ input: { instanceId: codexId } }),
    ),
  );
  expect(state.updateSettings).toHaveBeenCalledOnce();
  expect(codexSetupMode()).toBe("managed");
});

it("keeps the Codex setup mode managed when sign-in succeeds before Cancel reaches the server", async () => {
  using _now = setup();
  await using _screen = await mountCodexSignIn();
  state.cancelProviderAuth.mockImplementationOnce(async () => {
    appAtomRegistry.set(authStateAtom(), AsyncResult.success(authState("succeeded")));
    return AsyncResult.failure(Cause.fail(new Error("This sign-in is no longer active.")));
  });

  await click("Cancel");
  await vi.waitFor(() => expect(pageText()).toContain("This sign-in is no longer active."));
  expect(state.updateSettings).toHaveBeenCalledOnce();
  expect(codexSetupMode()).toBe("managed");
});

it("keeps the Codex setup mode managed when a retry fails after a successful sign-in", async () => {
  using _now = setup();
  await using _screen = await mountCodexSignIn();
  const providers = state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>;
  const [codex] = appAtomRegistry.get(providers);

  await act(async () =>
    appAtomRegistry.set(authStateAtom(), AsyncResult.success(authState("succeeded"))),
  );
  await act(async () =>
    appAtomRegistry.set(providers, [
      { ...codex!, status: "ready", auth: { status: "authenticated" } },
    ]),
  );
  await vi.waitFor(() => expect(pageText()).toContain("Ready"));
  // Signed out later, the user tries again from the managed card and the retry fails.
  await act(async () => appAtomRegistry.set(providers, [codex!]));
  await vi.waitFor(() => button("Continue with ChatGPT"));
  await click("Continue with ChatGPT");
  await vi.waitFor(() => expect(state.startProviderAuth).toHaveBeenCalledTimes(2));
  await act(async () =>
    appAtomRegistry.set(
      authStateAtom(),
      AsyncResult.success(authState("failed", "ChatGPT sign-in could not finish.")),
    ),
  );
  await vi.waitFor(() => expect(pageText()).toContain("ChatGPT sign-in could not finish."));
  expect(state.updateSettings).toHaveBeenCalledOnce();
  expect(codexSetupMode()).toBe("managed");
});
