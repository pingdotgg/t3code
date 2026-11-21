import appCss from "../index.css?inline";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as shelfHooks from "../state/olderSettledShelf";
import { createWorkspaceFocusController, workspaceAreaProps } from "../lib/workspaceFocus";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type LocalApi,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useShownThreadRouteTarget } from "../hooks/useShownThreadRouteTarget";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useServerConfigs, useQuietThreadShells } from "../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { readLocalApi } from "../localApi";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";

vi.mock(import("../state/olderSettledShelf"), async (original) => {
  const actual = await original();
  return { ...actual, useOlderSettledShelf: vi.fn(actual.useOlderSettledShelf) };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useNowMinute", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("../hooks/useShownThreadRouteTarget", { spy: true });
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
    { key: "mod+shift+[", command: "thread.previous" },
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
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

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

// regression: #38623 unsent drafts are listed above threads but mod+1..9 skipped them
describe("sidebar numbered jumps", () => {
  it("numbers the unsent draft at the top before the threads below it", async () => {
    const initial = useComposerDraftStore.getState();
    using stack = new DisposableStack();
    stack.defer(() => useComposerDraftStore.setState(initial, true));
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const web = project("web");
    vi.mocked(useProjects).mockReturnValue([web]);
    const thread = threadShell(web.id, 0);
    vi.mocked(useQuietThreadShells).mockReturnValue([thread]);
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: null,
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn(),
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    const draftId = DraftId.make("unsent-draft");
    initial.setProjectDraftThreadId(scopeProjectRef(web.environmentId, web.id), draftId, {
      threadId: ThreadId.make("unsent-draft-thread"),
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    initial.setPrompt(draftId, "Unsent prompt");

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const draftRow = screen.getByTestId("sidebar-draft-row");
    await expect.element(draftRow).toBeInTheDocument();
    await expect.element(screen.getByText("Thread 0").first()).toBeInTheDocument();
    await userEvent.keyboard("{Control>}");
    await expect.element(screen.getByText("Ctrl+1")).toBeVisible();
    await expect.element(draftRow.getByText("Ctrl+1")).toBeVisible();
    await expect.element(screen.getByText("Ctrl+2")).toBeVisible();
    await userEvent.keyboard("{/Control}");

    // Previous thread from the open thread steps up to the draft above it.
    await userEvent.keyboard("{Control>}{Shift>}{BracketLeft}{/Shift}{/Control}");
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toBe(`/draft/${draftId}`),
    );
    await userEvent.keyboard("{Control>}2{/Control}");
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).not.toBe(`/draft/${draftId}`),
    );
    await userEvent.keyboard("{Control>}1{/Control}");
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toBe(`/draft/${draftId}`),
    );
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

describe("sidebar status shelf collapse", () => {
  it.each(["working", "input"] as const)(
    "hides the open thread when its %s shelf is collapsed and restores it on expansion",
    async (section) => {
      using stack = new DisposableStack();
      const previousSettings = getClientSettings();
      stack.defer(() => __setClientSettingsForTests(previousSettings));
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        boringSidebarEnabled: false,
        sidebarWorkingShelfEnabled: true,
      });
      const activeProject = project("collapse-project");
      const thread = makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`collapse-${section}`),
        title: `Open ${section} thread`,
        hasPendingUserInput: section === "input",
        runtime: {
          status: "running",
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      const routeThreadRef = { environmentId: thread.environmentId, threadId: thread.id };
      vi.mocked(useProjects).mockReturnValue([activeProject]);
      const adjacentThread = makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make("adjacent-thread"),
        title: "Adjacent active thread",
      });
      const snoozedThread = {
        ...makeThreadFixture({
          environmentId: activeProject.environmentId,
          projectId: activeProject.id,
          id: ThreadId.make("snoozed-thread"),
          title: "Snoozed range endpoint",
        }),
        snoozedAt: "2025-12-31T00:00:00.000Z",
        snoozedUntil: "2099-01-02T00:00:00.000Z",
      };
      vi.mocked(useQuietThreadShells).mockReturnValue([adjacentThread, thread, snoozedThread]);
      vi.mocked(useServerConfigs).mockReturnValue(
        new Map([[activeProject.environmentId, {} as EnvironmentServerConfig]]),
      );
      stack.defer(() => vi.mocked(useServerConfigs).mockRestore());
      vi.mocked(useNowMinute).mockReturnValue("2026-01-01T00:00");
      vi.mocked(useShownThreadRouteTarget).mockReturnValue({
        shownTarget: { kind: "server", threadRef: routeThreadRef },
        modalOpen: false,
      });
      stack.defer(() => vi.mocked(useShownThreadRouteTarget).mockRestore());
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
      await using screen = await render(
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>,
      );
      using navigation = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
      const snoozedToggle = screen.getByTestId("sidebar-snoozed-shelf-toggle");
      snoozedToggle.element().focus();
      await userEvent.keyboard("{ArrowLeft}");
      const toggle = screen.getByTestId(`sidebar-${section}-shelf-toggle`);
      toggle.element().focus();
      await userEvent.keyboard("{ArrowRight}");
      await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
      const row = screen.getByText(thread.title, { exact: true });
      await expect.element(row).toBeInTheDocument();
      await userEvent.keyboard("{ArrowLeft}");
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      await expect.element(row).not.toBeInTheDocument();
      await userEvent.keyboard(
        isMacPlatform(navigator.platform)
          ? "{Meta>}{Shift>}[[{/Shift}{/Meta}"
          : "{Control>}{Shift>}[[{/Shift}{/Control}",
      );
      expect(navigation).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { environmentId: adjacentThread.environmentId, threadId: adjacentThread.id },
        }),
      );
      using _selection = {
        [Symbol.dispose]: () => useThreadSelectionStore.getState().clearSelection(),
      };
      const adjacentRow = screen.getByText(adjacentThread.title, { exact: true });
      const mod = isMacPlatform(navigator.platform) ? "Meta" : "Control";
      snoozedToggle.element().focus();
      await userEvent.keyboard("{ArrowRight}");
      const snoozedRow = screen.getByText(snoozedThread.title, { exact: true });
      await expect.element(snoozedRow).toBeInTheDocument();
      await userEvent.keyboard(`{${mod}>}`);
      await userEvent.click(adjacentRow);
      await userEvent.keyboard(`{/${mod}}{Shift>}`);
      await userEvent.click(snoozedRow);
      await userEvent.keyboard("{/Shift}");
      expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(2);
      useThreadSelectionStore.getState().clearSelection();

      navigation.mockClear();
      await userEvent.keyboard(`{${mod}>}2{/${mod}}`);
      expect(navigation).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { environmentId: snoozedThread.environmentId, threadId: snoozedThread.id },
        }),
      );
      toggle.element().focus();
      await userEvent.keyboard("{ArrowRight}");
      await expect.element(row).toBeInTheDocument();
      await expect.element(toggle).toHaveAttribute("aria-expanded", "true");

      const adjacentRef = {
        environmentId: adjacentThread.environmentId,
        threadId: adjacentThread.id,
      };
      vi.mocked(useShownThreadRouteTarget).mockReturnValue({
        shownTarget: { kind: "server", threadRef: adjacentRef },
        modalOpen: false,
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
        routeThreadRef: adjacentRef,
      });
      await screen.rerender(
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>,
      );
      const show = vi.fn().mockResolvedValue(null);
      vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
      await userEvent.keyboard(`{${mod}>}`);
      await userEvent.click(row);
      await userEvent.click(adjacentRow);
      await userEvent.keyboard(`{/${mod}}`);
      await userEvent.click(toggle);
      await expect.element(row).not.toBeInTheDocument();
      expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(2);
      await userEvent.click(adjacentRow, { button: "right" });
      await vi.waitFor(() => expect(show).toHaveBeenCalled());
      expect(show.mock.lastCall?.[0]).toContainEqual(
        expect.objectContaining({ id: "settle", label: "Settle (2)" }),
      );
    },
  );
});

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
  it.each([false, true])(
    "keeps the viewport in place when showing more settled threads (fixed=%s)",
    async (fixed) => {
      using stack = new DisposableStack();
      const previousSettings = getClientSettings();
      stack.defer(() => __setClientSettingsForTests(previousSettings));
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, sidebarSettledShelfFixed: fixed });
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
      const activeViewport = screen.container
        .querySelector('[data-sidebar-list="active"]')
        ?.closest('[data-slot="scroll-area-viewport"]');
      expect(activeViewport).toBeInstanceOf(HTMLElement);
      expect(viewport === activeViewport).toBe(!fixed);
      viewport.style.height = "300px";
      viewport.style.maxHeight = "300px";
      await vi.waitFor(() => {
        moreButton.scrollIntoView({ block: "nearest" });
        expect(viewport.scrollTop).toBeGreaterThan(0);
      });
      const before = viewport.scrollTop;
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
    },
  );
});
