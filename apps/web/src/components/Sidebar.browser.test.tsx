import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects, useQuietThreadShells, useServerConfigs } from "../state/entities";
import { useConnectedEnvironmentIds } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const environmentId = EnvironmentId.make("local");

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

function clientSettings(mode: "normal" | "boring" | "legacy"): Disposable {
  const previous = getClientSettings();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: mode === "boring",
    legacySidebarEnabled: mode === "legacy",
  });
  return { [Symbol.dispose]: () => __setClientSettingsForTests(previous) };
}

function mockNewThread(projects: readonly Project[]) {
  const defaultProjectRef = {
    environmentId: projects[0]!.environmentId,
    projectId: projects[0]!.id,
  };
  const startThread = vi.fn().mockResolvedValue(null);
  vi.mocked(useProjects).mockReturnValue(projects);
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef,
    handleNewThread: startThread,
    routeDraftId: null,
    routeThreadRef: null,
  });
  return { defaultProjectRef, startThread };
}

function renderSidebar() {
  return render(
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
    { mode: "legacy", count: 2, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using _settings = clientSettings(scenario.mode);
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const { defaultProjectRef, startThread } = mockNewThread(projects);
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(defaultProjectRef);
    }
  });
});

describe("sidebar drag reorder", () => {
  // Folders own the active order, so they gate dragging only while one renders.
  it.each([
    { mode: "normal", folders: false, draggable: true },
    { mode: "boring", folders: false, draggable: true },
    { mode: "boring", folders: true, draggable: false },
  ] as const)(
    "$mode sidebar, folders=$folders: pinned rows draggable=$draggable",
    async (scenario) => {
      using _settings = clientSettings(scenario.mode);
      const alpha = project("alpha");
      const thread = (id: string, pinnedAt: string | null) =>
        makeThreadFixture({
          id: ThreadId.make(id),
          environmentId,
          projectId: alpha.id,
          title: id,
          pinnedAt,
        });
      mockNewThread([alpha]);
      vi.mocked(useQuietThreadShells).mockReturnValue([
        thread("first", "2026-01-01T00:00:00.000Z"),
        thread("second", "2026-01-01T00:01:00.000Z"),
        ...(scenario.folders ? [thread("open", null)] : []),
      ]);
      vi.mocked(useServerConfigs).mockReturnValue(new Map([[environmentId, {} as never]]));
      vi.mocked(useConnectedEnvironmentIds).mockReturnValue([environmentId]);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      await using screen = await renderSidebar();

      const row = screen.container.querySelector<HTMLElement>(
        `[data-thread-item="${environmentId}:first"]`,
      );
      expect(row).not.toBeNull();
      const pointer = (type: string, clientY: number) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: 10,
          clientY,
        });
      await act(() => row!.dispatchEvent(pointer("pointerdown", 10)));
      await act(() => document.dispatchEvent(pointer("pointermove", 40)));

      expect(row!.classList.contains("z-20")).toBe(scenario.draggable);
      await act(() => document.dispatchEvent(pointer("pointerup", 40)));
    },
  );
});
