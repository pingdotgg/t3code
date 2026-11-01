import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createEnvironmentSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  EnvironmentId,
  ProjectId,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { ComposerDraft } from "../../state/use-composer-drafts";

const mocks = vi.hoisted(() => ({
  projects: vi.fn(),
  status: vi.fn(),
  refs: vi.fn(),
  readFile: vi.fn(),
  session: vi.fn(),
  presentation: vi.fn(),
  registry: vi.fn(),
  drafts: vi.fn(),
  snapshot: vi.fn(),
  createDraft: vi.fn(),
  retargetDraft: vi.fn(),
  writeSettings: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => mocks.registry().get(atom),
    set: (atom: Atom.Writable<unknown, unknown>, value: unknown) =>
      mocks.registry().set(atom, value),
  },
}));
vi.mock("../../state/entities", () => ({
  useProjects: mocks.projects,
  useThreadShells: () => [],
  useEnvironmentServerConfig: () => null,
  useServerConfigs: () => new Map(),
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { status: mocks.status, listRefs: mocks.refs },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { readFile: mocks.readFile, openScratch: {} },
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: mocks.session },
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: mocks.presentation,
}));
vi.mock("../../state/orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("../../state/threads", () => ({ olderSettledThreads: {}, threadFamilies: {} }));
vi.mock("../../state/pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("../../state/olderSettledShelf", () => ({ useOlderSettledCount: () => 0 }));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "none" }),
}));
vi.mock("./use-legacy-plan-mode-enabled", () => ({
  useLegacyPlanModeState: () => ({ enabled: false, loaded: true }),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
  setPendingConnectionError: vi.fn(),
}));
vi.mock("../../state/use-model-option-memory", () => ({
  rememberModelOptions: vi.fn(),
  withRememberedModelOptions: (value: unknown) => value,
}));
vi.mock("../../state/use-composer-drafts", () => ({
  composerDraftsLoadedAtom: Atom.make(true),
  useComposerDraft: mocks.drafts,
  getComposerDraftSnapshot: mocks.snapshot,
  createNewTaskDraft: mocks.createDraft,
  retargetNewTaskDraft: mocks.retargetDraft,
  updateComposerDraftSettings: mocks.writeSettings,
  setComposerDraftText: mocks.writeText,
  useStickyComposerModelSelection: () => null,
  isNewTaskDraftKey: (key: string) => key.startsWith("new-task:"),
  clearComposerDraft: vi.fn(),
  appendComposerDraftAttachments: vi.fn(),
  removeComposerDraftAttachment: vi.fn(),
  replaceComposerDraftAttachments: vi.fn(),
  setStickyComposerModelSelection: vi.fn(),
  setComposerDraftContext: vi.fn(),
  scheduleUnusedComposerAttachmentCleanup: vi.fn(),
  isComposerDraftEmpty: (draft: ComposerDraft) =>
    draft.text === "" && draft.attachments.length === 0,
}));

vi.mock("../../state/peerLinks", () => ({ useLinkedEnvironments: () => new Map() }));
vi.mock("../../state/project-has-threads", () => ({ useProjectHasThreads: () => false }));
vi.mock("../../state/workspace", () => ({
  useConnectionsReady: () => true,
  useWorkspaceEnvironments: () => [],
}));
vi.mock("../../state/shell", () => ({ useEnvironmentShellReadiness: () => ({}) }));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));

import { NewTaskFlowProvider, useNewTaskFlow } from "./new-task-flow-provider";

function project(environment: string, id: string): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environment),
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: "worktree",
    scripts: [],
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
  };
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.clearAllMocks();
  const registry = AtomRegistry.make();
  mocks.registry.mockReturnValue(registry);
  const projects = [project("one", "a"), project("one", "b"), project("two", "b")];
  mocks.projects.mockReturnValue(projects);
  mocks.presentation.mockReturnValue({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  });
  const events: string[] = [];
  let checkout = "main";
  let checkoutIsRepo = true;
  let holdStatus = false;
  const emitters = new Map<string, (branch: string, isRepo?: boolean) => void>();
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      followStream: (_environmentId, source) => source,
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const status = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "test:new-task-status",
    idleTtlMs: 10_000,
    subscribe: ({ cwd }: { cwd: string }) =>
      Stream.callback<{ refName: string; isRepo: boolean }>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push(`start:${cwd}`);
            const emit = (refName: string, isRepo = true) =>
              void Queue.offerUnsafe(queue, { refName, isRepo });
            emitters.set(cwd, emit);
            if (!holdStatus) emit(checkout, checkoutIsRepo);
          }),
          () => Effect.sync(() => void events.push(`stop:${cwd}`)),
        ),
      ),
  });
  mocks.status.mockImplementation(status);
  const refs = Atom.family((key: string) =>
    Atom.make(() => {
      const [, cwd] = JSON.parse(key) as [string, string];
      const result: VcsListRefsResult = {
        refs: [{ name: "main", current: true, isDefault: true, worktreePath: cwd }],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 1,
      };
      return AsyncResult.success(result);
    }).pipe(Atom.keepAlive),
  );
  mocks.refs.mockImplementation(({ environmentId, input }) =>
    refs(JSON.stringify([environmentId, input.cwd])),
  );
  const session = Atom.make(
    AsyncResult.success({ authenticated: true, scopes: [AuthFilesystemReadScope] }),
  );
  mocks.session.mockReturnValue(session);
  const file = Atom.make(AsyncResult.success({ exists: true, contents: "{}" }));
  mocks.readFile.mockReturnValue(file);

  const empty: ComposerDraft = { text: "", attachments: [] };
  const drafts = Atom.make<Record<string, ComposerDraft>>({}).pipe(Atom.keepAlive);
  const snapshot = (key: string | null): ComposerDraft =>
    (key === null ? undefined : registry.get(drafts)[key]) ?? empty;
  const write = (key: string, patch: Partial<ComposerDraft>) =>
    registry.set(drafts, { ...registry.get(drafts), [key]: { ...snapshot(key), ...patch } });
  mocks.drafts.mockImplementation((key: string | null) => {
    const all = useAtomValue(drafts);
    return (key === null ? undefined : all[key]) ?? empty;
  });
  mocks.snapshot.mockImplementation(snapshot);
  mocks.createDraft.mockImplementation((target) => {
    const key = `new-task:${Object.keys(registry.get(drafts)).length}`;
    write(key, { project: target });
    return key;
  });
  mocks.retargetDraft.mockImplementation((key, target) =>
    write(key, { project: target, workspaceSelection: undefined }),
  );
  mocks.writeSettings.mockImplementation(write);
  mocks.writeText.mockImplementation((key, text) => write(key, { text }));
  let current: ReturnType<typeof useNewTaskFlow>;
  function Probe() {
    const value = useNewTaskFlow();
    useLayoutEffect(() => {
      current = value;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  return {
    projects,
    events,
    checkout(branch: string, isRepo = true) {
      checkout = branch;
      checkoutIsRepo = isRepo;
    },
    holdStatus() {
      holdStatus = true;
    },
    offline() {
      mocks.presentation.mockReturnValue({
        isReady: true,
        presentation: { connection: { phase: "offline", error: null } },
      });
      holdStatus = true;
    },
    snapshot,
    clearWorkspace(key: string) {
      act(() => write(key, { workspaceSelection: undefined }));
    },
    get current() {
      return current;
    },
    async render(active: boolean) {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <NewTaskFlowProvider active={active} flowKey="test-flow">
              <Probe />
            </NewTaskFlowProvider>
          </RegistryContext.Provider>,
        ),
      );
    },
    async emit(cwd: string, branch: string, isRepo = true) {
      await act(async () => emitters.get(cwd)!(branch, isRepo));
    },
    async expireIdle() {
      await act(async () => vi.advanceTimersByTime(11_000));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      vi.useRealTimers();
    },
  };
}

it("owns a status stream only while the draft is active, retaining draft choices on reopen", async () => {
  using screen = setup();
  await screen.render(false);
  expect(screen.current.selectedProject).toEqual(screen.projects[0]);
  expect.soft([...screen.events]).toEqual([]);
  expect(mocks.createDraft).not.toHaveBeenCalled();

  await screen.render(true);
  expect(screen.events).toEqual(["start:/a"]);
  const draftKey = screen.current.draftKey!;
  act(() => screen.current.setPrompt("keep this draft"));

  await act(async () => screen.current.setProject(screen.projects[1]!));
  expect(screen.current.prompt).toBe("keep this draft");
  expect(screen.current.draftKey).toBe(draftKey);
  expect(screen.events).toEqual(["start:/a", "start:/b"]);
  await act(async () => screen.current.selectEnvironment(EnvironmentId.make("two")));
  expect(screen.current.selectedProject).toEqual(screen.projects[2]);
  expect(screen.snapshot(draftKey).project).toEqual({
    environmentId: "two",
    projectId: "b",
  });
  expect(screen.events).toEqual(["start:/a", "start:/b", "start:/b"]);
  // A late old-project result cannot replace the current environment's checkout.
  await screen.emit("/a", "stale-branch");
  expect(screen.current.currentCheckoutBranchName).toBe("main");
  expect(screen.snapshot(draftKey).workspaceSelection).toBeUndefined();
  act(() => screen.current.setWorkspaceMode("worktree"));
  act(() =>
    screen.current.selectBranch({
      name: "feature",
      current: false,
      isDefault: false,
      worktreePath: null,
    }),
  );
  act(() => screen.current.setStartFromOrigin(true));
  const chosenWorkspace = screen.snapshot(draftKey).workspaceSelection;
  expect(chosenWorkspace).toEqual({
    mode: "worktree",
    branch: "feature",
    worktreePath: null,
    startFromOrigin: true,
  });

  await screen.render(false);
  const settingsWrites = mocks.writeSettings.mock.calls.length;
  await screen.expireIdle();
  expect.soft(screen.events.filter((event) => event.startsWith("stop:"))).toHaveLength(3);
  expect(mocks.writeSettings).toHaveBeenCalledTimes(settingsWrites);
  expect(screen.snapshot(draftKey).workspaceSelection).toEqual(chosenWorkspace);
  expect(screen.current.prompt).toBe("keep this draft");

  screen.checkout("updated-checkout");
  await screen.render(true);
  expect.soft(screen.events.filter((event) => event.startsWith("start:"))).toHaveLength(4);
  expect.soft(screen.current.currentCheckoutBranchName).toBe("updated-checkout");
  expect(screen.current.prompt).toBe("keep this draft");
  expect(screen.snapshot(draftKey).workspaceSelection).toEqual(chosenWorkspace);
});

it("does not persist a provisional workspace default after releasing inactive status", async () => {
  using screen = setup();
  await screen.render(true);
  await screen.emit("/a", "main", false);
  const draftKey = screen.current.draftKey!;
  screen.clearWorkspace(draftKey);
  mocks.writeSettings.mockClear();
  expect(screen.snapshot(draftKey).workspaceSelection).toBeUndefined();
  await screen.render(false);
  expect(screen.snapshot(draftKey).workspaceSelection).toBeUndefined();
  expect(mocks.writeSettings).not.toHaveBeenCalled();
  await screen.expireIdle();
  screen.holdStatus();
  await screen.render(true);
  expect(screen.snapshot(draftKey).workspaceSelection).toBeUndefined();
  await screen.emit("/a", "main", false);
  expect(screen.snapshot(draftKey).workspaceSelection).toBeUndefined();
  expect(mocks.writeSettings).not.toHaveBeenCalled();
});

it("uses cached repository capability and branch defaults while offline", async () => {
  using screen = setup();
  screen.offline();
  await screen.render(true);
  expect(screen.current.currentCheckoutBranchName).toBeNull();
  expect(screen.current.isGitRepoKnown).toBe(true);
  expect(screen.current.workspaceMode).toBe("worktree");
  expect(screen.current.selectedBranchName).toBe("main");
  const draftKey = screen.current.draftKey!;
  expect(screen.snapshot(draftKey).workspaceSelection).toBeUndefined();
  await screen.render(false);
  await screen.expireIdle();
  await screen.render(true);
  expect(screen.current.draftKey).toBe(draftKey);
  expect(screen.current.selectedBranchName).toBe("main");
});
