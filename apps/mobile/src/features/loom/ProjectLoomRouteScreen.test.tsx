import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type LoomLane,
  type LoomRun,
  type LoomWindow,
  type LoomWindowInput,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  window: null as LoomWindow | null,
  config: null as unknown,
  queries: [] as LoomWindowInput[],
  actions: [] as unknown[],
  urls: [] as string[],
  environments: [] as string[],
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children, style }: { children?: ReactNode; style?: { marginLeft?: number } }) => (
    <div style={style}>{children}</div>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    style,
    disabled,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
    style?: { marginLeft?: number };
    disabled?: boolean;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress} style={style} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
    ListEmptyComponent,
  }: {
    data: ReadonlyArray<{ key: string }>;
    renderItem: (input: { item: unknown }) => ReactNode;
    ListHeaderComponent: ReactNode;
    ListFooterComponent: ReactNode;
    ListEmptyComponent: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.length === 0
        ? ListEmptyComponent
        : data.map((item) => (
            <div key={item.key} data-item={item.key}>
              {renderItem({ item })}
            </div>
          ))}
      {ListFooterComponent}
    </div>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    goBack: () => {},
    addListener: () => () => {},
  }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => (detail: unknown) => state.actions.push(detail),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => <header>Loom</header> }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
vi.mock("../layout/workspace/ListFilterMenu", () => ({
  ListFilterMenu: ({
    accessibilityLabel,
    actions,
    onSelect,
  }: {
    accessibilityLabel: string;
    actions: Array<{ id: string; title: string }>;
    onSelect: (id: string) => void;
  }) => (
    <select aria-label={accessibilityLabel} onChange={(event) => onSelect(event.target.value)}>
      {actions.map((action) => (
        <option key={action.id} value={action.id}>
          {action.title}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => state.config,
  },
}));
vi.mock("../../state/entities", () => ({ useProject: () => ({ title: "Project" }) }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ presentationById: new Map(state.environments.map((id) => [id, {}])) }),
}));
vi.mock("../../state/projectLoom", () => ({
  projectLoom: {
    window: ({ input }: { input: LoomWindowInput }) => {
      state.queries.push(input);
      return state.window;
    },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (data: unknown) => ({
    data,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));
vi.mock("../../lib/openExternalUrl", () => ({
  tryOpenExternalUrl: async (url: string) => {
    state.urls.push(url);
    return true;
  },
}));

import { ProjectLoomRouteScreen } from "./ProjectLoomRouteScreen";

const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
const lane = (id: string, parent: string | null): LoomLane => ({
  threadId: ThreadId.make(id),
  title: id,
  parentThreadId: parent === null ? null : ThreadId.make(parent),
  relationship: parent === null ? "root" : "subagent",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
  branch: null,
  createdAt: at(20, 12),
  archivedAt: null,
});
const run = (id: string, thread: string, day: number, hour: number): LoomRun => ({
  id: RunId.make(id),
  threadId: ThreadId.make(thread),
  ordinal: 1,
  status: "completed",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
  userMessageId: MessageId.make(`message-${id}`),
  requestedAt: at(day, hour),
  startedAt: at(day, hour),
  completedAt: at(day, hour + 1),
});
function setup(
  prepare: (window: LoomWindow) => LoomWindow = (window) => window,
  environments: ReadonlyArray<string> = ["remote", "origin", "destination"],
) {
  state.environments = [...environments];
  const config = Atom.make({ environment: { capabilities: { projectLoom: true } } });
  const registry = AtomRegistry.make();
  state.config = config;
  state.actions.length = 0;
  state.queries.length = 0;
  state.urls.length = 0;
  state.window = prepare({
    projectId: ProjectId.make("project"),
    asOf: at(23, 12),
    from: at(19, 12),
    to: at(23, 12),
    lanes: [
      lane("root", null),
      lane("child", "root"),
      lane("grandchild", "child"),
      lane("older", null),
    ],
    ancestors: [],
    edges: [],
    runs: [
      run("root-run", "root", 22, 12),
      run("child-run", "child", 22, 14),
      run("grandchild-run", "grandchild", 22, 16),
      run("older-run", "older", 20, 12),
    ],
    markers: [
      {
        kind: "pull_request",
        id: "pr",
        threadId: ThreadId.make("child"),
        runId: null,
        at: at(22, 15),
        repository: "t3/t3code",
        number: 1,
        url: "https://github.com/t3/t3code/pull/1",
        source: "manual",
        title: null,
      },
    ],
    activity: [],
    truncated: {
      lanes: false,
      ancestors: false,
      runs: false,
      markers: false,
      edges: false,
      activity: false,
      bytes: false,
    },
    coverage: {
      untimedTasks: 2,
      untimedTasksTruncated: false,
      commandsScanned: 3,
      commandsTruncated: true,
    },
    nextCursor: null,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ProjectLoomRouteScreen
            route={{ params: { environmentId: "remote", projectId: "project" } }}
          />
        </RegistryContext.Provider>,
      ),
    );
  render();
  const press = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === label,
    );
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  };
  return {
    container,
    press,
    setSupported: (projectLoom: boolean) =>
      act(() => registry.set(config, { environment: { capabilities: { projectLoom } } })),
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      registry.dispose();
      vi.unstubAllGlobals();
    },
  };
}

it("groups dates, nests delegated activity, collapses descendants and navigates in the owning environment", async () => {
  using screen = setup();
  const rows = () => [...screen.container.querySelectorAll("[data-item]")];
  expect(rows().map((element) => element.getAttribute("data-item"))).toEqual([
    "date:2026-10-22",
    "2026-10-22:thread:root",
    "2026-10-22:run:root-run",
    "2026-10-22:thread:child",
    "2026-10-22:run:child-run",
    "2026-10-22:pull_request:pr",
    "2026-10-22:thread:grandchild",
    "2026-10-22:run:grandchild-run",
    "date:2026-10-20",
    "2026-10-20:thread:older",
    "2026-10-20:run:older-run",
  ]);
  expect(
    screen.container
      .querySelector('[data-item="2026-10-22:thread:child"] > div')
      ?.getAttribute("style"),
  ).toBe("margin-left: 16px;");
  expect(screen.container.textContent).toContain("2 agent tasks with no recorded time");
  expect(screen.container.textContent).toContain("test commands from the newest 3 commands only");
  await screen.press("Collapse root");
  expect(screen.container.textContent).toContain("2 hidden threads");
  expect(
    rows().some((element) => element.getAttribute("data-item")?.endsWith(":thread:child")),
  ).toBe(false);
  expect(
    rows().some((element) => element.getAttribute("data-item")?.endsWith(":run:child-run")),
  ).toBe(false);
  await screen.press("Expand root");
  await screen.press("Open thread child");
  await screen.press("Run 1 · completed");
  expect(state.actions).toEqual([
    { name: "Thread", params: { environmentId: "remote", threadId: "child" } },
    { name: "Thread", params: { environmentId: "remote", threadId: "root" } },
  ]);
  await screen.press("Pull request linked: #1");
  expect(state.urls).toEqual(["https://github.com/t3/t3code/pull/1"]);
  state.queries.length = 0;
  screen.setSupported(false);
  expect(screen.container.textContent).toContain("Update the server");
  expect(state.queries).toEqual([]);
});

const withRemoteTasks = (window: LoomWindow): LoomWindow => ({
  ...window,
  lanes: window.lanes.map((entry) =>
    entry.threadId === "root"
      ? {
          ...entry,
          relationship: "subagent",
          delegatedFrom: {
            environmentId: EnvironmentId.make("origin"),
            threadId: ThreadId.make("root"),
            title: "Remote parent",
          },
        }
      : entry,
  ),
  markers: [
    {
      kind: "subagent_task",
      id: NodeId.make("remote-task"),
      threadId: ThreadId.make("root"),
      runId: null,
      at: at(22, 13),
      completedAt: null,
      status: "running",
      title: "Build",
      remoteChild: {
        environmentId: EnvironmentId.make("destination"),
        threadId: ThreadId.make("root"),
        label: "Build server",
      },
    },
  ],
});

it("opens remote child and parent links with their own environment even when thread ids collide", async () => {
  using screen = setup(withRemoteTasks);
  await screen.press("Agent task on Build server: Build (running)");
  await screen.press("Open parent thread Remote parent on origin");
  expect(state.actions).toEqual([
    { name: "Thread", params: { environmentId: "destination", threadId: "root" } },
    { name: "Thread", params: { environmentId: "origin", threadId: "root" } },
  ]);
});

it("keeps remote links visible but cannot navigate to environments this client has not connected", () => {
  using screen = setup(withRemoteTasks, ["remote"]);
  const buttons = [...screen.container.querySelectorAll("button")];
  expect(
    buttons.find(
      (button) =>
        button.getAttribute("aria-label") === "Agent task on Build server: Build (running)",
    )?.disabled,
  ).toBe(true);
  expect(
    buttons.find(
      (button) =>
        button.getAttribute("aria-label") === "Open parent thread Remote parent on origin",
    )?.disabled,
  ).toBe(true);
  expect(screen.container.textContent).toContain("Connect to Build server to open this thread.");
  expect(screen.container.textContent).toContain("Connect to origin to open this parent.");
  expect(state.actions).toEqual([]);
});
