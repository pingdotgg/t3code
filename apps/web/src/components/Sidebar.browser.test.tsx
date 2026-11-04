import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { useEnvironmentConnectionSummaries } from "../state/environments";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
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
    { mode: "legacy", count: 2, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
      legacySidebarEnabled: scenario.mode === "legacy",
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

describe("Working shelf connections", () => {
  it("keeps running and waiting threads shelved through reconnects and resubscription", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => {
      __setClientSettingsForTests(previousSettings);
      vi.mocked(useQuietThreadShells).mockRestore();
      vi.mocked(useEnvironmentConnectionSummaries).mockRestore();
    });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarWorkingShelfEnabled: true,
    });
    const remote = project("remote");
    const runtime = {
      status: "running" as const,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-11-04T10:00:00.000Z",
    };
    const thread = (id: string) =>
      makeThreadFixture({
        id: ThreadId.make(id),
        title: id,
        projectId: remote.id,
        environmentId: remote.environmentId,
      });
    vi.mocked(useProjects).mockReturnValue([remote]);
    vi.mocked(useQuietThreadShells).mockReturnValue([
      { ...thread("Running remotely"), runtime },
      {
        ...thread("Waiting remotely"),
        runtime: { ...runtime, status: "idle" },
        pendingBackgroundTasks: [
          { taskId: "background", description: "Watch build", kind: "monitor", awaited: true },
        ],
      },
      thread("Ready for input"),
    ]);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: null,
      handleNewThread: vi.fn(),
      routeDraftId: null,
      routeThreadRef: null,
    });
    const connection = {
      environmentId: remote.environmentId,
      environmentLabel: "Remote",
      displayUrl: "https://remote.example",
      isRelayManaged: true,
      isEnabled: true,
      connectionError: null,
      connectionErrorTraceId: null,
    };
    vi.mocked(useEnvironmentConnectionSummaries).mockReturnValue([
      { ...connection, connectionState: "connecting" },
    ]);
    const sidebar = () => (
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>
    );
    await using screen = await render(sidebar());
    await expect.element(screen.getByRole("button", { name: /^Working\s*2$/ })).toBeInTheDocument();

    for (const connectionState of ["reconnecting", "connected", "offline", "connecting"] as const) {
      vi.mocked(useEnvironmentConnectionSummaries).mockReturnValue([
        { ...connection, connectionState },
      ]);
      await screen.rerender(sidebar());
      await expect
        .element(screen.getByRole("button", { name: /^Working\s*2$/ }))
        .toBeInTheDocument();
      await expect
        .element(screen.getByRole("button", { name: /^Running remotely,/ }))
        .not.toBeInTheDocument();
      await expect
        .element(screen.getByRole("button", { name: /^Waiting remotely,/ }))
        .not.toBeInTheDocument();
      await expect
        .element(screen.getByRole("button", { name: "Ready for input, remote", exact: true }))
        .toBeInTheDocument();
    }
  });
});
