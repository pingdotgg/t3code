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
import * as Cause from "effect/Cause";
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
  candidates: [] as AgentSessionProjectCandidate[],
  createProject: vi.fn(),
  importThreads: vi.fn(),
  refreshProviders: vi.fn(),
  connectPairing: vi.fn(),
  completeOnboarding: vi.fn(),
  onDone: vi.fn(),
  scan: vi.fn(),
  refreshScan: vi.fn(),
  waitForProject: vi.fn(),
  toast: vi.fn(),
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
    command: "createProject" | "importThreads" | "refreshProviders" | "connectPairing",
  ) => state[command]) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});
vi.mock(import("../settings/ChatGptWelcomeCoordinator"), async (original) => ({
  ...(await original()),
  ChatGptWelcomeCoordinator: () => <></>,
}));

import { formatOnboardingImportWarning } from "../../onboarding/projectImport.logic";
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
  state.waitForProject.mockReset().mockImplementation(waitForRecordedProject);
  state.toast.mockReset().mockReturnValue("toast");
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

// The summary text itself is covered by projectImport.logic.test.ts; these check the counts.
function expectImportSummary(
  counts: Parameters<typeof formatOnboardingImportWarning>[0],
  canContinue: boolean,
) {
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: formatOnboardingImportWarning(counts) }),
  );
  const [toast] = state.toast.mock.calls.at(-1) ?? [];
  expect(toast?.actionProps?.children).toBe(canContinue ? "Continue import" : undefined);
}

it("imports in batches and stops after the current batch without starting the next project", async () => {
  using _now = setup();
  const secondBatch = deferred<{
    importedCount: number;
    skippedCount: number;
    deferredCount: number;
  }>();
  state.importThreads
    .mockResolvedValueOnce(
      AsyncResult.success({ importedCount: 2, skippedCount: 5, deferredCount: 5 }),
    )
    .mockImplementationOnce(async () => AsyncResult.success(await secondBatch.promise));
  await using _screen = await mountImport();

  await click("Import 2 projects");
  await vi.waitFor(() => expect(state.importThreads).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(pageText()).toContain("Importing first (1 of 2)… 2 threads imported, 5 left"),
  );

  await click("Stop importing");
  expect(button("Stopping…").disabled).toBe(true);
  await act(async () => {
    secondBatch.resolve({ importedCount: 4, skippedCount: 3, deferredCount: 3 });
    await secondBatch.promise;
  });
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.importThreads).toHaveBeenCalledTimes(2);
  expect(state.createProject).toHaveBeenCalledOnce();
  expectImportSummary({ imported: 4, failed: 0, deferred: 3, stopped: true }, true);
});

it("stops when a batch makes no progress and reports the rest as not imported", async () => {
  using _now = setup();
  state.candidates = state.candidates.slice(0, 1);
  state.importThreads.mockResolvedValue(
    AsyncResult.success({ importedCount: 2, skippedCount: 5, deferredCount: 5 }),
  );
  await using _screen = await mountImport();

  await click("Import 1 project");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.importThreads).toHaveBeenCalledTimes(2);
  expectImportSummary({ imported: 2, failed: 5, deferred: 0, stopped: false }, false);
});

it("keeps the last successful batch when a later batch fails", async () => {
  using _now = setup();
  state.candidates = state.candidates.slice(0, 1);
  state.importThreads
    .mockResolvedValueOnce(
      AsyncResult.success({ importedCount: 2, skippedCount: 5, deferredCount: 5 }),
    )
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
  await using _screen = await mountImport();

  await click("Import 1 project");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.importThreads).toHaveBeenCalledTimes(2);
  expect(state.refreshScan).toHaveBeenCalledOnce();
  expectImportSummary({ imported: 2, failed: 0, deferred: 5, stopped: false }, true);
});

it("counts each project's last batch and treats servers without deferred counts as one batch", async () => {
  using _now = setup();
  state.importThreads
    .mockResolvedValueOnce(AsyncResult.success({ importedCount: 1, skippedCount: 2 }))
    .mockResolvedValueOnce(
      AsyncResult.success({ importedCount: 2, skippedCount: 3, deferredCount: 3 }),
    )
    .mockResolvedValueOnce(
      AsyncResult.success({ importedCount: 5, skippedCount: 0, deferredCount: 0 }),
    );
  await using _screen = await mountImport();

  await click("Import 2 projects");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.importThreads).toHaveBeenCalledTimes(3);
  expectImportSummary({ imported: 6, failed: 2, deferred: 0, stopped: false }, false);
});

it("reopens setup on the unfinished projects through Continue import", async () => {
  using _now = setup();
  // Fewer than three conversations keeps a project out of the default selection.
  state.candidates = [
    candidate("/projects/first"),
    { ...candidate("/projects/lonely"), threadCount: 1 },
  ];
  state.importThreads
    .mockResolvedValueOnce(AsyncResult.success({ importedCount: 1, skippedCount: 0 }))
    .mockResolvedValueOnce(
      AsyncResult.success({ importedCount: 1, skippedCount: 3, deferredCount: 3 }),
    )
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
  await using screen = await mountImport();
  expect(pageText()).toContain("1 of 2 selected");
  await click("Select all");
  await click("Import 2 projects");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  const [toast] = state.toast.mock.calls.at(-1) ?? [];
  await act(async () => toast?.actionProps?.onClick());

  await screen.rerender(
    <RegistryContext.Provider value={appAtomRegistry}>
      <WelcomeWizard key="reopened" localAvailable onDone={state.onDone} />
    </RegistryContext.Provider>,
  );
  expect(pageText()).toContain("Import your projects");
  expect(pageText()).toContain("1 of 2 selected");
  await click("Import 1 project");
  await vi.waitFor(() => expect(state.importThreads).toHaveBeenCalledTimes(4));
  expect(state.importThreads).toHaveBeenLastCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ expectedWorkspaceRoot: "/projects/lonely" }),
    }),
  );
  expect(state.createProject).toHaveBeenCalledTimes(2);
});
