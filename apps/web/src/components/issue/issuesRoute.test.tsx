// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  IssueTrackerKind,
  IssueListResult,
  WS_METHODS,
  ProjectId,
  type IssueListEntry,
  type IssueListInput,
  type IssueCapabilities,
} from "@t3tools/contracts";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  responses: new Map<string, AsyncResult.AsyncResult<IssueListResult, unknown>>(),
  read: vi.fn(),
  listPage: vi.fn(),
  detailRead: vi.fn(),
  write: vi.fn(),
  prRead: vi.fn(),
  projectsKnown: true,
  search: { who: "all", status: "open" } as IssuesSearch,
  projects: [] as ReadonlyArray<ReturnType<typeof project>>,
  navigate: vi.fn(),
  environments: ["environment-a", "environment-b"].map((environmentId) => ({
    environmentId,
    label: environmentId,
    serverConfig: { environment: { capabilities: { issues: true, pullRequests: true } } } as {
      environment: { capabilities: { issues: boolean; pullRequests?: boolean } };
    } | null,
  })),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: object) => ({ options, useSearch: () => state.search }),
  useNavigate: () => state.navigate,
}));
vi.mock("~/connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
vi.mock("@t3tools/client-runtime/state/issues", async (importOriginal) => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const queries = Atom.family((key: string) =>
    Atom.make(() => {
      const { environmentId, input } = JSON.parse(key);
      state.read(environmentId, input);
      return state.responses.get(environmentId) ?? AsyncResult.initial(true);
    }).pipe(Atom.keepAlive),
  );
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/state/issues")>()),
    createIssueEnvironmentAtoms: () => ({
      list: (target: unknown) => queries(JSON.stringify(target)),
    }),
  };
});
vi.mock("~/state/entities", () => ({
  useProjects: () => state.projects,
  useAllEnvironmentShellsBootstrapped: () => state.projectsKnown,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  useIssuesSupported: () => true,
}));
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return {
    primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS),
    environmentServerConfigsAtom: Atom.make(new Map()),
  };
});
vi.mock("~/state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.listPage }));
vi.mock("~/hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("~/hooks/useNavigateBack", () => ({ useEscapeToGoBack: () => {} }));
vi.mock("~/panelAnimations", () => ({
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
  usePanelPresence: (present: boolean, value: unknown) => ({ present, value }),
}));
vi.mock("~/components/ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("~/components/WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("~/components/chat/PanelLayoutControls", () => ({ PanelLayoutControls: () => null }));
vi.mock("~/components/RightPanelTabs", () => ({
  RightPanelTabs: ({
    children,
    surfaces,
    onActivate,
  }: ComponentProps<typeof import("~/components/RightPanelTabs").RightPanelTabs>) => (
    <aside aria-label="Issue details">
      {surfaces.map((surface) => (
        <button
          key={surface.id}
          aria-label={`Tab ${surface.id}`}
          onClick={() => onActivate(surface)}
        >
          Select tab
        </button>
      ))}
      {children}
    </aside>
  ),
}));
vi.mock("~/components/issue/IssueDetailPanel", () => ({
  IssueDetailPanel: ({
    environmentId,
    reference,
    onSelectPullRequest,
  }: ComponentProps<typeof import("./IssueDetailPanel").IssueDetailPanel>) => {
    state.detailRead(environmentId, reference);
    return (
      <>
        <button onClick={() => state.write(environmentId, reference)}>Save issue</button>
        <button
          onClick={() =>
            onSelectPullRequest?.({
              projectId: reference.projectId,
              host: "github.com",
              repository: "org/repo",
              number: 42,
              url: "https://github.com/org/repo/pull/42",
            })
          }
        >
          Linked PR
        </button>
      </>
    );
  },
}));
vi.mock("~/components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: ({
    environmentId,
    reference,
  }: ComponentProps<
    typeof import("../pullRequest/PullRequestDetailPanel").PullRequestDetailPanel
  >) => {
    state.prRead(environmentId, reference);
    return <p>PR on {environmentId}</p>;
  },
}));
vi.mock("~/components/issue/IssueCreateDialog", () => ({ IssueCreateDialog: () => null }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ISSUES_PANEL_REF,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { issueEnvironment } from "~/state/issues";
import { Route, type IssuesSearch } from "../../routes/_chat.issues";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const project = (id: string) => ({
  id: ProjectId.make(id),
  environmentId: environmentA,
  title: `Project ${id}`,
  workspaceRoot: `/work/${id}`,
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
});
const issue = (key: string): IssueListEntry => ({
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key,
  displayKey: `#${key}`,
  title: `Issue ${key}`,
  url: `https://github.com/org/repo/issues/${key}`,
  author: null,
  state: { category: "open", name: "open" },
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  labels: [],
  assignees: [],
  commentCount: 0,
  closedAt: null,
});
const answer = (entries: ReadonlyArray<IssueListEntry>): IssueListResult => ({
  entries,
  viewers: {},
  trackers: [
    {
      tracker: IssueTrackerKind.make("github"),
      host: "github.com",
      projectCount: 1,
      configured: true,
      detail: null,
      capabilities: null,
    },
  ],
  nextCursors: {},
  errors: [],
});

it.each([undefined, "Account/B"])(
  "keeps equal display names separate by native identity (account=%s)",
  async (connectionId) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const account = connectionId === undefined ? {} : { connectionId };
    const base = answer([
      {
        ...issue("1"),
        ...account,
        labels: ["W", "T"].map((id) => ({ id, name: "Bug", color: null })),
        assignees: ["a1", "a2"].map((id) => ({ id, login: "Sam", name: null, avatarUrl: null })),
      },
    ]);
    try {
      state.responses.set(
        environmentA,
        AsyncResult.success(
          decodeIssueList({
            ...base,
            trackers: base.trackers.map((tracker) => ({ ...tracker, ...account })),
            errors: ["one", "two"].map((projectId) => ({
              ...account,
              projectId,
              projectTitle: "Project",
              tracker: "github",
              host: "github.com",
              message: `${projectId} failed`,
            })),
          }),
        ),
      );
      state.responses.set(environmentB, AsyncResult.success(answer([])));
      await mount();
      expect(text()).toContain("Project: one failed");
      expect(text()).toContain("Project: two failed");
      expect(error.mock.calls.flat().join(" ")).not.toContain("same key");
    } finally {
      error.mockRestore();
    }
  },
);

let intersections: Array<{ element: Element; intersect: () => void }>;
async function intersect(section = 0) {
  const group = container.querySelectorAll("section")[section]!;
  const observer = intersections.findLast(({ element }) => group.contains(element));
  expect(observer).toBeDefined();
  await act(async () => observer!.intersect());
}
let root: Root;
let container: HTMLDivElement;
const text = () => container.textContent;
const retry = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Retry",
  );
async function refresh() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh issues"]')!.click(),
  );
}
const Page = Route.options.component!;
await Page.preload?.();

it("keeps equal issue IDs on different accounts in separate rows, tabs and continuations", async () => {
  const a = { ...issue("1"), connectionId: "A", title: "Account A issue" };
  const b = { ...a, connectionId: "B", title: "Account B issue" };
  const aCursor = "@A github github.com org/repo";
  const bCursor = "@B github github.com org/repo";
  const base = answer([a, b]);
  const initial = {
    ...base,
    trackers: ["A", "B"].map((connectionId) => ({ ...base.trackers[0]!, connectionId })),
  };
  const native = decodeIssueList({ ...initial, nextCursors: { [aCursor]: "2", [bCursor]: "3" } });
  state.responses.set(environmentA, AsyncResult.success(native));
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  state.listPage.mockResolvedValue({
    _tag: "Success",
    value: decodeIssueList({
      ...initial,
      entries: [{ ...b, key: "2", title: "B tail" }],
      nextCursors: {},
    }),
  });
  await mount();
  expect(text()).toContain(a.title);
  expect(text()).toContain(b.title);
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
  await act(async () =>
    buttons()
      .find((button) => button.textContent?.includes(b.title))!
      .click(),
  );
  expect(state.search.selectedConnectionId).toBe("B");
  await intersect(1);
  expect(state.listPage).toHaveBeenCalledExactlyOnceWith({
    environmentId: environmentA,
    input: expect.objectContaining({ connectionId: "B", cursors: { [bCursor]: "3" } }),
  });
  expect(text()).toContain(a.title);
  expect(text()).toContain("B tail");
  await mount();
  const surfaces = Object.values(useRightPanelStore.getState().byThreadKey).flatMap(
    (state) => state.surfaces,
  );
  expect(surfaces).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "issue", connectionId: "B" })]),
  );
});

async function mount() {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <Page />
      </RegistryContext.Provider>,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  intersections = [];
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(element: Element) {
        intersections.push({
          element,
          intersect: () =>
            this.callback(
              [{ isIntersecting: true, target: element } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            ),
        });
      }
      disconnect() {}
      unobserve() {}
    },
  );
  localStorage.clear();
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  state.responses.clear();
  state.read.mockClear();
  state.listPage.mockReset();
  state.detailRead.mockClear();
  state.write.mockClear();
  state.prRead.mockClear();
  state.projectsKnown = true;
  state.projects = [];
  state.search = { who: "all", status: "open" };
  state.navigate.mockReset().mockImplementation(({ search }) => {
    state.search = search(state.search);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

const linkedSelection = {
  selectedProjectId: ProjectId.make("project"),
  selectedHost: "github.com",
  selectedConnectionId: "Account/B",
  tracker: "github",
  scope: "org/repo",
  key: "42",
};

it.each([true, false, null])(
  "refuses an ambiguous issue owner despite capability and order changes (B=%s)",
  async (supported) => {
    const original = state.environments;
    state.projects = [project("project"), { ...project("project"), environmentId: environmentB }];
    state.search = { ...state.search, ...linkedSelection };
    useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, {
      environmentId: environmentA,
      projectId: "project",
      tracker: "github",
      host: "github.com",
      connectionId: "Account/B",
      scope: "org/repo",
      key: "42",
    });
    state.environments = original.map((environment, index) =>
      index === 0
        ? environment
        : {
            ...environment,
            serverConfig:
              supported === null ? null : { environment: { capabilities: { issues: supported } } },
          },
    );
    try {
      await mount();
      expect(state.detailRead).not.toHaveBeenCalled();
      state.environments = state.environments.toReversed();
      await mount();
      state.environments = original.map((environment, index) => ({
        ...environment,
        serverConfig: { environment: { capabilities: { issues: index === 1 } } },
      }));
      await mount();
      expect(state.detailRead).not.toHaveBeenCalled();
      expect(state.write).not.toHaveBeenCalled();
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent === "Save issue",
        ),
      ).toBe(false);
    } finally {
      state.environments = original;
    }
  },
);

it("pins a uniquely owned legacy link before other projects or capabilities change", async () => {
  const original = state.environments;
  const owner = { ...project("project"), environmentId: environmentB };
  state.projects = [owner];
  state.search = { ...state.search, ...linkedSelection };
  try {
    await mount();
    expect(state.search.selectedEnvironmentId).toBe(environmentB);
    expect(state.navigate).toHaveBeenCalledOnce();
    expect(
      state.detailRead.mock.calls.every(([environmentId]) => environmentId === environmentB),
    ).toBe(true);
    const surface = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      ISSUES_PANEL_REF,
    ).surfaces[0];
    expect(surface).toMatchObject({
      kind: "issue",
      environmentId: environmentB,
      connectionId: "Account/B",
    });
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Save issue")!
        .click(),
    );
    expect(state.write).toHaveBeenCalledExactlyOnceWith(
      environmentB,
      expect.objectContaining({ connectionId: "Account/B" }),
    );
    state.detailRead.mockClear();
    state.projects = [project("project"), owner];
    state.environments = original
      .toReversed()
      .map((environment) =>
        environment.environmentId === environmentB
          ? { ...environment, serverConfig: { environment: { capabilities: { issues: false } } } }
          : environment,
      );
    await mount();
    state.projects = [project("project")];
    state.environments = original.filter(
      (environment) => environment.environmentId !== environmentB,
    );
    await mount();
    expect(state.detailRead).not.toHaveBeenCalled();
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.search.selectedEnvironmentId).toBe(environmentB);
    expect(state.navigate).toHaveBeenCalledTimes(1);
  } finally {
    state.environments = original;
  }
});

it.each(["removed", "loading", "unsupported", "missing-project", "projects-loading"])(
  "never substitutes A for explicit B (%s)",
  async (reason) => {
    const original = state.environments;
    state.projects = [project("project"), { ...project("project"), environmentId: environmentB }];
    state.search = { ...state.search, ...linkedSelection, selectedEnvironmentId: environmentB };
    try {
      await mount();
      expect(state.detailRead).toHaveBeenCalledWith(
        environmentB,
        expect.objectContaining({ projectId: "project" }),
      );
      state.detailRead.mockClear();
      if (reason === "missing-project") state.projects = [project("project")];
      else if (reason === "projects-loading") {
        state.projectsKnown = false;
        state.projects = [project("project")];
      } else
        state.environments = original.flatMap((environment) =>
          environment.environmentId !== environmentB
            ? [environment]
            : reason === "removed"
              ? []
              : [
                  {
                    ...environment,
                    serverConfig:
                      reason === "loading"
                        ? null
                        : { environment: { capabilities: { issues: false } } },
                  },
                ],
        );
      await mount();
      expect(state.detailRead).not.toHaveBeenCalled();
      expect(state.write).not.toHaveBeenCalled();
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent === "Save issue",
        ),
      ).toBe(false);
    } finally {
      state.environments = original;
    }
  },
);

it.each([false, true])(
  "does not infer a missing or still-loading legacy project (loaded=%s)",
  async (loaded) => {
    state.projectsKnown = loaded;
    state.projects = loaded ? [] : [project("project")];
    state.search = { ...state.search, ...linkedSelection };
    await mount();
    expect(state.detailRead).not.toHaveBeenCalled();
    state.projects = [project("project"), { ...project("project"), environmentId: environmentB }];
    state.projectsKnown = true;
    await mount();
    expect(state.detailRead).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
  },
);

it.each(["issue", "pull-request"] as const)(
  "does not lend an owner to an unqualified saved %s tab",
  async (kind) => {
    state.projects = [{ ...project("project"), environmentId: environmentB }];
    if (kind === "issue")
      useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, {
        projectId: "project",
        tracker: "github",
        host: "github.com",
        scope: "org/repo",
        key: "42",
      });
    else
      useRightPanelStore.getState().openPullRequest(ISSUES_PANEL_REF, {
        projectId: "project",
        host: "github.com",
        repository: "org/repo",
        number: 42,
      });
    await mount();
    expect(state.detailRead).not.toHaveBeenCalled();
    expect(state.prRead).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
  },
);

it("keeps a qualified row, linked PR and reselected tab on B", async () => {
  state.projectsKnown = false;
  state.projects = [project("project"), { ...project("project"), environmentId: environmentB }];
  state.responses.set(
    environmentA,
    AsyncResult.success(answer([{ ...issue("42"), title: "From A" }])),
  );
  state.responses.set(
    environmentB,
    AsyncResult.success(answer([{ ...issue("42"), title: "From B" }])),
  );
  await mount();
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("From B"))!
      .click(),
  );
  expect(state.search.selectedEnvironmentId).toBe(environmentB);
  expect(state.detailRead).toHaveBeenCalledWith(environmentB, expect.anything());
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Linked PR")!
      .click(),
  );
  expect(state.prRead).toHaveBeenCalledWith(
    environmentB,
    expect.objectContaining({ repository: "org/repo", number: 42 }),
  );
  const selected = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    ISSUES_PANEL_REF,
  ).surfaces.find((surface) => surface.kind === "issue")!;
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === `Tab ${selected.id}`)!
      .click(),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Save issue")!
      .click(),
  );
  expect(state.write).toHaveBeenCalledExactlyOnceWith(
    environmentB,
    expect.objectContaining({ key: "42" }),
  );
  expect(
    state.detailRead.mock.calls.every(([environmentId]) => environmentId === environmentB),
  ).toBe(true);
});

it("keeps a qualified PR tab on its PR-capable server without issue support", async () => {
  const original = state.environments;
  state.projects = [{ ...project("project"), environmentId: environmentB }];
  state.environments = original.map((environment) =>
    environment.environmentId === environmentB
      ? {
          ...environment,
          serverConfig: { environment: { capabilities: { issues: false, pullRequests: true } } },
        }
      : environment,
  );
  useRightPanelStore.getState().openPullRequest(ISSUES_PANEL_REF, {
    environmentId: environmentB,
    projectId: "project",
    host: "github.com",
    repository: "org/repo",
    number: 42,
  });
  try {
    await mount();
    expect(state.prRead).toHaveBeenCalledWith(
      environmentB,
      expect.objectContaining({ repository: "org/repo", number: 42 }),
    );
    expect(state.detailRead).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
  } finally {
    state.environments = original;
  }
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  appAtomRegistry.reset();
  vi.unstubAllGlobals();
});

it.each(
  (["connectionId", "selectedConnectionId"] as const).flatMap((key) =>
    [
      "",
      " ",
      " Account/B",
      "Account/B ",
      "B".repeat(129),
      undefined,
      "Account/B",
      "B".repeat(128),
    ].map((value, index) => ({ key, value, invalid: index < 5 })),
  ),
)(
  "fails closed for account search $key=$value (invalid=$invalid)",
  async ({ key, value, invalid }) => {
    const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
      await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
    const preferences = JSON.stringify({ who: "all", status: "open", connectionId: "Account/B" });
    localStorage.setItem("t3.issues.preferences", preferences);
    state.projects = [project("project")];
    state.responses.set(environmentA, AsyncResult.success(answer([issue("42")])));
    const raw = {
      environmentId: environmentA,
      projectId: "project",
      host: "github.com",
      selectedEnvironmentId: environmentA,
      selectedProjectId: "project",
      selectedHost: "github.com",
      tracker: "github",
      scope: "org/repo",
      key: "42",
      ...(value === undefined ? {} : { [key]: value }),
    };
    const query = new URLSearchParams(
      Object.entries(raw).map(([key, value]) => [key, JSON.stringify(value)]),
    );
    const rootRoute = createRootRoute();
    const mounted = vi.fn();
    const route = createRoute({
      getParentRoute: () => rootRoute,
      path: "/issues",
      validateSearch: Route.options.validateSearch,
      beforeLoad: ({ search }) => {
        state.search = search;
      },
      component: () => {
        mounted();
        return <Page />;
      },
      errorComponent: () => <p role="alert">Invalid issue account</p>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([route]),
      history: createMemoryHistory({ initialEntries: [`/issues?${query}`] }),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await act(async () => {
        await router.load();
        root.render(
          <RegistryContext.Provider value={appAtomRegistry}>
            <RouterProvider router={router} />
          </RegistryContext.Provider>,
        );
      });
      if (invalid) {
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(
          "Invalid issue account",
        );
        expect(mounted).not.toHaveBeenCalled();
        expect(state.read).not.toHaveBeenCalled();
        expect(state.listPage).not.toHaveBeenCalled();
        expect(useRightPanelStore.getState().byThreadKey).toEqual({});
        expect(localStorage.getItem("t3.issues.preferences")).toBe(preferences);
      } else {
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(mounted).toHaveBeenCalled();
        expect(state.search[key]).toBe(value);
        expect(state.read).toHaveBeenCalledOnce();
        for (const [environmentId, input] of state.read.mock.calls) {
          expect(environmentId).toBe(environmentA);
          expect(input.connectionId).toBe(key === "connectionId" ? value : undefined);
        }
        const surfaces = selectThreadRightPanelState(
          useRightPanelStore.getState().byThreadKey,
          ISSUES_PANEL_REF,
        ).surfaces;
        const selected = surfaces.find((surface) => surface.kind === "issue");
        expect(selected?.kind).toBe("issue");
        if (selected?.kind === "issue")
          expect(selected.connectionId).toBe(key === "selectedConnectionId" ? value : undefined);
        expect(localStorage.getItem("t3.issues.preferences")).toBe(preferences);
      }
    } finally {
      error.mockRestore();
    }
  },
);

it.each([false, true])(
  "shows a failed environment beside a successful answer (empty=%s) and retries",
  async (empty) => {
    state.responses.set(environmentA, AsyncResult.success(answer(empty ? [] : [issue("A")])));
    state.responses.set(
      environmentB,
      AsyncResult.failure(Cause.fail(new Error("Environment B is offline"))),
    );
    await mount();
    expect(text()).toContain("Environment B is offline");
    if (!empty) expect(text()).toContain("Issue A");
    expect(retry()).toBeDefined();
    state.responses.set(environmentB, AsyncResult.success(answer([issue("B")])));
    state.read.mockClear();
    await act(async () => retry()!.click());
    expect(state.read.mock.calls.map(([id]) => id).sort()).toEqual([environmentA, environmentB]);
    expect(text()).not.toContain("Environment B is offline");
    expect(text()).toContain("Issue B");
    if (!empty) expect(text()).toContain("Issue A");
    expect(retry()).toBeUndefined();
  },
);

it("keeps both environments' rows and the error after a failed refresh, then recovers", async () => {
  const first = answer([issue("A")]);
  const second = answer([issue("B")]);
  state.responses.set(environmentA, AsyncResult.success(first));
  state.responses.set(environmentB, AsyncResult.success(second));
  await mount();
  expect(text()).toContain("Issue A");
  expect(text()).toContain("Issue B");
  state.responses.set(
    environmentB,
    AsyncResult.failure(Cause.fail(new Error("Environment B refresh failed")), {
      previousSuccess: Option.some(AsyncResult.success(second)),
    }),
  );
  await refresh();
  expect(text()).toContain("Issue A");
  expect(text()).toContain("Issue B");
  expect(text()).toContain("Environment B refresh failed");
  expect(retry()).toBeDefined();
  state.responses.set(environmentB, AsyncResult.success(answer([issue("B reconnected")])));
  await act(async () => retry()!.click());
  expect(text()).toContain("Issue A");
  expect(text()).toContain("Issue B reconnected");
  expect(text()).not.toContain("Environment B refresh failed");
  expect(retry()).toBeUndefined();
});

const source = (id: string, host: string): NonNullable<IssueListResult["sources"]>[number] => ({
  projectId: ProjectId.make(id),
  projectTitle: `Project ${id}`,
  tracker: IssueTrackerKind.make("github"),
  host,
  scope: `org/${id}`,
  capabilities: {
    create: false,
    edit: false,
    comment: false,
    labels: false,
    assignees: false,
    reactions: false,
    templates: false,
    linkedPullRequests: false,
    events: false,
    search: false,
    states: [],
    closeReasons: [],
  },
});
const sourceAnswer = (sources: NonNullable<IssueListResult["sources"]>): IssueListResult => ({
  ...answer([]),
  sources,
  trackers: sources.map((source) => ({
    tracker: source.tracker,
    host: source.host,
    projectCount: 1,
    configured: true,
    detail: null,
    capabilities: source.capabilities,
  })),
});
const filterGroup = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-group"]')].find(
    (group) => group.querySelector('[data-slot="menu-label"]')?.textContent === label,
  );
async function openFilters() {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Filters"]');
  expect(trigger).not.toBeNull();
  if (trigger!.getAttribute("aria-expanded") !== "true")
    await act(async () =>
      trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
}
async function openFilter(label: string) {
  await openFilters();
  const group = label.replace("Filter by ", "");
  expect(filterGroup(group[0]!.toUpperCase() + group.slice(1))).toBeDefined();
}

it("forwards and explicitly clears the account filter without retaining a stale selector", async () => {
  const base = answer([]);
  state.responses.set(
    environmentA,
    AsyncResult.success({
      ...base,
      trackers: ["A", "B"].map((connectionId) => ({ ...base.trackers[0]!, connectionId })),
    }),
  );
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  await mount();
  await openFilter("Filter by tracker");
  const account = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (option) => option.textContent?.endsWith(" · B"),
  )!;
  await act(async () => account.click());
  await mount();
  expect(state.search.connectionId).toBe("B");
  expect(state.read.mock.calls.at(-1)![1]).toMatchObject({ connectionId: "B", host: "github.com" });
  await openFilter("Filter by tracker");
  const all = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (option) => option.textContent === "All trackers",
  )!;
  await act(async () => all.click());
  await mount();
  expect(state.search).not.toHaveProperty("connectionId");
  expect(state.search).not.toHaveProperty("host");
});
const projectBOption = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.includes("Project B"),
  );

it("keeps another host's project selectable after a host-filtered answer", async () => {
  const sources = [source("A", "github.com"), source("B", "github.example")];
  state.projects = [project("A"), project("B")];
  state.responses.set(environmentA, AsyncResult.success(sourceAnswer(sources)));
  state.responses.set(environmentB, AsyncResult.success(sourceAnswer([])));
  await mount();
  await openFilter("Filter by tracker");
  const host = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.includes("github.com"),
  );
  expect(host).toBeDefined();
  state.responses.set(environmentA, AsyncResult.success(sourceAnswer(sources.slice(0, 1))));
  await act(async () => host!.click());
  await mount();
  expect(state.search.host).toBe("github.com");
  await openFilter("Filter by project");
  expect(projectBOption()).toBeDefined();
  await act(async () => projectBOption()!.click());
  await mount();
  await openFilter("Filter by project");
  expect(projectBOption()?.getAttribute("aria-checked")).toBe("true");
  expect(state.search).toMatchObject({
    host: "github.com",
    environmentId: environmentA,
    projectId: "B",
  });
});

it("offers capable projects when the initial host-filtered answer has no full inventory", async () => {
  state.projects = [
    project("A"),
    project("B"),
    { ...project("C"), environmentId: EnvironmentId.make("unavailable") },
  ];
  state.search = { ...state.search, host: "github.com" };
  state.responses.set(environmentA, AsyncResult.success(sourceAnswer([source("A", "github.com")])));
  state.responses.set(environmentB, AsyncResult.success(sourceAnswer([])));
  await mount();
  await openFilter("Filter by project");
  expect(projectBOption()).toBeDefined();
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("Project A");
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Project C");
});

it("removes projects after an authoritative empty unfiltered answer", async () => {
  state.projects = [project("A"), project("B")];
  state.responses.set(
    environmentA,
    AsyncResult.success(sourceAnswer([source("A", "github.com"), source("B", "github.example")])),
  );
  state.responses.set(environmentB, AsyncResult.success(sourceAnswer([])));
  await mount();
  await openFilter("Filter by project");
  expect(filterGroup("Project")?.textContent).toContain("Project A");
  expect(filterGroup("Project")?.textContent).toContain("Project B");
  state.responses.set(environmentA, AsyncResult.success(sourceAnswer([])));
  await refresh();
  expect(filterGroup("Project")).toBeUndefined();
  expect(projectBOption()).toBeUndefined();
});

it.each(["Linux", "MacIntel"])(
  "closes the active issue with the platform shortcut (%s)",
  async (platform) => {
    const system = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const selected = {
      environmentId: environmentA,
      projectId: "project",
      tracker: "github",
      host: "github.com",
      connectionId: "Account/B",
      scope: "org/repo",
      key: "7",
    };
    const panels = useRightPanelStore.getState();
    panels.openIssue(ISSUES_PANEL_REF, selected);
    panels.openIssue(ISSUES_PANEL_REF, { ...selected, key: "8" });
    state.responses.set(environmentA, AsyncResult.success(answer([])));
    state.responses.set(environmentB, AsyncResult.success(answer([])));
    const keys = () =>
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        ISSUES_PANEL_REF,
      ).surfaces.map((surface) => (surface.kind === "issue" ? surface.key : surface.id));
    const press = (init: KeyboardEventInit = {}, handled = false) => {
      const event = new KeyboardEvent("keydown", {
        key: "w",
        code: "KeyW",
        ctrlKey: platform === "Linux",
        metaKey: platform === "MacIntel",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      if (handled) event.preventDefault();
      act(() => document.body.dispatchEvent(event));
      return event.defaultPrevented;
    };
    try {
      await mount();
      press({}, true);
      expect(keys()).toEqual(["7", "8"]);
      const palette = document.createElement("div");
      palette.dataset.commandPalette = "true";
      container.append(palette);
      expect(press()).toBe(false);
      palette.remove();
      expect(press({ repeat: true })).toBe(true);
      expect(keys()).toEqual(["7", "8"]);
      expect(press()).toBe(true);
      expect(keys()).toEqual(["7"]);
      expect(state.search).toMatchObject({
        selectedEnvironmentId: environmentA,
        selectedConnectionId: selected.connectionId,
        key: "7",
      });
      act(() => panels.close(ISSUES_PANEL_REF));
      expect(press()).toBe(false);
      expect(keys()).toEqual(["7"]);
      act(() => panels.closeAllSurfaces(ISSUES_PANEL_REF));
      expect(press()).toBe(false);
    } finally {
      system.mockRestore();
    }
  },
);

it("toggles the selected issue panel with the existing keyboard shortcut", async () => {
  state.projects = [project("project")];
  state.responses.set(environmentA, AsyncResult.success(answer([issue("A")])));
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  await mount();
  const panel = () => container.querySelector('aside[aria-label="Issue details"]');
  const toggle = async (options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: "b",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    await act(async () => document.dispatchEvent(event));
    return event;
  };
  expect((await toggle()).defaultPrevented).toBe(false);
  expect(panel()).toBeNull();
  const row = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes("Issue A"),
  )!;
  await act(async () => row.click());
  expect(panel()).not.toBeNull();
  expect((await toggle()).defaultPrevented).toBe(true);
  expect(panel()).toBeNull();
  expect(state.search.selectedProjectId).toBeUndefined();
  await toggle({ repeat: true });
  expect(panel()).toBeNull();
  await toggle();
  expect(panel()).not.toBeNull();
  expect(state.search.key).toBe("A");
  const palette = document.createElement("div");
  palette.setAttribute("data-command-palette", "");
  container.append(palette);
  expect((await toggle()).defaultPrevented).toBe(false);
  expect(panel()).not.toBeNull();
});

const decodeIssueList = Schema.decodeUnknownSync(IssueListResult);
it("labels both native mount scopes when their issue numbers match", async () => {
  const upper = {
    ...issue("42"),
    tracker: IssueTrackerKind.make("forgejo"),
    host: "forge.example",
    scope: "Root/Mount/acme/web",
  };
  const lower = { ...upper, scope: "Root/mount/acme/web" };
  const initial = answer([upper, lower]);
  state.responses.set(
    environmentA,
    AsyncResult.success({
      ...initial,
      trackers: [{ ...initial.trackers[0]!, tracker: upper.tracker, host: upper.host }],
    }),
  );
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  await mount();
  const rows = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    button.textContent?.includes("Issue 42"),
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain(upper.scope);
  expect(rows[1]!.textContent).toContain(lower.scope);
});

const RpcClient = await vi.importActual<typeof import("@t3tools/client-runtime/rpc")>(
  "../../../../../packages/client-runtime/src/rpc/client.ts",
);
async function nativeSortSetup(
  respond: (environmentId: EnvironmentId, input: IssueListInput) => Effect.Effect<IssueListResult>,
) {
  const { createIssueEnvironmentAtoms } = await vi.importActual<
    typeof import("@t3tools/client-runtime/state/issues")
  >("@t3tools/client-runtime/state/issues");
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const connection = yield* SubscriptionRef.make({ phase: "connected" } as const);
        const session = yield* SubscriptionRef.make(Option.some({}));
        const supervisor = (environmentId: EnvironmentId) =>
          ({
            target: { environmentId },
            state: connection,
            session,
          }) as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        return EnvironmentRegistry.EnvironmentRegistry.of({
          run: (id, effect) =>
            Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor(id),
            ),
          followStream: (id, stream) =>
            Stream.provideService(
              stream,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor(id),
            ),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      }),
    ),
  );
  const atoms = createIssueEnvironmentAtoms(runtime);
  const list = vi.spyOn(issueEnvironment, "list").mockImplementation(atoms.list);
  const request = vi.spyOn(RpcClient, "request").mockImplementation(((tag, input) =>
    Effect.gen(function* () {
      expect(tag).toBe(WS_METHODS.issuesList);
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      return yield* respond(supervisor.target.environmentId, input as IssueListInput);
    })) as typeof RpcClient.request);
  return () => {
    list.mockRestore();
    request.mockRestore();
  };
}
const nativeSortCapabilities: IssueCapabilities = {
  create: false,
  edit: false,
  comment: false,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
  states: [],
  closeReasons: [],
  listSorts: ["updated", "created", "comments"],
  listOrders: ["desc", "asc"],
};

it("requests the saved native sort once while capabilities are unknown", async () => {
  const environments = state.environments;
  state.environments = environments.slice(0, 1);
  state.search = { who: "all", status: "open", issueSort: "created", issueOrder: "asc" };
  const reads: Array<IssueListInput> = [];
  const restore = await nativeSortSetup((_id, input) =>
    Effect.sync(() => {
      reads.push(input);
      const value = answer([issue("1")]);
      return decodeIssueList({
        ...value,
        trackers: [{ ...value.trackers[0], capabilities: nativeSortCapabilities }],
      });
    }),
  );
  try {
    await mount();
    expect(text()).toContain("Issue 1");
    expect(reads.map(({ sort, order }) => [sort, order])).toEqual([["created", "asc"]]);
    await mount();
    expect(reads).toHaveLength(1);
  } finally {
    state.environments = environments;
    restore();
  }
});

it("retains native sort refusals while another environment's fallback page is pending", async () => {
  state.search = { who: "all", status: "open", issueSort: "comments" };
  const reads: Array<{ environmentId: EnvironmentId; input: IssueListInput }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const restore = await nativeSortSetup((environmentId, input) => {
    reads.push({ environmentId, input });
    const entry =
      environmentId === environmentA
        ? issue("A")
        : {
            ...issue("B"),
            tracker: IssueTrackerKind.make("gitlab"),
            host: "gitlab.com",
            url: "https://gitlab.com/org/repo/-/issues/1",
          };
    const value = answer([entry]);
    const refused = environmentId === environmentB && input.sort === "comments";
    const result = decodeIssueList({
      ...value,
      entries: refused ? [] : value.entries,
      errors: refused
        ? [
            {
              projectId: entry.projectId,
              projectTitle: entry.projectTitle,
              tracker: entry.tracker,
              host: entry.host,
              message: "This tracker does not support the selected issue order.",
            },
          ]
        : [],
      trackers: [
        {
          ...value.trackers[0],
          tracker: entry.tracker,
          host: entry.host,
          capabilities: {
            ...nativeSortCapabilities,
            listSorts:
              environmentId === environmentA
                ? ["updated", "created", "comments"]
                : ["updated", "created"],
          },
        },
      ],
    });
    return environmentId === environmentB && input.sort === "updated"
      ? Effect.promise(async () => {
          await gate;
          return result;
        })
      : Effect.succeed(result);
  });
  try {
    await mount();
    expect(text()).toContain("Issue A");
    await openFilters();
    expect(filterGroup("Sort")?.querySelector('[aria-checked="true"]')?.textContent).toBe(
      "Recently updated",
    );
    await mount();
    expect(reads.map(({ environmentId, input }) => [environmentId, input.sort])).toEqual([
      [environmentA, "comments"],
      [environmentB, "comments"],
      [environmentA, "updated"],
      [environmentB, "updated"],
    ]);
    await act(async () => release());
    expect(text()).toContain("Issue B");
    await mount();
    expect(reads).toHaveLength(4);
  } finally {
    release();
    restore();
  }
});

it.each([
  { viewer: "B", empty: false },
  { viewer: "B", empty: true },
  { viewer: "A", empty: false },
])("restarts an accepted native viewer change once: %j", async ({ viewer, empty }) => {
  const { createIssueEnvironmentAtoms } = await vi.importActual<
    typeof import("@t3tools/client-runtime/state/issues")
  >("@t3tools/client-runtime/state/issues");
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const connection = yield* SubscriptionRef.make({ phase: "connected" } as const);
        const session = yield* SubscriptionRef.make(Option.some({}));
        const supervisor = {
          state: connection,
          session,
        } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        return EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      }),
    ),
  );
  const atoms = createIssueEnvironmentAtoms(runtime);
  const list = vi.spyOn(issueEnvironment, "list").mockImplementation(atoms.list);
  state.listPage.mockImplementation((target) => atoms.listPage.run(appAtomRegistry, target));
  const environments = state.environments;
  state.environments = environments.slice(0, 1);
  const cursor = "github github.com org/repo";
  const failedCursor = "github github.com org/failed";
  const otherCursor = "gitlab gitlab.com org/repo";
  const other = { ...issue("G1"), tracker: IssueTrackerKind.make("gitlab"), host: "gitlab.com" };
  const failed = { ...issue("F1"), projectId: ProjectId.make("failed"), scope: "org/failed" };
  const initial = {
    ...answer([issue("A1"), failed, other]),
    viewers: { "github github.com": "A", "gitlab gitlab.com": "G" },
    nextCursors: { [cursor]: "2", [failedCursor]: "f2", [otherCursor]: "g2" },
  };
  initial.trackers = [
    ...initial.trackers,
    { ...initial.trackers[0]!, tracker: other.tracker, host: other.host },
  ];
  const pageTwo = {
    ...initial,
    entries: [],
    viewers: { ...initial.viewers, "github github.com": viewer },
    nextCursors: {},
    errors: [
      {
        projectId: failed.projectId,
        projectTitle: failed.projectTitle,
        tracker: failed.tracker,
        host: failed.host,
        message: "Failed native sibling",
      },
    ],
  };
  const firstForB = { ...pageTwo, entries: empty ? [] : [issue("B1")], errors: [] };
  const replies = [initial, pageTwo, ...(viewer === "B" ? [firstForB] : [])];
  const reads: Array<{ tag: string; input: unknown }> = [];
  const respond = ((tag: string, input: unknown) =>
    Effect.sync(() => {
      reads.push({ tag, input });
      return decodeIssueList(replies.shift());
    })) as unknown as typeof RpcClient.request;
  const request = vi.spyOn(RpcClient, "request").mockImplementation(respond);
  const guarded = vi.spyOn(RpcClient, "requestGuarded");
  guarded.mockImplementation(
    respond as unknown as Parameters<typeof guarded.mockImplementation>[0],
  );
  try {
    await mount();
    expect(text()).toContain("Issue A1");
    await intersect();
    expect(reads.map(({ tag }) => tag)).toEqual(
      Array(viewer === "B" ? 3 : 2).fill(WS_METHODS.issuesList),
    );
    expect(reads[1]!.input).toMatchObject({ cursors: { [cursor]: "2", [failedCursor]: "f2" } });
    if (viewer === "B") {
      expect(reads[2]!.input).toMatchObject({ projectId: "project", host: "github.com" });
      expect(reads[2]!.input).not.toHaveProperty("cursors");
      expect(text()).not.toContain("Issue A1");
      if (!empty) expect(text()).toContain("Issue B1");
    } else expect(text()).toContain("Issue A1");
    expect(text()).toContain("Issue G1");
    expect(text()).toContain("Issue F1");
    expect(text()).toContain("Failed native sibling");
    expect(container.querySelectorAll("section")).toHaveLength(2);
    expect(
      new Set(
        intersections
          .filter(({ element }) => element.isConnected && element.closest("section") !== null)
          .map(({ element }) => element),
      ).size,
    ).toBe(2);
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Load more",
      ),
    ).toBe(false);
    await mount();
    expect(reads).toHaveLength(viewer === "B" ? 3 : 2);
    expect(replies).toEqual([]);
  } finally {
    state.environments = environments;
    list.mockRestore();
    request.mockRestore();
    guarded.mockRestore();
  }
});

it("keeps typing and selection out of history so Back leaves the page", async () => {
  const { createMemoryHistory, createRootRoute, createRoute, createRouter } =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  const rootRoute = createRootRoute();
  const history = createMemoryHistory({ initialEntries: ["/", "/issues"], initialIndex: 1 });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/issues" }),
    ]),
    history,
  });
  await router.load();
  state.navigate.mockImplementation((options) => router.navigate({ to: "/issues", ...options }));
  state.responses.set(environmentA, AsyncResult.success(answer([issue("A")])));
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  await mount();
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search issues"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, "la");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Issue A"))!
      .click(),
  );
  expect(history.location.search).toContain("q=la");
  expect(history.location.search).toContain("key=");
  expect(history.length).toBe(2);
  history.back();
  expect(history.location.pathname).toBe("/");
});

it("refreshes each first page over the last refreshed list, not the continuation", async () => {
  const cursor = "github github.com org/repo";
  const first = (keys: ReadonlyArray<string>) =>
    AsyncResult.success({ ...answer(keys.map(issue)), nextCursors: { [cursor]: "2" } });
  state.responses.set(environmentA, first(["1", "2"]));
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  state.listPage.mockResolvedValue({ _tag: "Success", value: answer([issue("3")]) });
  await mount();
  await intersect();
  expect(text()).toContain("Issue 3");
  state.responses.set(environmentA, first(["3", "1"]));
  await refresh();
  expect(text()).toContain("Issue 3");
  state.read.mockClear();
  state.responses.set(environmentA, first(["1", "2"]));
  await refresh();
  expect(text()).toContain("Issue 1");
  expect(text()).toContain("Issue 2");
  expect(text()).not.toContain("Issue 3");
  expect(state.read.mock.calls.map(([id]) => id).sort()).toEqual([environmentA, environmentB]);
  expect(state.listPage).toHaveBeenCalledOnce();
});

it("names issues, not pull requests, while loading and after every environment fails", async () => {
  await mount();
  expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
    "Loading issues",
  );
  for (const environmentId of [environmentA, environmentB])
    state.responses.set(environmentId, AsyncResult.failure(Cause.fail(new Error("Offline"))));
  const reads = state.read.mock.calls.slice();
  await act(async () => {
    for (const [environmentId, input] of reads)
      appAtomRegistry.refresh(issueEnvironment.list({ environmentId, input }));
  });
  expect(container.querySelector('[data-slot="empty-title"]')?.textContent).toBe(
    "Could not load issues",
  );
  expect(container.querySelector('[data-slot="empty-media"] svg')?.classList).toContain(
    "lucide-circle-dot",
  );
  expect(text()).not.toContain("pull request");
});

it("keeps saved list settings when a link only selects an issue, and saves list controls", async () => {
  const saved = JSON.stringify({ who: "assigned", status: "closed", issueSort: "created" });
  localStorage.setItem("t3.issues.preferences", saved);
  state.projects = [project("project")];
  const { selectedConnectionId: _account, ...selection } = linkedSelection;
  state.search = { ...state.search, ...selection };
  state.responses.set(environmentA, AsyncResult.success(answer([issue("42")])));
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  await mount();
  await mount();
  expect(state.search.selectedEnvironmentId).toBe(environmentA);
  expect(localStorage.getItem("t3.issues.preferences")).toBe(saved);
  await openFilters();
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((option) => option.textContent === "Closed")!
      .click(),
  );
  expect(JSON.parse(localStorage.getItem("t3.issues.preferences")!)).toEqual({
    who: "all",
    status: "closed",
  });
});

it("explains an unavailable account option in the tracker filter", async () => {
  vi.useFakeTimers();
  try {
    state.search = { ...state.search, host: "github.com", connectionId: "Gone" };
    state.responses.set(environmentA, AsyncResult.success(answer([])));
    state.responses.set(environmentB, AsyncResult.success(answer([])));
    await mount();
    await openFilter("Filter by tracker");
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.startsWith("github.com · Gone"),
    )!;
    expect(option.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      option.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      option.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      option.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.body.textContent).toContain("This account is not available");
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["a pasted GitHub number", "key=44", "44"],
  ["a quoted GitHub number", "key=%2244%22", "44"],
  ["a number with leading zeros", "key=0044", "0044"],
  ["a Linear key", "key=ENG-12", "ENG-12"],
  ["a Jira key", "key=%22ABC-7%22", "ABC-7"],
  ["a negative number", "key=-1", undefined],
  ["an unsafe number", "key=12345678901234567890", undefined],
  ["a boolean", "key=true", undefined],
])("matches %s as a string issue key or none", async (_name, keyQuery, expected) => {
  const { createMemoryHistory, createRootRoute, createRoute, createRouter } =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const issues = createRoute({
    getParentRoute: () => chat,
    path: "issues",
    validateSearch: Route.options.validateSearch,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([issues])]),
    history: createMemoryHistory({
      initialEntries: [
        `/issues?selectedEnvironmentId=env&selectedProjectId=project&selectedHost=github.com&tracker=github&scope=demo%2Fatlas&${keyQuery}`,
      ],
    }),
  });
  const search = router.matchRoutes(router.latestLocation).at(-1)?.search as IssuesSearch;
  expect(search.key).toBe(expected);
  expect(search).toMatchObject({
    tracker: "github",
    scope: "demo/atlas",
    selectedHost: "github.com",
  });
  expect(search.selectedEnvironmentId).toBe("env");
});

it.each<[string, string | null | undefined]>([
  ["selectedHost=github.com&", "github.com"],
  ["", undefined],
  ...["44", "0", "-1", "4.5", "12345678901234567890", "true", "null", "%5B%5D", "%7B%7D"].map(
    (host): [string, null] => [`selectedHost=${host}&`, null],
  ),
])("opens a pasted numeric GitHub issue link with a string key (%s)", async (hostQuery, host) => {
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  state.projects = [project("project")];
  state.responses.set(environmentA, AsyncResult.success(answer([issue("44")])));
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/issues",
    validateSearch: Route.options.validateSearch,
    beforeLoad: ({ search }) => {
      state.search = search;
    },
    component: Page,
    errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [
        `/issues?who=assigned&status=open&selectedEnvironmentId=${environmentA}&selectedProjectId=project&${hostQuery}tracker=github&scope=demo%2Fatlas&key=44`,
      ],
    }),
  });
  await act(async () => {
    await router.load();
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RouterProvider router={router} />
      </RegistryContext.Provider>,
    );
  });
  const surfaces = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    ISSUES_PANEL_REF,
  ).surfaces;
  if (host === null) {
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The selected issue host is invalid.",
    );
    expect(state.detailRead).not.toHaveBeenCalled();
    expect(surfaces).toEqual([]);
    return;
  }
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(state.detailRead).toHaveBeenCalledWith(
    environmentA,
    expect.objectContaining({ tracker: "github", scope: "demo/atlas", key: "44" }),
  );
  expect(state.detailRead.mock.calls.at(-1)?.[1].host).toBe(host);
  const surface = surfaces.find((candidate) => candidate.kind === "issue");
  expect(surface?.kind === "issue" ? surface.key : null).toBe("44");
});

it("puts state, involvement, projects, trackers, sort and order behind one Filters button", async () => {
  state.projects = [project("A"), project("B")];
  const sources = [source("A", "github.com"), source("B", "github.example")].map((value) => ({
    ...value,
    capabilities: nativeSortCapabilities,
  }));
  state.responses.set(environmentA, AsyncResult.success(sourceAnswer(sources)));
  state.responses.set(environmentB, AsyncResult.success(sourceAnswer(sources)));
  await mount();
  expect(container.querySelectorAll('[data-slot="menu-trigger"]')).toHaveLength(1);
  expect(container.querySelector('[role="menuitemradio"]')).toBeNull();
  await openFilters();
  for (const label of ["State", "Involvement", "Project", "Tracker", "Sort", "Order"])
    expect(filterGroup(label)).toBeDefined();
  expect(filterGroup("State")?.textContent).toContain("OpenClosedAll");
  expect(filterGroup("Involvement")?.textContent).toContain("Everyone");
  const newest = [
    ...filterGroup("Sort")!.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
  ].find((item) => item.textContent === "Newest")!;
  await act(async () => newest.click());
  await mount();
  expect(state.search.issueSort).toBe("created");
  expect(JSON.parse(localStorage.getItem("t3.issues.preferences")!)).toMatchObject({
    issueSort: "created",
  });
});

it("loads the next issue window on scroll and keeps existing rows", async () => {
  const cursor = "github github.com org/repo";
  state.responses.set(
    environmentA,
    AsyncResult.success({ ...answer([issue("1")]), nextCursors: { [cursor]: "2" } }),
  );
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  state.listPage.mockResolvedValue({ _tag: "Success", value: answer([issue("2")]) });
  await mount();
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Load more"),
  ).toBe(false);
  const row = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Issue 1"),
  );
  await intersect();
  expect(state.listPage).toHaveBeenCalledExactlyOnceWith({
    environmentId: environmentA,
    input: expect.objectContaining({ cursors: { [cursor]: "2" } }),
  });
  expect(text()).toContain("Issue 2");
  expect(row?.isConnected).toBe(true);
});

it("clears only the refreshed environment's inventory", async () => {
  state.projects = [
    project("A"),
    project("B"),
    { ...project("C"), environmentId: environmentB },
    { ...project("D"), environmentId: environmentB },
  ];
  state.responses.set(
    environmentA,
    AsyncResult.success(sourceAnswer([source("A", "github.com"), source("B", "github.example")])),
  );
  state.responses.set(
    environmentB,
    AsyncResult.success(sourceAnswer([source("C", "github.com"), source("D", "github.example")])),
  );
  await mount();
  await openFilter("Filter by project");
  for (const id of ["A", "B", "C", "D"])
    expect(filterGroup("Project")?.textContent).toContain(`Project ${id}`);
  state.responses.set(environmentA, AsyncResult.success(sourceAnswer([])));
  await refresh();
  expect(filterGroup("Project")?.textContent).toContain("Project C");
  expect(filterGroup("Project")?.textContent).toContain("Project D");
  expect(filterGroup("Project")?.textContent).not.toContain("Project A");
  expect(filterGroup("Project")?.textContent).not.toContain("Project B");
});

it("keeps the full inventory after an account-filtered empty answer", async () => {
  state.projects = [project("A"), project("B")];
  state.responses.set(
    environmentA,
    AsyncResult.success(sourceAnswer([source("A", "github.com"), source("B", "github.example")])),
  );
  state.responses.set(environmentB, AsyncResult.success(sourceAnswer([])));
  await mount();
  state.search = { ...state.search, connectionId: "B" };
  state.responses.set(environmentA, AsyncResult.success(sourceAnswer([])));
  await mount();
  await openFilter("Filter by project");
  expect(filterGroup("Project")?.textContent).toContain("Project A");
  expect(filterGroup("Project")?.textContent).toContain("Project B");
});

it("pauses scroll requests while pending and after failure, then retries without losing rows", async () => {
  const cursor = "github github.com org/repo";
  state.responses.set(
    environmentA,
    AsyncResult.success({ ...answer([issue("1")]), nextCursors: { [cursor]: "2" } }),
  );
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  let finish!: (value: unknown) => void;
  state.listPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  const observer = intersections.at(-1)!;
  await act(async () => {
    observer.intersect();
    observer.intersect();
  });
  expect(state.listPage).toHaveBeenCalledTimes(1);
  expect(text()).toContain("Issue 1");
  await act(async () =>
    finish({ _tag: "Failure", cause: Cause.fail(new Error("Tracker offline")) }),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Tracker offline");
  await act(async () => observer.intersect());
  expect(state.listPage).toHaveBeenCalledTimes(1);
  state.listPage.mockResolvedValueOnce({ _tag: "Success", value: answer([issue("2")]) });
  await act(async () => retry()!.click());
  expect(state.listPage).toHaveBeenCalledTimes(2);
  expect(text()).toContain("Issue 1");
  expect(text()).toContain("Issue 2");
  expect(retry()).toBeUndefined();
});

it("continues an answered environment while another environment is still pending", async () => {
  const cursor = "github github.com org/repo";
  state.responses.set(
    environmentA,
    AsyncResult.success({ ...answer([issue("1")]), nextCursors: { [cursor]: "2" } }),
  );
  state.listPage.mockResolvedValue({ _tag: "Success", value: answer([issue("2")]) });
  await mount();
  await intersect();
  expect(state.listPage).toHaveBeenCalledOnce();
  expect(text()).toContain("Issue 1");
  expect(text()).toContain("Issue 2");
});

it("discards a pending continuation and its observer after an account switch", async () => {
  const first = {
    ...answer([{ ...issue("A"), connectionId: "A" }]),
    trackers: [{ ...answer([]).trackers[0]!, connectionId: "A" }],
    nextCursors: { "@A github github.com org/repo": "2" },
  };
  const second = {
    ...answer([{ ...issue("B"), connectionId: "B" }]),
    trackers: [{ ...answer([]).trackers[0]!, connectionId: "B" }],
    nextCursors: { "@B github github.com org/repo": "2" },
  };
  state.responses.set(environmentA, AsyncResult.success(first));
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  let finish!: (value: unknown) => void;
  state.listPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  const observer = intersections.at(-1)!;
  await intersect();
  state.search = { ...state.search, host: "github.com", connectionId: "B" };
  state.responses.set(environmentA, AsyncResult.success(second));
  await mount();
  await act(async () => finish({ _tag: "Success", value: answer([issue("A tail")]) }));
  await act(async () => observer.intersect());
  expect(state.listPage).toHaveBeenCalledOnce();
  expect(text()).toContain("Issue B");
  expect(text()).not.toContain("Issue A");
});
