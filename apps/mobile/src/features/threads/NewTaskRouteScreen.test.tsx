import type { ReactNode } from "react";
import { act } from "react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import * as navigationRow from "../../components/ui/NavigationRow";
import { retargetSavedNewTaskDraft } from "../../state/use-composer-drafts";

const environmentId = EnvironmentId.make("env-1");

function project(id: string, workspaceRoot: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: "worktree",
    scripts: [],
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
  };
}

const regular = project("app", "/repo/app");
const scratch = project("scratch", "/scratch");

const harness = vi.hoisted(() => ({
  setProject: vi.fn(),
  openScratch: vi.fn(),
  selectDetail: vi.fn(),
  navigation: {
    goBack: vi.fn(),
    getState: () => ({
      routeNames: ["Thread", "NewTaskProject"],
      index: 1,
      routes: [{ name: "Thread", params: { draft: {} } }, { name: "NewTaskProject" }],
    }),
    getParent: () => undefined,
    canGoBack: () => true,
    dispatch: vi.fn(),
    navigate: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    accessibilityLabel: string;
    disabled?: boolean;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("gt-react-native", () => ({
  msg: (text: string) => text,
  T: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useGT: () => (text: string) => text,
  useMessages: () => (text: string) => text,
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: (name: string) => ({ type: "PUSH", name }) },
  useFocusEffect: (effect: () => () => void) => React.useEffect(effect, [effect]),
  useIsFocused: () => true,
  useNavigation: () => harness.navigation,
}));
vi.mock("../../components/ui/NavigationRow", () => ({ NavigationRow: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../connection/environmentStatusText", () => ({ runtimeConnectionErrorText: () => null }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [regular, scratch],
  useServerConfigs: () => new Map([[environmentId, { scratchWorkspaceRoot: "/scratch" }]]),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { openScratch: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.openScratch }));
vi.mock("../../state/use-composer-drafts", () => ({ retargetSavedNewTaskDraft: vi.fn() }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [{ environmentId, connectionState: "connected" }],
  }),
}));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ state: { hasReadyEnvironment: true } }),
}));
vi.mock("../sharing/IncomingShareProvider", () => ({
  useIncomingShare: () => ({ getShare: () => null, releaseShareReservation: vi.fn() }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => harness.selectDetail,
}));
vi.mock("./new-task-flow-provider", () => ({
  useNewTaskFlow: () => ({
    projectScopes: [
      {
        key: "app",
        title: "app",
        representative: regular,
        projects: [regular],
        projectRefs: [],
        pinned: false,
        archived: false,
      },
    ],
    selectedEnvironmentId: environmentId,
    setProject: harness.setProject,
  }),
}));

import { NewTaskRouteScreen } from "./NewTaskRouteScreen";

vi.spyOn(navigationRow, "NavigationRow").mockImplementation(({ title, disabled, onPress }) => (
  <button aria-label={title} disabled={disabled === true} onClick={() => onPress?.({} as never)}>
    {title}
  </button>
));

it("keeps the project picked while No project was still opening", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const opening = Promise.withResolvers<unknown>();
  harness.openScratch.mockReturnValue(opening.promise);

  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
  const row = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

  act(() => row("No project").click());
  await act(async () => row("app").click());
  await act(async () => opening.resolve({ _tag: "Success", value: scratch }));

  expect(harness.setProject.mock.calls).toEqual([[regular]]);
  expect(harness.navigation.goBack).toHaveBeenCalledTimes(1);
});

it.each(["backing out and reopening", "waiting for the saved draft to load"])(
  "keeps the picked project after %s while No project is pending",
  async (scenario) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const opening = Promise.withResolvers<unknown>();
    const retargeting = Promise.withResolvers<boolean>();
    harness.openScratch.mockReturnValue(opening.promise);
    vi.mocked(retargetSavedNewTaskDraft)
      .mockReset()
      .mockImplementation((_draftId, target) =>
        target.projectId === scratch.id ? retargeting.promise : Promise.resolve(true),
      );
    harness.selectDetail.mockClear();

    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    const route = { params: { draftId: "existing-draft" } } as never;
    const row = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    act(() => root.render(<NewTaskRouteScreen key="first" route={route} />));

    act(() => row("No project").click());
    if (scenario === "backing out and reopening") {
      act(() => root.render(null));
      act(() => root.render(<NewTaskRouteScreen key="second" route={route} />));
    } else {
      await act(async () => opening.resolve({ _tag: "Success", value: scratch }));
    }
    await act(async () => row("app").click());
    await act(async () => {
      opening.resolve({ _tag: "Success", value: scratch });
      retargeting.resolve(true);
    });

    expect(harness.selectDetail.mock.calls).toEqual([
      [
        {
          name: "Thread",
          params: { draft: { environmentId, projectId: regular.id, draftId: "existing-draft" } },
        },
      ],
    ]);
  },
);
