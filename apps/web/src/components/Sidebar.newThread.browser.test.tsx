import type { AnyRouter } from "@tanstack/react-router";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import "~/index.css";

const newThreadState = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  legacySidebarEnabled: false,
  handleNewThread: vi.fn(async () => null),
  startScratchThread: vi.fn(async () => undefined),
}));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => newThreadState.projects,
  readProjects: () => newThreadState.projects,
  useThreadShells: () => [],
  useServerConfigs: () => new Map(),
  useAllEnvironmentProjectSnapshotsReady: () => true,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("local"),
  useEnvironmentIdentities: () => [],
  useEnvironmentMachines: () => new Map(),
  useConnectedEnvironmentIds: () => [],
  useEnvironmentProviders: () => new Map(),
  useEnvironments: (() => ({ environments: [] })) as never,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return {
    ...actual,
    primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS),
    primaryServerProvidersAtom: Atom.make([]),
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((select?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
  useBoringSidebarEnabled: () => newThreadState.legacySidebarEnabled,
  getClientSettings: () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    legacySidebarEnabled: newThreadState.legacySidebarEnabled,
  }),
}));
vi.mock(import("../hooks/useHandleNewThread"), () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    routeDraftId: null,
    routeThreadRef: null,
    defaultProjectRef: {
      environmentId: EnvironmentId.make("local"),
      projectId: ProjectId.make("only-project"),
    },
    handleNewThread: newThreadState.handleNewThread,
  }),
  useNewThreadHandler: () => newThreadState.handleNewThread,
  createNewThreadHandler: () => newThreadState.handleNewThread,
  resolveDefaultProjectRef: () => ({
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("only-project"),
  }),
}));
vi.mock(import("../hooks/useScratchProject"), () => {
  const actions = () => ({
    scratchEnvironmentId: () => EnvironmentId.make("local"),
    scratchWorkspaceRootFor: () => "/scratch",
    startScratchThread: newThreadState.startScratchThread,
    openScratchProject: vi.fn(async () => null),
  });
  return { useScratchProject: actions, createScratchProjectActions: actions };
});
vi.mock(import("../hooks/useThreadRouteTarget"), () => ({ useThreadRouteTarget: () => null }));
vi.mock(import("../state/queries"), async (original) => ({
  ...(await original()),
  useThreadSearch: (() => ({ query: "", matches: [], isPending: false })) as never,
}));
vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: null, isPending: false })) as never,
}));
vi.mock(import("../state/use-atom-command"), () => ({ useAtomCommand: () => vi.fn() }));
vi.mock(import("../state/use-atom-query-runner"), () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock(import("../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../hooks/useThreadActions"), () => ({
  useThreadActions: (() => ({})) as never,
  useAcknowledgeThreadWoke: () => vi.fn(),
  canTurnThreadIntoProject: () => false,
}));
vi.mock(import("../hooks/useNewProject"), () => ({ useNewProject: () => vi.fn() }));
vi.mock(import("../connection/useDesktopLocalBootstraps"), () => ({
  useDesktopLocalBootstraps: () => [],
}));
vi.mock(import("./sidebar/SidebarChrome"), async () => {
  const { memo } = await import("react");
  return {
    SidebarChromeHeader: memo(() => <></>),
    SidebarChromeFooter: memo(() => <></>),
  };
});
vi.mock(import("./files/ProjectFilePicker"), () => ({ ProjectFilePicker: () => <></> }));
vi.mock(import("./search/ProjectContentSearchDialog"), () => ({
  ProjectContentSearchDialog: () => <></>,
}));

import { installChatRouteCommands } from "../shortcuts/chatRouteCommands";
import { useUiStateStore } from "../uiStateStore";
import { CommandPalette } from "./CommandPalette";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

function installNewThreadCommands() {
  const router = {
    state: { matches: [{ routeId: "/_chat", pathname: "/", params: {} }] },
  } as unknown as AnyRouter;
  return { [Symbol.dispose]: installChatRouteCommands(router) };
}

function setupNewThread() {
  vi.clearAllMocks();
  newThreadState.legacySidebarEnabled = false;
  newThreadState.projects = [
    {
      environmentId: EnvironmentId.make("local"),
      id: ProjectId.make("only-project"),
      title: "Only project",
      workspaceRoot: "/work/only-project",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      defaultModelSelection: null,
      scripts: [],
    },
  ];
  useUiStateStore.setState({ projectOrder: [], sidebarProjectScopeKeys: [] });
}

function newThreadUi() {
  return (
    <SidebarProvider>
      <CommandPalette>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </CommandPalette>
    </SidebarProvider>
  );
}

function pressNewThread(shiftKey = false) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "n",
      ctrlKey: true,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("one-project new thread picker", () => {
  it.each(["click", "shortcut"] as const)(
    "offers and starts No project from the ordinary %s with one project",
    async (entry) => {
      setupNewThread();
      using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
      await using screen = await render(newThreadUi());
      using _commands = installNewThreadCommands();

      if (entry === "click") {
        await screen.getByRole("button", { name: "New thread", exact: true }).click();
      } else {
        await act(() => pressNewThread());
      }

      const picker = page.getByRole("dialog", { name: "Command palette" });
      await expect.element(picker.getByRole("option", { name: /Only project/ })).toBeVisible();
      await picker.getByRole("option", { name: /No project/ }).click();
      await vi.waitFor(() => {
        expect(newThreadState.startScratchThread).toHaveBeenCalledExactlyOnceWith("local");
      });
      expect(newThreadState.handleNewThread).not.toHaveBeenCalled();
      await expect.element(picker).not.toBeInTheDocument();
    },
  );

  it.each(["shift-click", "current-project shortcut", "legacy shortcut"] as const)(
    "keeps %s starting in the current project",
    async (entry) => {
      setupNewThread();
      newThreadState.legacySidebarEnabled = entry === "legacy shortcut";
      using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
      await using screen = await render(newThreadUi());
      using _commands = installNewThreadCommands();

      if (entry === "shift-click") {
        await screen.getByRole("button", { name: "New thread", exact: true }).click({
          modifiers: ["Shift"],
        });
      } else {
        await act(() => pressNewThread(entry === "current-project shortcut"));
      }

      await vi.waitFor(() => {
        expect(newThreadState.handleNewThread).toHaveBeenCalledExactlyOnceWith({
          environmentId: "local",
          projectId: "only-project",
        });
      });
      expect(newThreadState.startScratchThread).not.toHaveBeenCalled();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    },
  );
});
