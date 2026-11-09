import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentSessionProjectCandidate,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type EnvironmentCloudLinkStateResult,
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
  sessions: new Map<string, unknown>(),
  projects: null as unknown,
  providers: null as unknown,
  config: null as unknown,
  candidates: null as unknown,
  createProject: vi.fn(),
  importThreads: vi.fn(),
  refreshProviders: vi.fn(),
  completeOnboarding: vi.fn(),
  onDone: vi.fn(),
  scan: vi.fn(),
  refreshScan: vi.fn(),
  waitForProject: vi.fn(),
  cloud: false,
  auth: { isLoaded: true, isSignedIn: false, userId: null as string | null },
  linkState: null as unknown,
  linkError: null as string | null,
  refreshLinkState: vi.fn(),
  scanError: null as string | null,
  scanPending: false,
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
  hasCloudPublicConfig: () => state.cloud,
}));
vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useAuth: (() => state.auth) as never,
}));
vi.mock(import("../clerk/useT3ConnectAuthPrompt"), async (original) => ({
  ...(await original()),
  useT3ConnectAuthPrompt: (() => ({ openAuthPrompt: () => {} })) as never,
}));
vi.mock(import("../../cloud/cloudLinkState"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useCloudLinkState: (() => ({
      data: useAtomValue(state.linkState as Atom.Atom<EnvironmentCloudLinkStateResult | null>),
      error: state.linkError,
      isPending: false,
      refresh: state.refreshLinkState,
    })) as never,
  };
});
vi.mock(import("../../onboarding/firstRun"), async (original) => ({
  ...(await original()),
  completeOnboarding: state.completeOnboarding,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [{ environmentId: "primary", label: "primary" }],
  })) as never,
  usePrimaryEnvironmentId: (() => "primary") as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => state.providers) as never,
      configValueAtom: (() => state.config) as never,
      refreshProviders: "refreshProviders" as never,
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
vi.mock(import("../../onboarding/useProjectScans"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useProjectScans: (ids: readonly EnvironmentId[]) => {
      const candidates = useAtomValue(
        state.candidates as Atom.Atom<AgentSessionProjectCandidate[]>,
      );
      return ids.map((environmentId) => {
        state.scan({ environmentId });
        return {
          environmentId,
          data: (state.scanPending ? null : { candidates, truncated: false }) as never,
          isPending: state.scanPending,
          error: state.scanError,
          refresh: state.refreshScan,
        };
      });
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "createProject" | "importThreads" | "refreshProviders") =>
    state[command]) as never,
}));

import { welcomeImportSelectionKey } from "../../onboarding/welcomeState";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { WelcomePage } from "./WelcomePage";

const primaryId = EnvironmentId.make("primary");
const readyClaude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
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

function candidatesAtom() {
  return state.candidates as Atom.Writable<ReadonlyArray<AgentSessionProjectCandidate>>;
}

function setGrant(environmentId: EnvironmentId, allowed: boolean) {
  appAtomRegistry.set(
    sessionAtom(environmentId),
    AsyncResult.success(session(allowed ? [AuthOrchestrationOperateScope] : [])),
  );
}

// Default selection only picks recently active projects, so pin "now".
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function candidate(
  path: string,
  overrides: Partial<AgentSessionProjectCandidate> = {},
): AgentSessionProjectCandidate {
  return {
    path,
    title: path.split("/").at(-1)!,
    sources: ["codex"],
    threadCount: 10,
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    alreadyImported: false,
    ...overrides,
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

async function mountWelcome() {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <WelcomePage environmentId={primaryId} onDone={state.onDone} />
    </RegistryContext.Provider>,
  );
}

// The mocked modules read `state`, so every test starts by replacing all of it.
// Returns the clock spy so each test can `using` it; the spy would otherwise outlive the test.
function setup() {
  const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  state.sessions.clear();
  for (const id of [primaryId]) {
    state.sessions.set(
      id,
      Atom.make<SessionResult>(AsyncResult.success(session([AuthOrchestrationOperateScope]))).pipe(
        Atom.keepAlive,
      ),
    );
  }
  state.projects = Atom.make<ReadonlyArray<Project>>([]).pipe(Atom.keepAlive);
  state.providers = Atom.make<ReadonlyArray<ServerProvider>>([readyClaude]).pipe(Atom.keepAlive);
  state.config = Atom.make(null).pipe(Atom.keepAlive);
  state.candidates = Atom.make<ReadonlyArray<AgentSessionProjectCandidate>>([
    candidate("/projects/first"),
    candidate("/projects/second"),
  ]).pipe(Atom.keepAlive);
  state.createProject
    .mockReset()
    .mockImplementation(async (input: CreateProjectInput) => recordProject(input));
  state.importThreads
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ importedCount: 1, skippedCount: 0 }));
  state.refreshProviders.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.completeOnboarding.mockReset().mockResolvedValue(undefined);
  state.onDone.mockReset();
  state.scan.mockReset();
  state.refreshScan.mockReset();
  state.waitForProject.mockReset().mockImplementation(waitForRecordedProject);
  state.cloud = false;
  state.auth = { isLoaded: true, isSignedIn: false, userId: null };
  state.linkState = Atom.make<EnvironmentCloudLinkStateResult | null>(null).pipe(Atom.keepAlive);
  state.linkError = null;
  state.refreshLinkState.mockReset();
  state.scanError = null;
  state.scanPending = false;
  localStorage.removeItem(welcomeImportSelectionKey(primaryId));
  return now;
}

it("rechecks after project creation and can retry its history without recreating the project", async () => {
  using _now = setup();
  const creation = deferred<void>();
  state.createProject.mockImplementationOnce(async (input: CreateProjectInput) => {
    await creation.promise;
    return recordProject(input);
  });
  await using _screen = await mountWelcome();
  await click("Import 2 projects and start");
  expect(state.createProject).toHaveBeenCalledOnce();
  await act(async () => {
    setGrant(primaryId, false);
    creation.resolve();
    await creation.promise;
  });
  expect(state.importThreads).not.toHaveBeenCalled();
  expect(state.createProject).toHaveBeenCalledOnce();
  expect(state.onDone).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(pageText()).toContain(permissionMessage));

  await act(async () => setGrant(primaryId, true));
  // The first project now exists, so only the second counts as new.
  await click("Import 1 project and start");
  expect(state.createProject).toHaveBeenCalledTimes(2);
  expect(state.importThreads).toHaveBeenCalledTimes(2);
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("completes accepted imports when permission is revoked after the final server write", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), [candidate("/projects/first")]);
  const imported = deferred<{ importedCount: number; skippedCount: number }>();
  state.importThreads.mockImplementationOnce(async () =>
    AsyncResult.success(await imported.promise),
  );
  await using _screen = await mountWelcome();
  await click("Import 1 project and start");
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
  appAtomRegistry.set(candidatesAtom(), [candidate("/projects/first")]);
  // The server accepts the project, but it never shows up in the client's projects.
  state.createProject.mockResolvedValue(AsyncResult.success(undefined));
  state.waitForProject.mockRejectedValue(new Error("The project did not appear."));
  state.completeOnboarding.mockRejectedValueOnce(new Error("offline"));
  await using _screen = await mountWelcome();

  await click("Import 1 project and start");
  await vi.waitFor(() => expect(state.completeOnboarding).toHaveBeenCalledOnce());
  // A failed completion hands the step back instead of leaving it importing.
  await vi.waitFor(() => expect(button("Import 1 project and start").disabled).toBe(false));
  expect(state.onDone).not.toHaveBeenCalled();

  await click("Import 1 project and start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.onDone).toHaveBeenCalledWith(undefined);
});

it("waits for a ready agent to start, and Start without an agent still finishes setup", async () => {
  using _now = setup();
  appAtomRegistry.set(state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>, []);
  await using _screen = await mountWelcome();
  expect(button("Import 2 projects and start").disabled).toBe(true);

  await click("Start without an agent");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).toHaveBeenCalledTimes(2);
});

it("blocks leaving the page until the imported projects have landed", async () => {
  using _now = setup();
  const creation = deferred<void>();
  state.createProject.mockImplementationOnce(async (input: CreateProjectInput) => {
    await creation.promise;
    return recordProject(input);
  });
  const landing = deferred<void>();
  state.waitForProject.mockImplementation(
    async (ref: { environmentId: EnvironmentId; projectId: string }) => {
      await landing.promise;
      return waitForRecordedProject(ref);
    },
  );
  await using screen = await mountWelcome();
  await click("Import 2 projects and start");

  // A blocked navigation never settles, so it is not awaited.
  const leave = () =>
    act(async () => {
      void screen.router?.navigate({ to: "/settings" });
    });
  await leave();
  await act(async () => {
    creation.resolve();
    await creation.promise;
  });
  await vi.waitFor(() => expect(state.waitForProject).toHaveBeenCalledOnce());
  await leave();
  expect(screen.router?.state.location.pathname).toBe("/");

  const saved = deferred<void>();
  state.completeOnboarding.mockImplementationOnce(() => saved.promise);
  await act(async () => {
    landing.resolve();
    await landing.promise;
  });
  await vi.waitFor(() => expect(state.completeOnboarding).toHaveBeenCalledOnce());
  await leave();
  expect(screen.router?.state.location.pathname).toBe("/");

  await act(async () => {
    saved.resolve();
    await saved.promise;
  });
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(screen.router?.state.location.pathname).toBe("/");
  expect(state.createProject).toHaveBeenCalledTimes(2);
});

it("gives projects a later scan finds the default, unless the main box was unchecked", async () => {
  using _now = setup();
  await using _screen = await mountWelcome();
  // Turning on another agent rescans and finds a recent project the user has not seen.
  const findProject = (path: string) =>
    act(async () =>
      appAtomRegistry.set(candidatesAtom(), [
        ...appAtomRegistry.get(candidatesAtom()),
        candidate(path),
      ]),
    );

  await click("Review all 2");
  await click("Select none");
  await findProject("/projects/third");
  await vi.waitFor(() => expect(button("Import 1 project and start").disabled).toBe(false));

  const importProjects = document.querySelector<HTMLElement>('[role="checkbox"]');
  await act(async () => importProjects?.click());
  await findProject("/projects/fourth");
  await vi.waitFor(() => expect(button("Start").disabled).toBe(false));
});

it("keeps the project choice across a visit to Settings until setup finishes", async () => {
  using _now = setup();
  {
    await using _first = await mountWelcome();
    const importProjects = document.querySelector<HTMLElement>('[role="checkbox"]');
    await act(async () => importProjects?.click());
    await vi.waitFor(() => expect(button("Start").disabled).toBe(false));
  }
  // Coming back from Settings mounts the page again.
  {
    await using _second = await mountWelcome();
    expect(button("Start").disabled).toBe(false);
    await click("Start");
    await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
    expect(state.createProject).not.toHaveBeenCalled();
  }
  await using _third = await mountWelcome();
  expect(button("Import 2 projects and start").disabled).toBe(false);
});

it("stays busy while setup saves after an import with nothing to open", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), [candidate("/projects/first")]);
  state.importThreads.mockResolvedValue(AsyncResult.success({ importedCount: 0, skippedCount: 1 }));
  const saved = deferred<void>();
  state.completeOnboarding.mockImplementationOnce(() => saved.promise);
  await using _screen = await mountWelcome();

  await click("Import 1 project and start");
  await vi.waitFor(() => expect(state.completeOnboarding).toHaveBeenCalledOnce());
  expect(button("Importing…").disabled).toBe(true);
  await act(async () => {
    saved.resolve();
    await saved.promise;
  });
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).toHaveBeenCalledOnce();
});

it("leaves projects already in T3 Code out of the default import, unless the box is checked", async () => {
  using _now = setup();
  const existing = ProjectId.make("existing");
  const justAdded = ProjectId.make("just-added");
  appAtomRegistry.set(projectsAtom(), [
    { id: existing, environmentId: primaryId, workspaceRoot: "/projects/first" },
    // Added a moment ago, so the cached scan does not know it exists yet.
    { id: justAdded, environmentId: primaryId, workspaceRoot: "/projects/second" },
  ]);
  appAtomRegistry.set(candidatesAtom(), [
    candidate("/projects/first", { alreadyImported: true, projectId: existing }),
    candidate("/projects/second"),
    candidate("/projects/third"),
  ]);
  {
    await using _screen = await mountWelcome();
    await vi.waitFor(() => expect(pageText()).toContain("Import 1 project and their threads"));
  }

  // With every project already in T3 Code, checking the box still picks them.
  appAtomRegistry.set(candidatesAtom(), appAtomRegistry.get(candidatesAtom()).slice(0, 2));
  await using _screen = await mountWelcome();
  const importProjects = document.querySelector<HTMLElement>('[role="checkbox"]');
  await act(async () => importProjects?.click());
  await vi.waitFor(() => expect(pageText()).toContain("Import 2 projects and their threads"));
  expect(button("Import threads and start").disabled).toBe(false);
});

it("keeps the started projects checked when the page opens again after a quit", async () => {
  using _now = setup();
  const imported = deferred<{ importedCount: number; skippedCount: number }>();
  state.importThreads.mockImplementationOnce(async () =>
    AsyncResult.success(await imported.promise),
  );
  {
    await using _first = await mountWelcome();
    await click("Import 2 projects and start");
    await vi.waitFor(() => expect(state.importThreads).toHaveBeenCalledOnce());
  }
  // The app quit during the first project's history; it now exists in T3 Code.
  const [first] = appAtomRegistry.get(projectsAtom());
  appAtomRegistry.set(candidatesAtom(), [
    candidate("/projects/first", { alreadyImported: true, projectId: first!.id }),
    candidate("/projects/second"),
  ]);
  await using _second = await mountWelcome();
  await vi.waitFor(() => expect(pageText()).toContain("Import 2 projects and their threads"));
});

it("keeps the project controls when a later scan fails", async () => {
  using _now = setup();
  await using _screen = await mountWelcome();
  state.scanError = "The scan timed out.";
  await act(async () =>
    appAtomRegistry.set(candidatesAtom(), [...appAtomRegistry.get(candidatesAtom())]),
  );
  await vi.waitFor(() => expect(pageText()).toContain("Could not check projects again."));
  expect(button("Import 2 projects and start").disabled).toBe(false);
  expect(button("Retry").disabled).toBe(false);
});

it("keeps saved picks when Start comes before the project list loads", async () => {
  using _now = setup();
  const saved = JSON.stringify({ knownKeys: ["a"], keys: ["a"], optedOut: false });
  localStorage.setItem(welcomeImportSelectionKey(primaryId), saved);
  state.scanPending = true;
  await using _screen = await mountWelcome();

  await click("Start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  // An import a quit cut short is still checked on the next visit.
  expect(localStorage.getItem(welcomeImportSelectionKey(primaryId))).toBe(saved);
});

it("starts without importing when this connection cannot import projects", async () => {
  using _now = setup();
  setGrant(primaryId, false);
  await using _screen = await mountWelcome();
  expect(pageText()).not.toContain("Review all");

  await click("Start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).not.toHaveBeenCalled();
});

it("says the phone is set up only once this computer is shared with the signed-in account", async () => {
  using _now = setup();
  state.cloud = true;
  state.auth = { isLoaded: true, isSignedIn: true, userId: "user_1" };
  appAtomRegistry.set(
    sessionAtom(primaryId),
    AsyncResult.success(
      session([AuthOrchestrationOperateScope, AuthRelayReadScope, AuthRelayWriteScope]),
    ),
  );
  state.linkError = "Could not read T3 Connect link state.";
  await using _screen = await mountWelcome();
  await click("Set up");
  // A failed read says so instead of asking to share the computer again.
  await vi.waitFor(() => expect(pageText()).toContain("Could not check T3 Connect."));
  expect(pageText()).not.toContain("Set up T3 Connect");

  state.linkError = null;
  await act(async () =>
    appAtomRegistry.set(state.linkState as Atom.Writable<EnvironmentCloudLinkStateResult | null>, {
      linked: false,
      cloudUserId: null,
      relayUrl: null,
      relayIssuer: null,
      publishAgentActivity: false,
    }),
  );
  // Signed in, but "Not now" on the share step left this computer unreachable.
  await vi.waitFor(() => expect(pageText()).toContain("Set up T3 Connect"));

  const share = (reachability: EnvironmentCloudLinkStateResult["reachability"]) =>
    act(async () =>
      appAtomRegistry.set(
        state.linkState as Atom.Writable<EnvironmentCloudLinkStateResult | null>,
        {
          linked: true,
          cloudUserId: "user_1",
          relayUrl: null,
          relayIssuer: null,
          managedTunnelActive: true,
          publishAgentActivity: true,
          reachability,
        },
      ),
    );
  const checkedAt = "2026-01-01T00:00:00.000Z";
  await share({
    status: "unreachable",
    checkedAt,
    cause: "connector_not_running",
    reason: "The tunnel is not running.",
    hint: null,
    fix: "Turn T3 Connect off and on.",
  });
  await vi.waitFor(() => expect(pageText()).toContain("Check T3 Connect"));
  expect(pageText()).not.toContain("Your phone can reach this computer.");

  await share({ status: "reachable", checkedAt, readyConnections: 4, protocol: "quic" });
  await vi.waitFor(() => expect(pageText()).toContain("Your phone can reach this computer."));
  expect(pageText()).not.toContain("Check T3 Connect");
});
