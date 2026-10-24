import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  baseDirectory: "",
  home: "",
  cloneTracking: false,
  projects: [] as string[],
  existingProjects: [] as Array<{
    environmentId: string;
    id: string;
    title: string;
    workspaceRoot: string;
  }>,
  navigations: [] as unknown[],
  startedClones: [] as string[],
  draftTexts: new Map<string, string>(),
}));

// Mirrors the server: `~` is the environment's home, which the client cannot see.
function expandHome(path: string) {
  return path.startsWith("~") ? `${state.home}${path.slice(1)}` : path;
}

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
}));
vi.mock("../../components/ui/NavigationRow", () => ({ NavigationRow: "NavigationRow" }));
vi.mock("../../components/ui/Button", () => ({ Button: "Button" }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: "ScrollView" }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: "SettingsScreen" }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: "Switch" }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ActivityIndicator: "ActivityIndicator",
  Alert: { alert: () => {} },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    dispatch: (action: unknown) => state.navigations.push(action),
    getState: () => ({ index: 0, routes: [{ key: "home", name: "Home" }] }),
  }),
  CommonActions: { reset: (input: unknown) => input },
  StackActions: {},
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: "EnvironmentMachineSymbol",
}));
vi.mock("../../components/ui/ErrorBanner", () => ({ ErrorBanner: "ErrorBanner" }));
vi.mock("./SourceControlIcon", () => ({ SourceControlIcon: "SourceControlIcon" }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "project" }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: string, scope: string) => state.scopes.has(scope),
  readEnvironmentScope: (_environmentId: string, scope: string) => state.scopes.has(scope),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.existingProjects,
  waitForProject: async () => ({}),
  useServerConfigs: () =>
    new Map([
      [
        "environment",
        {
          environment: {
            platform: { os: "linux" },
            capabilities: { projectCloneTracking: state.cloneTracking },
          },
          settings: { addProjectBaseDirectory: state.baseDirectory },
        },
      ],
    ]),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => ({ connectionState: "connected" }),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [{ environmentId: "environment", connectionState: "connected" }],
  }),
  useSavedRemoteConnections: () => ({
    savedConnectionsById: {
      connection: { environmentId: "environment", environmentLabel: "Environment" },
    },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner:
    (query: unknown) =>
    async ({ input }: { input: { partialPath: string } }) => {
      if (query !== "browse") return undefined;
      const directory = expandHome(input.partialPath);
      return NodeFS.existsSync(directory)
        ? AsyncResult.success({ parentPath: NodePath.resolve(directory), entries: [] })
        : AsyncResult.failure(Cause.fail(new Error("read_directory_failed")));
    },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../../state/filesystem", () => ({ filesystemEnvironment: { browse: "browse" } }));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    cloneRepository: async ({ input }: { input: { destinationPath: string } }) => {
      const cwd = expandHome(input.destinationPath);
      NodeFS.mkdirSync(cwd);
      return AsyncResult.success({ cwd });
    },
    startProjectClone: async ({ input }: { input: { destinationPath: string } }) => {
      state.startedClones.push(input.destinationPath);
      return AsyncResult.success(undefined);
    },
  },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    create: async ({ input }: { input: { workspaceRoot: string } }) => {
      if (!state.scopes.has(AuthOrchestrationOperateScope)) {
        return AsyncResult.failure(Cause.fail(new Error("Project creation denied")));
      }
      state.projects.push(input.workspaceRoot);
      return AsyncResult.success(undefined);
    },
  },
}));

vi.mock("../../state/use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: async () => {},
  createNewTaskDraft: () => "draft",
  setComposerDraftText: (draftId: string, text: string) => state.draftTexts.set(draftId, text),
}));

import { AddProjectDestinationScreen, AddProjectLocalFolderScreen } from "./AddProjectScreen";

function findAction(node: ReactNode, label: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const action = findAction(child, label);
      if (action) return action;
    }
    return null;
  }
  if (!isValidElement<{ label?: string; onPress?: () => unknown; children?: ReactNode }>(node)) {
    return null;
  }
  if (node.props.label === label) return node.props.onPress ?? null;
  return findAction(node.props.children, label);
}

function cloneAction(prompt?: string) {
  const action = findAction(
    AddProjectDestinationScreen({
      environmentId: "environment",
      remoteUrl: "https://example.com/repo.git",
      repositoryName: "repo",
      ...(prompt ? { prompt } : {}),
    }),
    "Clone project",
  );
  if (!action) throw new Error("Clone action missing");
  return action;
}

describe("clone project permissions", () => {
  beforeEach(async () => {
    state.baseDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-clone-permissions-"),
    );
    state.scopes = new Set([AuthSourceControlWriteScope]);
    state.projects = [];
  });

  afterEach(async () => {
    await NodeFSP.rm(state.baseDirectory, { recursive: true, force: true });
  });

  it("does not leave a clone on disk when project creation is denied", async () => {
    await cloneAction()();

    expect(NodeFS.existsSync(NodePath.join(state.baseDirectory, "repo"))).toBe(false);
    expect(state.projects).toEqual([]);
  });

  it.each([AuthSourceControlWriteScope, AuthOrchestrationOperateScope])(
    "rechecks %s before a retained clone action creates a directory",
    async (scope) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      const submit = cloneAction();
      state.scopes.delete(scope);
      await submit();

      expect(NodeFS.existsSync(NodePath.join(state.baseDirectory, "repo"))).toBe(false);
      expect(state.projects).toEqual([]);
    },
  );
});

function addLocalFolderAction() {
  const action = findAction(
    AddProjectLocalFolderScreen({ environmentId: "environment" }),
    "Add project",
  );
  if (!action) throw new Error("Add project action missing");
  return action;
}

function openedDraft() {
  expect(state.navigations).toHaveLength(1);
  const { routes } = state.navigations[0] as {
    routes: Array<{ name: string; params: { draft: object } }>;
  };
  const route = routes.at(-1);
  expect(route?.name).toBe("Thread");
  return route?.params.draft;
}

describe("adding a destination that is already a project", () => {
  beforeEach(async () => {
    state.home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-existing-project-"));
    await NodeFSP.mkdir(NodePath.join(state.home, "work", "repo"), { recursive: true });
    state.scopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
    state.cloneTracking = false;
    state.projects = [];
    state.navigations = [];
    state.startedClones = [];
    state.draftTexts = new Map();
    state.existingProjects = [
      {
        environmentId: "environment",
        id: "existing",
        title: "repo",
        workspaceRoot: NodePath.join(state.home, "work", "repo"),
      },
    ];
  });

  afterEach(async () => {
    await NodeFSP.rm(state.home, { recursive: true, force: true });
  });

  it.each(["~/work/repo", "ABSOLUTE"])(
    "opens the existing project for local folder %s",
    async (baseDirectory) => {
      state.baseDirectory =
        baseDirectory === "ABSOLUTE" ? NodePath.join(state.home, "work", "repo") : baseDirectory;
      await addLocalFolderAction()();

      expect(state.projects).toEqual([]);
      expect(openedDraft()).toEqual({
        environmentId: "environment",
        projectId: "existing",
        title: "repo",
      });
    },
  );

  it("still adds the folder when only another environment has that path", async () => {
    state.baseDirectory = "~/work/repo";
    state.existingProjects = state.existingProjects.map((project) => ({
      ...project,
      environmentId: "other-environment",
    }));
    await addLocalFolderAction()();

    expect(state.projects).toEqual(["~/work/repo"]);
    expect(openedDraft()).toMatchObject({ projectId: "project" });
  });

  it("opens the existing project instead of cloning into it", async () => {
    state.baseDirectory = "~/work";
    await cloneAction()();

    expect(await NodeFSP.readdir(NodePath.join(state.home, "work", "repo"))).toEqual([]);
    expect(state.projects).toEqual([]);
    expect(openedDraft()).toMatchObject({ projectId: "existing" });
  });

  it("carries the prompt into the existing project instead of starting a tracked clone", async () => {
    state.baseDirectory = "~/work";
    state.cloneTracking = true;
    await cloneAction("Fix the flaky test")();

    expect(state.startedClones).toEqual([]);
    expect(openedDraft()).toMatchObject({ projectId: "existing", draftId: "draft" });
    expect(state.draftTexts.get("draft")).toBe("Fix the flaky test");
  });
});
