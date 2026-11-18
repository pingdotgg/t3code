import appCss from "../index.css?inline";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import * as shelfHooks from "../state/olderSettledShelf";
import { createWorkspaceFocusController, workspaceAreaProps } from "../lib/workspaceFocus";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type LocalApi,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useServerConfigs, useQuietThreadShells } from "../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { readLocalApi } from "../localApi";
import type { Project } from "../types";
import { useWorkspaceStore } from "../workspaceStore";
import { newOrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { useOrbitThreadsAvailable } from "../orbit/environmentProvider";
import { OrbitPendingThreadList } from "../orbit/OrbitPendingThreadList";
import { updateStarts } from "../orbit/orbitThreadStartStore";
import { bindSidebarHiddenProfile } from "../orbit/sidebarHiddenThreads";
import { readSidebarThreadInventory } from "../orbit/sidebarInventory";
import { useSidebarOlderMembership } from "../orbit/sidebarOlderMembership";
import { unloadedOlderSettledCount } from "@t3tools/client-runtime/state/threads";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";

vi.mock(import("../state/olderSettledShelf"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useOlderSettledShelf: vi.fn(actual.useOlderSettledShelf),
    useUnloadedOlderSettled: vi.fn(actual.useUnloadedOlderSettled),
  };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../orbit/sidebarInventory", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../orbit/environmentProvider", { spy: true });
vi.mock("../hooks/useNowMinute", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock("../localApi", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "normal", count: 2, shift: false, picker: false, workspace: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    const previousWorkspaces = useWorkspaceStore.getState();
    stack.defer(() => useWorkspaceStore.setState(previousWorkspaces));
    useWorkspaceStore.setState({
      workspaces:
        "workspace" in scenario
          ? [
              {
                id: "selected",
                name: "Selected",
                color: "blue",
                icon: null,
                projectKeys: [],
                projectRefs: ["local:active"],
              },
            ]
          : [],
      activeWorkspaceId: "workspace" in scenario ? "selected" : null,
      availableProjects: [],
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    // Orbit mode: New thread is the only way in; the old cube button is gone.
    vi.mocked(useOrbitThreadsAvailable).mockReturnValue(true);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await vi.waitFor(() =>
      expect(useWorkspaceStore.getState().availableProjects).toHaveLength(scenario.count),
    );
    expect(
      screen.getByRole("button", { name: "New thread in an Orbit project" }).query(),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

describe("sidebar pending Orbit threads", () => {
  it("lists palette starts until the clone took the message, and links to their pending thread", async () => {
    vi.mocked(useOrbitThreadsAvailable).mockReturnValue(true);
    const base = (id: string, message: string) =>
      newOrbitThreadStart({
        id,
        project: { id: 66, slug: "create-bench", nodeName: "beast" },
        message,
        suffix: "x",
        threadId: `thread-${id}`,
        messageId: `message-${id}`,
        commandId: `command-${id}`,
        now: 0,
        instanceName: id,
        pendingThread: true,
      });
    window.localStorage.clear();
    updateStarts(() => [
      base("running", "Add a pricing page"),
      { ...base("failed", "Fix the login"), error: "The name is taken." },
      { ...base("sent", "Already handed over"), sentAt: 5 },
      // A start of the removed sidebar dialog shows as a pending thread too.
      { ...base("dialog", "Old dialog start"), pendingThread: false },
    ]);
    await using screen = await render(<OrbitPendingThreadList />, { router: "/orbit/running" });
    const rows = screen.getByRole("link");
    await expect.element(rows.first()).toHaveAttribute("href", "/orbit/running");
    expect(rows.all().map((row) => row.element().getAttribute("data-orbit-pending-row"))).toEqual([
      "running",
      "failed",
      "running",
    ]);
    await expect.element(screen.getByText("Setup failed")).toBeVisible();
    window.localStorage.clear();
    updateStarts(() => []);
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    threads.unshift(threadShell(activeProject.id, 100));
    // A real wall-clock minute tick mid-test re-renders every row and reads as a leak.
    vi.mocked(useNowMinute).mockReturnValue("2026-01-01T00:00");
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});

describe("sidebar thread rename", () => {
  // regression: #35151 an untouched rename wrote back the title it opened with over a newer one
  it.each(["{Enter}", "{Tab}"])(
    "ending an untouched rename with %s keeps a title that arrived while it was open",
    async (finish) => {
      const activeProject = project("active");
      const routeThreadRef: ScopedThreadRef = {
        environmentId: activeProject.environmentId,
        threadId: ThreadId.make("thread-0"),
      };
      const shellTitled = (title: string) => ({ ...threadShell(activeProject.id, 0), title });
      const updateMetadata = vi.fn().mockResolvedValue({ _tag: "Success" });
      vi.mocked(useOrchestrationCommand).mockReturnValue(updateMetadata);
      vi.mocked(readEnvironmentScope).mockReturnValue(true);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      vi.mocked(useProjects).mockReturnValue([activeProject]);
      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Fix the login redirect")]);
      vi.mocked(useThreadRouteTarget).mockReturnValue({
        kind: "server",
        threadRef: routeThreadRef,
      });
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: {
          environmentId: activeProject.environmentId,
          projectId: activeProject.id,
        },
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
      const tree = () => (
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      );
      await using screen = await render(tree());
      await userEvent.dblClick(screen.getByText("Fix the login redirect").first());
      const input = screen.getByRole("textbox", { name: "Thread title" });
      await expect.element(input).toHaveValue("Fix the login redirect");

      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Generated title")]);
      await screen.rerender(tree());
      await userEvent.keyboard(finish);

      await expect.element(input).not.toBeInTheDocument();
      expect(updateMetadata).not.toHaveBeenCalled();
    },
  );
});

describe("sidebar thread menu", () => {
  it("tells the menu whether the keyboard opened it", async () => {
    const activeProject = project("active");
    const thread = threadShell(activeProject.id, 0);
    const threadRef = { environmentId: activeProject.environmentId, threadId: thread.id };
    const show = vi.fn().mockResolvedValue(null);
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([thread]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const row = screen.getByText("Thread 0").first();
    await expect.element(row).toBeInTheDocument();
    row.element().closest<HTMLElement>("[data-sidebar-row]")!.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show.mock.lastCall?.[2]).toBe("keyboard");
    await userEvent.click(row, { button: "right" });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    expect(show.mock.lastCall?.[2]).toBe("mouse");
  });
});

describe("sidebar settled pagination", () => {
  it("keeps the viewport in place when showing more settled threads", async () => {
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const focusController = createWorkspaceFocusController(document);
    stack.defer(() => focusController.dispose());
    let loading = false;
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      loading,
      retry: () => {
        loading = true;
      },
    }));
    const activeProject = project("active");
    const threads = Array.from({ length: 70 }, (_, index) =>
      makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`settled-${index}`),
        title: `Settled thread ${index}`,
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          activeProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    await using screen = await render(
      <SidebarProvider
        {...workspaceAreaProps("sidebar", 0, "Threads")}
        style={{ height: 400, minHeight: 400 }}
      >
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const shelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if (shelf.getAttribute("aria-expanded") === "false") await act(() => shelf.click());
    const more = screen.getByRole("button", { name: "Show 25 more", exact: true });
    await expect.element(more).toBeInTheDocument();
    const moreButton = more.element() as HTMLButtonElement;
    const viewport = moreButton.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.style.height = "300px";
    viewport.style.maxHeight = "300px";
    moreButton.scrollIntoView({ block: "nearest" });
    const before = viewport.scrollTop;
    expect(before).toBeGreaterThan(0);
    moreButton.focus({ preventScroll: true });
    await act(() => moreButton.click());
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toHaveFocus();
    expect(viewport.scrollTop).toBe(before);
    const loadedRows = screen.container.querySelectorAll("[data-thread-item]").length;
    await act(() => moreButton.click());
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(loadedRows);
  });
});

describe("sidebar settled shelf with hidden threads", () => {
  const local = EnvironmentId.make("local");
  const settled = (projectId: ProjectId, id: string, settledAt: string) =>
    makeThreadFixture({
      environmentId: local,
      projectId,
      id: ThreadId.make(id),
      title: id,
      settledOverride: "settled",
      settledAt,
    });

  /** Renders the shelf over one environment whose shell left older settled threads out. */
  async function renderShelf(input: {
    readonly threads: EnvironmentThreadShell[];
    readonly older: Record<string, number>;
    readonly hidden: string[];
    readonly collapsed?: boolean;
  }) {
    const stack = new AsyncDisposableStack();
    const projects = Object.keys(input.older).map(project);
    const route = threadShell(projects[0]!.id, 100);
    const older = {
      before: "2026-01-05T00:00:00.000Z",
      beforeMs: Date.parse("2026-01-05T00:00:00.000Z"),
      counts: new Map(
        Object.entries(input.older).map(([id, count]) => [ProjectId.make(id), count]),
      ),
    };
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    stack.use(
      vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((shelfInput) => {
        const shelf = originalShelf(shelfInput);
        return {
          ...shelf,
          unloadedCount: (threads, only = shelf.scopes) =>
            unloadedOlderSettledCount({ olderSettled: () => older, scopes: only, threads }),
        };
      }),
    );
    const originalUnloaded = vi.mocked(shelfHooks.useUnloadedOlderSettled).getMockImplementation()!;
    stack.use(
      vi.spyOn(shelfHooks, "useUnloadedOlderSettled").mockImplementation((ids, threads) => {
        originalUnloaded(ids, threads);
        return {
          olderOf: () => older,
          unloaded: (member) =>
            unloadedOlderSettledCount({
              olderSettled: () => older,
              scopes: [
                {
                  environmentId: member.environmentId as EnvironmentId,
                  projectIds: [ProjectId.make(member.id)],
                },
              ],
              threads,
            }),
        };
      }),
    );
    useSidebarOlderMembership.setState({ byEnvironment: new Map(), reading: new Map() });
    window.localStorage.setItem(
      "t3code:sidebar-hidden-threads:v2:agreed:1",
      JSON.stringify(input.hidden.map((id) => `local:${id}`)),
    );
    bindSidebarHiddenProfile(1);
    stack.defer(() => {
      window.localStorage.removeItem("t3code:sidebar-hidden-threads:v2:agreed:1");
      bindSidebarHiddenProfile(null);
    });
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useQuietThreadShells).mockReturnValue([route, ...input.threads]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: local, threadId: route.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId: local, projectId: projects[0]!.id },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: local, threadId: route.id },
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          local,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
            environment: { capabilities: {} },
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    const screen = stack.use(
      await render(
        <SidebarProvider style={{ height: 600, minHeight: 600 }}>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>,
      ),
    );
    const shelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if ((shelf.getAttribute("aria-expanded") === "true") === Boolean(input.collapsed)) {
      await act(() => shelf.click());
    }
    const owned = stack.move();
    return {
      shelfExpanded: () => shelf.getAttribute("aria-expanded"),
      scopeOptions: async () => {
        await userEvent.click(
          screen.container.querySelector<HTMLElement>('[aria-label="Filter threads by project"]')!,
        );
        // Each project row starts with its favicon's initials.
        const options = [...document.querySelectorAll('[role="option"]')].map((option) =>
          option.textContent?.replace(/^P\d/, ""),
        );
        await userEvent.keyboard("{Escape}");
        return options;
      },
      count: () => shelf.querySelector(".tabular-nums")?.textContent,
      more: () =>
        screen.container.querySelector('[data-sidebar-row="settled:more"]')?.textContent ?? null,
      [Symbol.asyncDispose]: () => owned.disposeAsync(),
    };
  }

  const p1 = ProjectId.make("p1");

  it("counts and pages an ordinary shelf without marks", async () => {
    await using shelf = await renderShelf({
      threads: [settled(p1, "s1", "2026-01-10T00:00:00.000Z")],
      older: { p1: 1 },
      hidden: [],
    });
    await vi.waitFor(() => expect(shelf.more()).toBe("Show 1 more"));
    expect(shelf.count()).toBe("2");
  });

  it("offers no more when the only older thread was read and is hidden", async () => {
    await using shelf = await renderShelf({
      threads: [
        settled(p1, "s1", "2026-01-10T00:00:00.000Z"),
        settled(p1, "o1", "2026-01-01T00:00:00.000Z"),
      ],
      older: { p1: 1 },
      hidden: ["o1"],
    });
    await vi.waitFor(() => expect(shelf.count()).toBe("1"));
    expect(shelf.more()).toBeNull();
  });

  it("pages towards a visible older thread past a hidden one in another project", async () => {
    // o1 in p1 is hidden but not read yet; p2 has one visible older thread.
    {
      await using shelf = await renderShelf({
        threads: [settled(p1, "s1", "2026-01-10T00:00:00.000Z")],
        older: { p1: 1, p2: 1 },
        hidden: ["o1"],
      });
      await vi.waitFor(() => expect(shelf.more()).toBe("Show more"));
      expect(shelf.count()).toBeUndefined();
    }
    // Once o1 is read, the count is exact.
    await using shelf = await renderShelf({
      threads: [
        settled(p1, "s1", "2026-01-10T00:00:00.000Z"),
        settled(p1, "o1", "2026-01-01T00:00:00.000Z"),
      ],
      older: { p1: 1, p2: 1 },
      hidden: ["o1"],
    });
    await vi.waitFor(() => expect(shelf.more()).toBe("Show 1 more"));
    expect(shelf.count()).toBe("2");
  });

  it("keeps projects out of the scope menu until a full read shows an older thread", async () => {
    // p2 and p3 each hold one unloaded older thread; the unplaced mark o2 could be either.
    const read = Promise.withResolvers<EnvironmentThreadShell["source"][] | null>();
    using _read = vi.mocked(readSidebarThreadInventory).mockReturnValue(read.promise);
    await using shelf = await renderShelf({
      threads: [],
      older: { p1: 0, p2: 1, p3: 1 },
      hidden: ["o2"],
      collapsed: true,
    });
    expect(await shelf.scopeOptions()).toEqual(["All projects", "p1"]);
    await vi.waitFor(() => expect(readSidebarThreadInventory).toHaveBeenCalledTimes(1));
    read.resolve([
      settled(ProjectId.make("p2"), "o2", "2026-01-01T00:00:00.000Z").source,
      settled(ProjectId.make("p3"), "o3", "2026-01-01T00:00:00.000Z").source,
    ]);
    // o2 is p2's only older thread: p2 stays out; p3's older thread shows, with Settled shut.
    await vi.waitFor(async () =>
      expect(await shelf.scopeOptions()).toEqual(["All projects", "p1", "p3"]),
    );
    expect(shelf.shelfExpanded()).toBe("false");
    expect(readSidebarThreadInventory).toHaveBeenCalledTimes(1);
  });
});
