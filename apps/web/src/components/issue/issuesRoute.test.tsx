// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueListEntry,
  type IssueListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  responses: new Map<string, AsyncResult.AsyncResult<IssueListResult, unknown>>(),
  read: vi.fn(),
  listPage: vi.fn(),
  search: { who: "all", status: "open" } as Record<string, string>,
  projects: [] as ReadonlyArray<object>,
  navigate: vi.fn(),
  environments: ["environment-a", "environment-b"].map((environmentId) => ({
    environmentId,
    label: environmentId,
    serverConfig: { environment: { capabilities: { issues: true } } },
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
      const { environmentId } = JSON.parse(key);
      state.read(environmentId);
      return state.responses.get(environmentId) ?? AsyncResult.initial(true);
    }).pipe(Atom.keepAlive),
  );
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/state/issues")>()),
    createIssueEnvironmentAtoms: () => ({
      list: (target: unknown) => queries(JSON.stringify(target)),
      listPage: {},
    }),
  };
});
vi.mock("~/state/entities", () => ({
  useProjects: () => state.projects,
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  useIssuesSupported: () => true,
}));
vi.mock("~/state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.listPage }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("~/hooks/useNavigateBack", () => ({ useEscapeToGoBack: () => {} }));
vi.mock("~/panelAnimations", () => ({
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
  usePanelPresence: () => ({ present: false, value: null }),
}));
vi.mock("~/components/ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("~/components/WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("~/components/issue/IssueDetailPanel", () => ({ IssueDetailPanel: () => null }));
vi.mock("~/components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: () => null,
}));
vi.mock("~/components/issue/IssueCreateDialog", () => ({ IssueCreateDialog: () => null }));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ISSUES_PANEL_REF,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { Route } from "~/routes/_chat.issues";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
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
  localStorage.clear();
  state.responses.clear();
  state.read.mockClear();
  state.listPage.mockReset();
  state.search = { who: "all", status: "open" };
  state.projects = [];
  state.navigate.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  appAtomRegistry.reset();
  vi.unstubAllGlobals();
});

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

it("keeps every project selectable while the list is narrowed to one tracker host", async () => {
  const project = (id: string) => ({
    id: ProjectId.make(id),
    environmentId: environmentA,
    title: id,
    workspaceRoot: `/work/${id}`,
  });
  const source = (id: string, host: string) => ({
    projectId: ProjectId.make(id),
    projectTitle: id,
    tracker: IssueTrackerKind.make("github"),
    host,
    scope: `org/${id}`,
    capabilities: { create: false } as NonNullable<
      IssueListResult["sources"]
    >[number]["capabilities"],
  });
  state.projects = [project("Project A"), project("Project B")];
  state.responses.set(
    environmentA,
    AsyncResult.success({
      ...answer([]),
      sources: [source("Project A", "github.com"), source("Project B", "ghe.example.com")],
    }),
  );
  const projectChoices = async () => {
    const menu = container.querySelector<HTMLButtonElement>('[aria-label^="Filter by project"]');
    if (menu === null) return [];
    await act(async () => menu.click());
    const choices = [...document.querySelectorAll('[role="menuitemradio"] .truncate')].map(
      (label) => label.textContent,
    );
    await act(async () => menu.click());
    return choices;
  };
  await mount();
  expect(await projectChoices()).toEqual(["All projects", "Project A", "Project B"]);
  state.search = { ...state.search, host: "github.com" };
  state.responses.set(
    environmentA,
    AsyncResult.success({ ...answer([]), sources: [source("Project A", "github.com")] }),
  );
  await mount();
  expect(await projectChoices()).toEqual(["All projects", "Project A", "Project B"]);
});

it.each([
  ["another account", "bob", 1],
  ["the same account", "alice", 0],
] as const)(
  "reads a page-two scope's first page once after %s answers it",
  async (_, viewer, restarts) => {
    const cursor = "github github.com org/repo";
    const otherCursor = "gitlab gitlab.com org/repo";
    const viewers = (name: string) => ({ "github github.com": name, "gitlab gitlab.com": "alice" });
    const other = { ...issue("G1"), tracker: IssueTrackerKind.make("gitlab"), host: "gitlab.com" };
    const first = answer([issue("A1"), other]);
    state.responses.set(
      environmentA,
      AsyncResult.success({
        ...first,
        trackers: [
          ...first.trackers,
          { ...first.trackers[0]!, tracker: other.tracker, host: other.host },
        ],
        viewers: viewers("alice"),
        nextCursors: { [cursor]: "2", [otherCursor]: "g2" },
      }),
    );
    state.responses.set(environmentB, AsyncResult.success(answer([])));
    state.listPage.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: { ...answer(input.cursors ? [] : [issue("B1")]), viewers: viewers(viewer) },
    }));
    await mount();
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Load more")!
        .click(),
    );
    const inputs = state.listPage.mock.calls.map(([target]) => target.input);
    expect(inputs).toHaveLength(1 + restarts);
    expect(inputs[0].cursors).toEqual({ [cursor]: "2" });
    for (const input of inputs.slice(1)) {
      expect(input.cursors).toBeUndefined();
      expect(input).toMatchObject({ projectId: "project", host: "github.com" });
    }
    expect(text()).toContain(restarts > 0 ? "Issue B1" : "Issue A1");
    expect(text()).toContain("Issue G1");
    expect(
      [...container.querySelectorAll("button")].filter(
        (button) => button.textContent === "Load more",
      ),
    ).toHaveLength(1);
    await mount();
    expect(state.listPage).toHaveBeenCalledTimes(1 + restarts);
  },
);

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

it("refreshes each first page over the last refreshed list, not the continuation", async () => {
  const cursor = "github github.com org/repo";
  const first = (keys: ReadonlyArray<string>) =>
    AsyncResult.success({ ...answer(keys.map(issue)), nextCursors: { [cursor]: "2" } });
  state.responses.set(environmentA, first(["1", "2"]));
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  state.listPage.mockResolvedValue({ _tag: "Success", value: answer([issue("3")]) });
  await mount();
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Load more")!
      .click(),
  );
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

it("toggles the issue panel with its advertised shortcut and keeps the URL in step", async () => {
  const selected = {
    environmentId: environmentA,
    projectId: "project",
    tracker: "github",
    host: "github.com",
    scope: "org/repo",
    key: "7",
  };
  useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, selected);
  state.responses.set(environmentA, AsyncResult.success(answer([])));
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  await mount();
  const isOpen = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ISSUES_PANEL_REF).isOpen;
  const press = () => {
    const event = new KeyboardEvent("keydown", {
      key: "b",
      code: "KeyB",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  const search = () =>
    state.navigate.mock.lastCall![0].search({ who: "all", status: "open", q: undefined });
  expect(press()).toBe(true);
  expect(isOpen()).toBe(false);
  expect(search()).toEqual({ who: "all", status: "open", q: undefined });
  expect(press()).toBe(true);
  expect(isOpen()).toBe(true);
  expect(search()).toMatchObject({
    selectedEnvironmentId: environmentA,
    selectedProjectId: "project",
    tracker: "github",
    scope: "org/repo",
    key: "7",
  });
  act(() => useRightPanelStore.getState().closeAllSurfaces(ISSUES_PANEL_REF));
  state.navigate.mockClear();
  expect(press()).toBe(false);
  expect(state.navigate).not.toHaveBeenCalled();
});

it("closes the active issue tab with the close shortcut and selects the next one", async () => {
  const selected = {
    environmentId: environmentA,
    projectId: "project",
    tracker: "github",
    host: "github.com",
    scope: "org/repo",
    key: "7",
  };
  useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, selected);
  useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, { ...selected, key: "8" });
  state.responses.set(environmentA, AsyncResult.success(answer([])));
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  await mount();
  const keys = () =>
    selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      ISSUES_PANEL_REF,
    ).surfaces.map((surface) => (surface.kind === "issue" ? surface.key : surface.id));
  const press = (init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  const handled = new KeyboardEvent("keydown", {
    key: "w",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  handled.preventDefault();
  act(() => {
    document.body.dispatchEvent(handled);
  });
  const palette = document.createElement("div");
  palette.dataset.commandPalette = "true";
  document.body.append(palette);
  expect(press()).toBe(false);
  palette.remove();
  expect(press({ repeat: true })).toBe(true);
  expect(keys()).toEqual(["7", "8"]);

  expect(press()).toBe(true);
  expect(keys()).toEqual(["7"]);
  expect(
    state.navigate.mock.lastCall![0].search({ who: "all", status: "open", q: undefined }),
  ).toMatchObject({ selectedEnvironmentId: environmentA, key: "7" });

  act(() => useRightPanelStore.getState().close(ISSUES_PANEL_REF));
  expect(press()).toBe(false);
  expect(keys()).toEqual(["7"]);
  act(() => useRightPanelStore.getState().closeAllSurfaces(ISSUES_PANEL_REF));
  expect(press()).toBe(false);
});

it("keeps rows and errors whose names repeat apart by their native identity", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const failure = (projectId: string, message: string) => ({
    projectId: ProjectId.make(projectId),
    projectTitle: "Project",
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    message,
  });
  state.responses.set(
    environmentA,
    AsyncResult.success({
      ...answer([
        {
          ...issue("1"),
          labels: ["W", "T"].map((id) => ({ id, name: "Bug", color: null })),
          assignees: ["a1", "a2"].map((id) => ({ id, login: "Sam", name: null, avatarUrl: null })),
        },
      ]),
      errors: [failure("one", "First failed"), failure("two", "Second failed")],
    }),
  );
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  await mount();
  expect(text()).toContain("Project: First failed");
  expect(text()).toContain("Project: Second failed");
  expect(error.mock.calls.flat().join(" ")).not.toContain("same key");
  error.mockRestore();
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
