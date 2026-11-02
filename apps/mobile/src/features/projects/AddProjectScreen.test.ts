import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { workspaceDetailRouter } from "../workspace/workspace-detail-selection";
import type { NavigationState } from "@react-navigation/native";
import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, createElement, isValidElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  baseDirectory: "",
  projects: [] as string[],
  existingProjects: [] as {
    environmentId: string;
    id: string;
    title: string;
    workspaceRoot: string;
  }[],
  createResult: null as Promise<unknown> | null,
  createNewResult: null as Promise<unknown> | null,
  startCloneResult: null as Promise<unknown> | null,
  connectionStates: {} as Record<string, EnvironmentConnectionPhase>,
  newProjectsRoot: null as string | null,
  waitForProject: vi.fn(),
  dispatch: vi.fn(),
  alert: vi.fn(),
  navigationState: undefined as NavigationState | undefined,
  environments: [{ environmentId: "environment", environmentLabel: "Environment" }],
}));

function loadRouters() {
  const requireNavigation = NodeModule.createRequire(
    NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  return requireNavigation("@react-navigation/routers") as {
    StackRouter: typeof import("@react-navigation/native").StackRouter;
    StackActions: typeof import("@react-navigation/native").StackActions;
    CommonActions: typeof import("@react-navigation/native").CommonActions;
  };
}

vi.mock("../workspace/useSelectWorkspaceDetail", async () => {
  const { selectWorkspaceDetail } = await import("../workspace/workspace-detail-selection");
  return {
    useSelectWorkspaceDetail: () => (detail: Parameters<typeof selectWorkspaceDetail>[0]) =>
      state.dispatch(selectWorkspaceDetail(detail)),
  };
});
vi.mock("../../native/StackHeader", () => ({
  nativeHeaderScrollEdgeEffects: () => undefined,
}));
vi.mock("../../components/ui/NavigationRow", () => ({ NavigationRow: "NavigationRow" }));
vi.mock("../../components/ui/Button", () => ({ Button: "Button" }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: "ScrollView" }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: "SettingsScreen" }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: "Switch" }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ActivityIndicator: "ActivityIndicator",
  Alert: { alert: state.alert },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    dispatch: state.dispatch,
    getState: () =>
      state.navigationState ?? {
        index: 4,
        routes: [
          { key: "home", name: "Home" },
          { key: "draft", name: "Thread", params: { draft: {} } },
          { key: "picker", name: "NewTaskProject" },
          { key: "add", name: "AddProject" },
          { key: "local", name: "AddProjectLocal" },
        ],
      },
  }),
  CommonActions: { reset: (input: unknown) => input },
  StackActions: {
    push: (name: string, params: unknown) => ({ type: "PUSH", payload: { name, params } }),
  },
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
  waitForProject: state.waitForProject,
  useServerConfigs: () =>
    new Map([
      [
        "environment",
        {
          environment: { platform: { os: "linux" }, capabilities: {} },
          newProjectsRoot: state.newProjectsRoot,
          settings: { addProjectBaseDirectory: state.baseDirectory },
        },
      ],
    ]),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => ({ connectionState: "connected" }),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: state.environments.map((environment) => ({
      environmentId: environment.environmentId,
      connectionState: state.connectionStates[environment.environmentId] ?? "connected",
    })),
  }),
  useSavedRemoteConnections: () => ({
    savedConnectionsById: Object.fromEntries(
      state.environments.map((environment) => [environment.environmentId, environment]),
    ),
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => () => {} }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../../state/filesystem", () => ({ filesystemEnvironment: {} }));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    discovery: (input: unknown) => input,
    startProjectClone: async ({ input }: { input: { destinationPath: string } }) => {
      if (state.startCloneResult) return state.startCloneResult;
      NodeFS.mkdirSync(input.destinationPath);
      return AsyncResult.success(undefined);
    },
  },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    createNew: () => state.createNewResult,
    create: ({ input }: { input: { workspaceRoot: string } }) => {
      if (!state.scopes.has(AuthOrchestrationOperateScope)) {
        return Promise.resolve(
          AsyncResult.failure(Cause.fail(new Error("Project creation denied"))),
        );
      }
      state.projects.push(input.workspaceRoot);
      return state.createResult ?? Promise.resolve(AsyncResult.success(undefined));
    },
  },
}));

vi.mock("../../state/use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: async () => {},
  createNewTaskDraft: () => "prompt-draft",
  setComposerDraftText: () => {},
}));

import {
  AddProjectNewScreen,
  AddProjectDestinationScreen,
  AddProjectLocalFolderScreen,
  AddProjectSourceScreen,
} from "./AddProjectScreen";
import { AddProjectSourceRoute } from "./AddProjectSourceRoute";

function findAction(
  node: ReactNode,
  label: string,
  includeDisabled = false,
): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const action = findAction(child, label, includeDisabled);
      if (action) return action;
    }
    return null;
  }
  if (
    !isValidElement<{
      label?: string;
      title?: string;
      onPress?: () => unknown;
      disabled?: boolean;
      children?: ReactNode;
    }>(node)
  ) {
    return null;
  }
  if ((node.props.label ?? node.props.title) === label) {
    return node.props.disabled && !includeDisabled ? null : (node.props.onPress ?? null);
  }
  return findAction(node.props.children, label, includeDisabled);
}

const mountedRoots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
});
function renderScreen(render: () => ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  mountedRoots.push(root);
  let screen: ReactNode;
  function Observer() {
    screen = render();
    return null;
  }
  act(() => root.render(createElement(Observer)));
  return screen;
}

function cloneAction() {
  const action = findAction(
    renderScreen(() =>
      AddProjectDestinationScreen({
        environmentId: "environment",
        remoteUrl: "https://example.com/repo.git",
        repositoryName: "repo",
      }),
    ),
    "Clone project",
    true,
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
    state.createResult = null;
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

function mountProjectFlow(
  withDraft: boolean,
  withChooser = true,
  withPullRequest = false,
  screenName = "AddProjectLocal",
) {
  const { StackRouter, StackActions, CommonActions } = loadRouters();
  const base = StackRouter({});
  const router = { ...base, ...workspaceDetailRouter(base) };
  const options = {
    routeNames: [
      "Home",
      "Thread",
      "PullRequest",
      "PullRequestFile",
      "NewTaskProject",
      "AddProject",
      "AddProjectLocal",
      "AddProjectNew",
      "AddProjectDestination",
    ],
    routeParamList: {},
    routeGetIdList: {},
  };
  let current = router.getInitialState(options);
  const home = current.routes[0]!;
  const apply = (action: Parameters<typeof router.getStateForAction>[1]) => {
    const next = router.getStateForAction(current, action, options);
    if (!next || next.stale !== false) throw new Error("Navigation action rejected");
    current = next;
    state.navigationState = current;
  };
  if (withPullRequest) {
    apply(StackActions.push("PullRequest", { number: 123 }));
    apply(StackActions.push("PullRequestFile", { path: "file.ts" }));
  }
  const underlyingRoutes = current.routes;
  if (withDraft) {
    apply(StackActions.push("Thread", { draft: { projectId: "previous-project" } }));
  }
  const draftKey = withDraft ? current.routes[current.index]!.key : null;
  for (const name of [...(withChooser ? ["NewTaskProject"] : []), "AddProject", screenName]) {
    apply(StackActions.push(name));
  }
  state.navigationState = current;
  state.dispatch.mockImplementation((action) =>
    apply(
      action.type === "PUSH" || action.type === "SELECT_WORKSPACE_DETAIL"
        ? action
        : CommonActions.reset(action),
    ),
  );
  return {
    home,
    draftKey,
    underlyingRoutes,
    flowRoutes: current.routes.slice(underlyingRoutes.length),
    getState: () => current,
    back: () => apply(StackActions.pop()),
    setParams: (params: object) => apply(CommonActions.setParams(params)),
    push: (name: string) => apply(StackActions.push(name)),
  };
}

describe("add project source environment", () => {
  it("blocks local add on a requested unavailable host until reconnect or manual choice", async () => {
    state.scopes = new Set([AuthOrchestrationOperateScope]);
    state.dispatch.mockReset();
    state.environments = [
      { environmentId: "environment", environmentLabel: "Environment" },
      { environmentId: "another-environment", environmentLabel: "Another environment" },
    ];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    let screen: ReactNode;
    function SourceObserver() {
      screen = AddProjectSourceScreen({ environmentId: "environment" });
      return null;
    }
    try {
      for (const phase of ["available", "offline", "error"] as const) {
        state.connectionStates = { environment: phase };
        await act(() => root.render(createElement(SourceObserver)));
        expect(findAction(screen, "Local folder")).toBeNull();
        expect(state.dispatch).not.toHaveBeenCalled();
      }
      state.connectionStates = {};
      await act(() => root.render(createElement(SourceObserver)));
      const reconnectedLocal = findAction(screen, "Local folder");
      if (!reconnectedLocal) throw new Error("Reconnected local folder action missing");
      reconnectedLocal();
      expect(state.dispatch).toHaveBeenLastCalledWith({
        type: "PUSH",
        payload: { name: "AddProjectLocal", params: { environmentId: "environment" } },
      });
      state.connectionStates = { environment: "offline" };
      await act(() => root.render(createElement(SourceObserver)));
      expect(findAction(screen, "Local folder")).toBeNull();
      const select = findAction(screen, "Another environment");
      if (!select) throw new Error("Connected environment selection missing");
      await act(() => select());
      const local = findAction(screen, "Local folder");
      if (!local) throw new Error("Manually selected local folder action missing");
      local();
      expect(state.dispatch).toHaveBeenLastCalledWith({
        type: "PUSH",
        payload: { name: "AddProjectLocal", params: { environmentId: "another-environment" } },
      });
    } finally {
      await act(() => root.unmount());
      state.connectionStates = {};
      state.environments = [{ environmentId: "environment", environmentLabel: "Environment" }];
    }
  });

  it("keeps a manual host selection when the requested host finishes connecting", async () => {
    state.scopes = new Set([AuthOrchestrationOperateScope]);
    state.dispatch.mockReset();
    const navigation = mountProjectFlow(false, true, false, "AddProject");
    state.environments = [
      { environmentId: "environment", environmentLabel: "Environment" },
      { environmentId: "another-environment", environmentLabel: "Another environment" },
    ];
    state.connectionStates = { environment: "connecting" };
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    let screen: ReactNode;
    function SourceObserver() {
      screen = AddProjectSourceScreen({ environmentId: "environment" });
      return null;
    }
    try {
      await act(() => root.render(createElement(SourceObserver)));
      expect(findAction(screen, "Local folder")).toBeNull();
      expect(navigation.getState().routes.at(-1)?.name).toBe("AddProject");
      const select = findAction(screen, "Another environment");
      if (!select) throw new Error("Connected environment selection missing");
      await act(() => select());
      state.connectionStates = {};
      await act(() => root.render(createElement(SourceObserver)));
      const local = findAction(screen, "Local folder");
      if (!local) throw new Error("Local folder action missing");
      local();
      expect(navigation.getState().routes.at(-1)).toMatchObject({
        name: "AddProjectLocal",
        params: { environmentId: "another-environment" },
      });
    } finally {
      await act(() => root.unmount());
      state.connectionStates = {};
      state.environments = [{ environmentId: "environment", environmentLabel: "Environment" }];
    }
  });

  it("follows warm environment requests while preserving manual selection between requests", async () => {
    state.scopes = new Set([AuthOrchestrationOperateScope]);
    state.dispatch.mockReset();
    const navigation = mountProjectFlow(false, true, false, "AddProject");
    state.environments = [
      { environmentId: "environment", environmentLabel: "Environment" },
      { environmentId: "another-environment", environmentLabel: "Another environment" },
    ];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    let actions: { local: () => unknown; selectEnvironment: () => unknown } | undefined;
    function SourceRouteObserver(props: { environmentId?: string | string[] }) {
      const route = AddProjectSourceRoute({ route: { params: props } });
      const screen = AddProjectSourceScreen(route.props);
      const local = findAction(screen, "Local folder");
      const selectEnvironment = findAction(screen, "Environment");
      if (!local || !selectEnvironment) throw new Error("Source actions missing");
      actions = { local, selectEnvironment };
      return null;
    }
    const openLocalFolder = (environmentId: string) => {
      state.dispatch.mockClear();
      actions!.local();
      expect(navigation.getState().routes.at(-1)).toMatchObject({
        name: "AddProjectLocal",
        params: { environmentId },
      });
      navigation.back();
    };
    try {
      await act(() =>
        root.render(createElement(SourceRouteObserver, { environmentId: "environment" })),
      );
      openLocalFolder("environment");
      await act(() =>
        root.render(createElement(SourceRouteObserver, { environmentId: "another-environment" })),
      );
      openLocalFolder("another-environment");
      await act(() => actions!.selectEnvironment());
      await act(() =>
        root.render(createElement(SourceRouteObserver, { environmentId: ["another-environment"] })),
      );
      openLocalFolder("environment");
      await act(() =>
        root.render(createElement(SourceRouteObserver, { environmentId: "environment" })),
      );
      await act(() =>
        root.render(createElement(SourceRouteObserver, { environmentId: "another-environment" })),
      );
      openLocalFolder("another-environment");
    } finally {
      await act(() => root.unmount());
      state.environments = [{ environmentId: "environment", environmentLabel: "Environment" }];
    }
  });
});

describe("local project navigation", () => {
  function setup() {
    state.navigationState = undefined;
    state.scopes = new Set([AuthOrchestrationOperateScope]);
    state.baseDirectory = "/tmp/t3-mobile-audit-fixture";
    state.projects = [];
    state.dispatch.mockReset();
    state.alert.mockReset();
    state.waitForProject.mockReset();
    const created = Promise.withResolvers<ReturnType<typeof AsyncResult.success<void>>>();
    const projected = Promise.withResolvers<unknown>();
    state.createResult = created.promise;
    state.waitForProject.mockReturnValue(projected.promise);
    const submit = findAction(
      renderScreen(() => AddProjectLocalFolderScreen({ environmentId: "environment" })),
      "Add project",
    );
    if (!submit) throw new Error("Add project action missing");
    return { created, projected, submit };
  }

  it("keeps navigation in place and explains a project projection timeout", async () => {
    const { created, projected, submit } = setup();
    const submission = submit();
    created.resolve(AsyncResult.success(undefined));
    projected.resolve(null);
    await submission;

    expect(state.projects).toEqual(["/tmp/t3-mobile-audit-fixture"]);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.alert).toHaveBeenCalledExactlyOnceWith(
      "Project added",
      "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.",
    );
  });

  it("does not replace a reopened flow when the previous submission finishes", async () => {
    const { created, projected, submit } = setup();
    const navigation = mountProjectFlow(false);
    const submission = submit();
    created.resolve(AsyncResult.success(undefined));
    await created.promise;
    navigation.back();
    navigation.push("AddProjectLocal");
    const remaining = navigation.getState();
    projected.resolve({ environmentId: "environment", id: "project" });
    await submission;

    expect(state.projects).toEqual(["/tmp/t3-mobile-audit-fixture"]);
    expect(navigation.getState()).toEqual(remaining);
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("does not replace a warm-linked flow sharing the original route key", async () => {
    const { created, projected, submit } = setup();
    const navigation = mountProjectFlow(false);
    const submission = submit();
    created.resolve(AsyncResult.success(undefined));
    await created.promise;
    const originalKey = navigation.getState().routes.at(-1)!.key;
    navigation.setParams({ environmentId: "other-environment" });
    const remaining = navigation.getState();
    expect(remaining.routes.at(-1)!.key).toBe(originalKey);
    projected.resolve({ environmentId: "environment", id: "project" });
    await submission;

    expect(navigation.getState()).toEqual(remaining);
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("does not redirect a reopened flow when an earlier new project finishes", async () => {
    const { projected } = setup();
    state.newProjectsRoot = "/projects";
    const created = Promise.withResolvers<unknown>();
    const waitingForProject = Promise.withResolvers<void>();
    state.createNewResult = created.promise;
    state.waitForProject.mockImplementation(() => {
      waitingForProject.resolve();
      return projected.promise;
    });
    const navigation = mountProjectFlow(false, true, true, "AddProjectNew");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    let screen: ReactNode;
    function NewProjectObserver() {
      screen = AddProjectNewScreen({ environmentId: "environment" });
      return null;
    }
    function enterName(node: ReactNode): boolean {
      if (Array.isArray(node)) return node.some(enterName);
      if (
        !isValidElement<{
          placeholder?: string;
          onChangeText?: (text: string) => void;
          children?: ReactNode;
        }>(node)
      )
        return false;
      if (node.props.placeholder === "Project name") {
        node.props.onChangeText!("new-project");
        return true;
      }
      return enterName(node.props.children);
    }
    try {
      await act(() => root.render(createElement(NewProjectObserver)));
      await act(() => {
        expect(enterName(screen)).toBe(true);
      });
      const submit = findAction(screen, "Create project");
      if (!submit) throw new Error("Create project action missing");
      await act(async () => {
        submit();
        created.resolve(
          AsyncResult.success({
            projectId: "project",
            workspaceRoot: "/projects/new-project",
          }),
        );
        await waitingForProject.promise;
      });
      navigation.back();
      navigation.push("AddProjectNew");
      const remaining = navigation.getState();
      await act(async () => {
        projected.resolve({ environmentId: "environment", id: "project" });
        await projected.promise;
      });

      expect(navigation.getState()).toEqual(remaining);
      expect(state.dispatch).not.toHaveBeenCalled();
    } finally {
      await act(() => root.unmount());
      state.newProjectsRoot = null;
      state.createNewResult = null;
    }
  });

  it.each([
    { origin: "Thread", withDraft: true, withChooser: true },
    { origin: "NewTaskProject", withDraft: false, withChooser: true },
    { origin: "AddProject", withDraft: false, withChooser: false },
  ])(
    "waits for projection then selects the draft from $origin",
    async ({ withDraft, withChooser }) => {
      const { created, projected, submit } = setup();
      const navigation = mountProjectFlow(withDraft, withChooser, true);
      const before = navigation.getState();
      const submission = submit();
      created.resolve(AsyncResult.success(undefined));
      await created.promise;
      expect(state.projects).toEqual(["/tmp/t3-mobile-audit-fixture"]);
      expect(navigation.getState()).toBe(before);
      projected.resolve({ environmentId: "environment", id: "project" });
      await submission;
      expect(state.dispatch).toHaveBeenCalledTimes(1);
      expect(navigation.getState().routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
      expect(navigation.getState().routes[1]?.params).toEqual({
        draft: {
          environmentId: "environment",
          projectId: "project",
          title: "t3-mobile-audit-fixture",
        },
      });
      navigation.back();
      expect(navigation.getState().routes).toEqual([navigation.home]);
    },
  );
});

describe("local folder path", () => {
  function findPathInput(
    node: ReactNode,
  ): { value: string; onChangeText: (value: string) => void } | null {
    if (Array.isArray(node)) {
      for (const child of node) {
        const input = findPathInput(child);
        if (input) return input;
      }
      return null;
    }
    if (
      !isValidElement<{
        value?: string;
        onChangeText?: (value: string) => void;
        onSubmit?: () => void;
        children?: ReactNode;
      }>(node)
    ) {
      return null;
    }
    const { value, onChangeText, onSubmit } = node.props;
    if (typeof value === "string" && onChangeText && onSubmit) return { value, onChangeText };
    return findPathInput(node.props.children);
  }

  function mountLocalFolder() {
    state.scopes = new Set([AuthOrchestrationOperateScope]);
    state.baseDirectory = "/work";
    state.connectionStates = {};
    state.environments = [
      { environmentId: "environment", environmentLabel: "Environment" },
      { environmentId: "another-environment", environmentLabel: "Another environment" },
    ];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    const renderedPaths: string[] = [];
    let input: ReturnType<typeof findPathInput> = null;
    function LocalFolderObserver(props: { environmentId?: string }) {
      input = findPathInput(AddProjectLocalFolderScreen(props));
      if (input) renderedPaths.push(input.value);
      return null;
    }
    return {
      renderedPaths,
      get path() {
        return input?.value;
      },
      type: (value: string) => act(() => input!.onChangeText(value)),
      render: (environmentId?: string) =>
        act(() => root.render(createElement(LocalFolderObserver, { environmentId }))),
      [Symbol.asyncDispose]: async () => {
        await act(() => root.unmount());
        state.connectionStates = {};
        state.environments = [{ environmentId: "environment", environmentLabel: "Environment" }];
      },
    };
  }

  it("shows the new host's default path on the first render after the host changes", async () => {
    await using screen = mountLocalFolder();
    await screen.render("environment");
    await screen.type("/work/edited");
    screen.renderedPaths.length = 0;

    await screen.render("another-environment");

    expect(screen.renderedPaths).not.toContain("/work/edited");
    expect(screen.path).toBe("~/");
  });

  it("keeps each host's typed path when switching between hosts", async () => {
    await using screen = mountLocalFolder();
    await screen.render("environment");
    await screen.type("/work/a");
    await screen.render("another-environment");
    await screen.type("~/b");

    await screen.render("environment");
    expect(screen.path).toBe("/work/a");
    await screen.render("another-environment");
    expect(screen.path).toBe("~/b");
  });

  it("keeps a typed path when the default host drops out and comes back", async () => {
    await using screen = mountLocalFolder();
    await screen.render();
    expect(screen.path).toBe("~/");
    await screen.type("~/code/app");

    state.connectionStates = { "another-environment": "offline" };
    await screen.render();
    expect(screen.path).toBe("/work/");

    state.connectionStates = {};
    await screen.render();
    expect(screen.path).toBe("~/code/app");
  });
});
