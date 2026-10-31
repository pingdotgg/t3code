import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Children, state, project } = vi.hoisted(() => ({
  project: {
    environmentId: "environment",
    id: "existing",
    title: "Existing project",
    workspaceRoot: "/work/existing",
  },
  Children: ({ children }: { children?: ReactNode }) => children,
  state: {
    connected: true,
    loading: false,
    paired: true,
    scratchSupported: true,
    reconnecting: false,
    focused: true,
    openScratch: vi.fn(),
    selectDetail: vi.fn(),
    setProject: vi.fn(),
    alert: vi.fn(),
  },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, View: Children, Pressable: Children }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    getState: () => ({
      routeNames: ["NewTaskProject"],
      index: 1,
      routes: [
        { name: "Thread", params: { draft: { projectId: "existing" } } },
        { name: "NewTaskProject" },
      ],
    }),
    isFocused: () => state.focused,
  }),
  useIsFocused: () => true,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/Dialog", () => ({ alert: state.alert }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/NavigationRow", () => ({ NavigationRow: () => null }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: ({ title }: { title: string }) => title }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({ ScreenContent: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({ Button: ({ label }: { label: string }) => label }));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/LoadingScreen", () => ({
  LoadingScreen: ({ message }: { message: string }) => message,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => (state.paired ? [project] : []),
  useServerConfigs: () =>
    new Map([["environment", state.scratchSupported ? { scratchWorkspaceRoot: "/scratch" } : {}]]),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { openScratch: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.openScratch }));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({
    state: {
      isLoadingConnections: state.loading,
      hasConnections: state.paired,
      hasReadyEnvironment: state.connected,
      hasConnectingEnvironment: state.loading || state.reconnecting,
      hasLoadedShellSnapshot: !state.loading,
      connectionState: state.connected ? "connected" : "available",
      connectionError: null,
    },
  }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: state.connected
      ? [{ environmentId: "environment", connectionState: "connected" }]
      : [],
  }),
}));
vi.mock("../prompt-links/usePromptLinkResolver", () => ({ usePromptLinkResolver: () => {} }));
vi.mock("../sharing/IncomingShareProvider", () => ({ useIncomingShare: () => ({}) }));
vi.mock("./new-task-flow-provider", () => ({
  useNewTaskFlow: () => ({
    projectScopes: state.paired
      ? [
          {
            key: "existing",
            title: project.title,
            representative: project,
            projects: [project],
            projectRefs: [{ environmentId: project.environmentId, projectId: project.id }],
          },
        ]
      : [],
    selectedEnvironmentId: "environment",
    setProject: state.setProject,
  }),
}));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => state.selectDetail,
}));

import { NewTaskRouteScreen } from "./NewTaskRouteScreen";

async function setup(
  options: {
    shortcut?: boolean;
    loading?: boolean;
    paired?: boolean;
    scratchSupported?: boolean;
    reconnecting?: boolean;
  } = {},
) {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.loading = options.loading ?? false;
  state.scratchSupported = options.scratchSupported ?? true;
  state.reconnecting = options.reconnecting ?? false;
  state.paired = options.paired ?? true;
  state.focused = true;
  state.connected = state.paired && !state.loading;
  const result =
    Promise.withResolvers<
      AsyncResult.AsyncResult<{ environmentId: EnvironmentId; id: ProjectId }, Error>
    >();
  state.openScratch.mockReturnValue(result.promise);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    act(async () => {
      root.render(
        <StrictMode>
          <NewTaskRouteScreen
            route={{
              params:
                options.shortcut === false
                  ? {}
                  : { startWithoutProject: true, requestId: "shortcut" },
            }}
          />
        </StrictMode>,
      );
    });
  await render();
  return {
    container,
    render,
    result,
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("opens the no-project workspace once and preserves the shortcut focus request", async () => {
  await using screen = await setup();
  expect(state.openScratch).toHaveBeenCalledTimes(1);
  expect(screen.container.textContent).not.toContain("Choose project");
  expect(state.setProject).not.toHaveBeenCalled();
  await act(async () =>
    screen.result.resolve(
      AsyncResult.success({
        environmentId: EnvironmentId.make("environment"),
        id: ProjectId.make("scratch"),
      }),
    ),
  );
  expect(state.selectDetail).toHaveBeenCalledExactlyOnceWith({
    name: "Thread",
    params: {
      draft: {
        requestId: "shortcut",
        environmentId: "environment",
        projectId: "scratch",
        incomingShareId: undefined,
      },
    },
  });
});

it("leaves navigation to a newer shortcut's picker when its no-project workspace opens", async () => {
  await using screen = await setup();
  state.focused = false;
  await act(async () =>
    screen.result.resolve(
      AsyncResult.success({
        environmentId: EnvironmentId.make("environment"),
        id: ProjectId.make("scratch"),
      }),
    ),
  );
  expect(state.selectDetail).not.toHaveBeenCalled();
  state.focused = true;
  await screen.render();
  expect(screen.container.textContent).not.toContain("Opening new task");
});

it("waits for cold-launch connections before opening the no-project workspace", async () => {
  await using screen = await setup({ loading: true });
  expect(state.openScratch).not.toHaveBeenCalled();
  expect(screen.container.textContent).not.toContain("Choose project");
  state.loading = false;
  state.connected = true;
  await screen.render();
  expect(state.openScratch).toHaveBeenCalledTimes(1);
});

it("keeps the existing add-environment flow on an unpaired device", async () => {
  await using screen = await setup({ paired: false });
  expect(state.openScratch).not.toHaveBeenCalled();
  expect(screen.container.textContent).toContain("No environments connected");
  expect(screen.container.textContent).toContain("Add environment");
});

it("keeps ordinary project selection manual", async () => {
  await using screen = await setup({ shortcut: false });
  expect(state.openScratch).not.toHaveBeenCalled();
  expect(screen.container.textContent).toContain("Choose project");
});

it("shows the existing recovery flow after a no-project request fails without retrying automatically", async () => {
  await using screen = await setup();
  await act(async () =>
    screen.result.resolve(AsyncResult.failure(Cause.fail(new Error("Server unavailable")))),
  );
  expect(state.alert).toHaveBeenCalledWith(
    "Could not start without a project",
    "Server unavailable",
  );
  expect(state.selectDetail).not.toHaveBeenCalled();
  expect(screen.container.textContent).toContain("Choose project");
  await screen.render();
  expect(state.openScratch).toHaveBeenCalledTimes(1);
});

it("does not wait forever for another environment when the connected server has no no-project workspace", async () => {
  await using screen = await setup({ scratchSupported: false, reconnecting: true });
  expect(state.openScratch).not.toHaveBeenCalled();
  expect(screen.container.textContent).toContain("Choose project");
  expect(screen.container.textContent).not.toContain("Opening new task");
});
