import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  otherScopes: new Set<string>(),
  baseDirectory: "",
  projects: [] as string[],
  createRequests: [] as { environmentId: string; workspaceRoot: string }[],
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Alert: { alert: () => {} },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: () => {} }),
  CommonActions: { reset: (input: unknown) => input },
  StackActions: {},
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: "EnvironmentMachineSymbol",
}));
vi.mock("../../components/ErrorBanner", () => ({ ErrorBanner: "ErrorBanner" }));
vi.mock("../../components/SourceControlIcon", () => ({ SourceControlIcon: "SourceControlIcon" }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "project" }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (environmentId: string, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.otherScopes).has(scope),
  readEnvironmentScope: (environmentId: string, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.otherScopes).has(scope),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useServerConfigs: () =>
    new Map([
      [
        "environment",
        {
          environment: { platform: { os: "linux" } },
          settings: { addProjectBaseDirectory: state.baseDirectory },
        },
      ],
      [
        "other-environment",
        {
          environment: { platform: { os: "linux" } },
          settings: { addProjectBaseDirectory: state.baseDirectory },
        },
      ],
    ]),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => ({ connectionState: "connected" }),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [
      { environmentId: "environment", connectionState: "connected" },
      { environmentId: "other-environment", connectionState: "connected" },
    ],
  }),
  useSavedRemoteConnections: () => ({
    savedConnectionsById: {
      connection: { environmentId: "environment", environmentLabel: "Environment" },
      other: { environmentId: "other-environment", environmentLabel: "Other environment" },
    },
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
    cloneRepository: async ({ input }: { input: { destinationPath: string } }) => {
      NodeFS.mkdirSync(input.destinationPath);
      return AsyncResult.success({ cwd: input.destinationPath });
    },
  },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    create: async ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { workspaceRoot: string };
    }) => {
      state.createRequests.push({ environmentId, workspaceRoot: input.workspaceRoot });
      const scopes = environmentId === "environment" ? state.scopes : state.otherScopes;
      if (!scopes.has(AuthOrchestrationOperateScope)) {
        return AsyncResult.failure(Cause.fail(new Error("Project creation denied")));
      }
      state.projects.push(input.workspaceRoot);
      return AsyncResult.success(undefined);
    },
  },
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

function cloneAction() {
  const action = findAction(
    AddProjectDestinationScreen({
      environmentId: "environment",
      remoteUrl: "https://example.com/repo.git",
      repositoryName: "repo",
    }),
    "Clone project",
  );
  if (!action) throw new Error("Clone action missing");
  return action;
}

function localProjectAction(environmentId = "environment") {
  const action = findAction(AddProjectLocalFolderScreen({ environmentId }), "Add project");
  if (!action) throw new Error("Add project action missing");
  return action;
}

describe("clone project permissions", () => {
  beforeEach(async () => {
    state.baseDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-clone-permissions-"),
    );
    state.scopes = new Set([AuthSourceControlWriteScope]);
    state.otherScopes = new Set();
    state.projects = [];
    state.createRequests = [];
  });

  afterEach(async () => {
    await NodeFSP.rm(state.baseDirectory, { recursive: true, force: true });
  });

  it("does not leave a clone on disk when project creation is denied", async () => {
    await cloneAction()();

    expect(NodeFS.existsSync(NodePath.join(state.baseDirectory, "repo"))).toBe(false);
    expect(state.projects).toEqual([]);
  });

  it("clones and registers the project when both permissions are granted", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    await cloneAction()();

    const destination = NodePath.join(state.baseDirectory, "repo");
    expect(NodeFS.existsSync(destination)).toBe(true);
    expect(state.projects).toEqual([destination]);
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

describe("local project permissions", () => {
  beforeEach(() => {
    state.baseDirectory = "/workspace/project";
    state.scopes = new Set();
    state.otherScopes = new Set();
    state.projects = [];
    state.createRequests = [];
  });

  it.each([false, true])(
    "does not dispatch project creation without the current grant (revoked: %s)",
    async (revokeBeforeSubmit) => {
      if (revokeBeforeSubmit) state.scopes.add(AuthOrchestrationOperateScope);
      const submit = localProjectAction();
      state.scopes.delete(AuthOrchestrationOperateScope);

      await submit();

      expect(state.createRequests).toEqual([]);
      expect(state.projects).toEqual([]);
    },
  );

  it("adds a typed local path with only task-operation permission", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);

    await localProjectAction()();

    expect(state.createRequests).toEqual([
      { environmentId: "environment", workspaceRoot: state.baseDirectory },
    ]);
    expect(state.projects).toEqual([state.baseDirectory]);
  });

  it("uses a grant added while the local-folder form is open", async () => {
    const submit = localProjectAction();
    state.scopes.add(AuthOrchestrationOperateScope);

    await submit();

    expect(state.projects).toEqual([state.baseDirectory]);
  });

  it.each([false, true])(
    "uses the selected environment's grant (allowed: %s)",
    async (allowSelectedEnvironment) => {
      (allowSelectedEnvironment ? state.otherScopes : state.scopes).add(
        AuthOrchestrationOperateScope,
      );

      await localProjectAction("other-environment")();

      expect(state.createRequests).toEqual(
        allowSelectedEnvironment
          ? [{ environmentId: "other-environment", workspaceRoot: state.baseDirectory }]
          : [],
      );
      expect(state.projects).toEqual(allowSelectedEnvironment ? [state.baseDirectory] : []);
    },
  );
});
