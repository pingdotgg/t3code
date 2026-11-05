import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects } from "../state/entities";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The default jumps are desktop-only; the test runs in a browser.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
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

// regression: unsent drafts were listed above threads but skipped by mod+1..9.
describe("sidebar numbered jumps", () => {
  it("number unsent drafts from the top, keep the open draft's number, and open them", async () => {
    const initial = useComposerDraftStore.getState();
    using stack = new DisposableStack();
    stack.defer(() => useComposerDraftStore.setState(initial, true));
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const web = project("web");
    vi.mocked(useProjects).mockReturnValue([web]);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: null,
      handleNewThread: vi.fn(),
      routeDraftId: null,
      routeThreadRef: null,
    });
    const projectRef = scopeProjectRef(web.environmentId, web.id);
    const older = DraftId.make("older-draft");
    const newer = DraftId.make("newer-draft");
    // The newer draft is open; the test router has no draft route to read it from.
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "draft", draftId: newer });
    stack.defer(() => vi.mocked(useThreadRouteTarget).mockRestore());
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    for (const [draftId, createdAt] of [
      [older, "2026-01-01T00:00:00.000Z"],
      [newer, "2026-01-02T00:00:00.000Z"],
    ] as const) {
      initial.setProjectDraftThreadId(projectRef, draftId, {
        threadId: ThreadId.make(`${draftId}-thread`),
        createdAt,
      });
      initial.setPrompt(draftId, `${draftId} prompt`);
    }

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const rows = screen.getByTestId("sidebar-draft-row");
    await expect.element(rows.nth(1)).toHaveAccessibleName("older-draft prompt, Unsent draft, web");
    await userEvent.keyboard("{Control>}");
    await expect.element(rows.nth(0).getByText("Ctrl+1")).toBeVisible();
    await expect.element(rows.nth(1).getByText("Ctrl+2")).toBeVisible();
    await userEvent.keyboard("{/Control}");

    // Clearing the open draft keeps its row and number, even after search hides the list.
    await act(() => initial.setPrompt(newer, ""));
    const search = screen.getByRole("combobox", { name: "Search threads" });
    await userEvent.fill(search, "older");
    await expect.element(rows.first()).not.toBeInTheDocument();
    await userEvent.clear(search);
    await expect.element(rows.nth(0)).toHaveAccessibleName("newer-draft prompt, Unsent draft, web");
    await userEvent.keyboard("{Control>}");
    await expect.element(rows.nth(0).getByText("Ctrl+1")).toBeVisible();
    await expect.element(rows.nth(1).getByText("Ctrl+2")).toBeVisible();
    await userEvent.keyboard("2{/Control}");

    await vi.waitFor(() => expect(screen.router!.state.location.pathname).toBe(`/draft/${older}`));
  });
});
