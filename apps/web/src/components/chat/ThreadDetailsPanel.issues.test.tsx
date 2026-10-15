// @vitest-environment jsdom

import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { act, cloneElement, isValidElement, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  density: "full" as "full" | "compact" | "essential",
  draft: false,
  thread: {
    environmentId: "env",
    id: "thread",
    projectId: "project",
    branch: null,
    worktreePath: null,
    runtime: null,
    pullRequests: [],
    issues: [] as ReadonlyArray<ThreadIssueLink>,
  },
  project: {
    environmentId: "env",
    id: "project",
    title: "Plain folder",
    workspaceRoot: "/plain",
    repositoryIdentity: null,
  },
  command: vi.fn(),
}));
vi.mock("../../state/entities", () => ({
  useProject: () => state.project,
  useThreadShell: () => (state.draft ? null : state.thread),
  useThreadShellsForProjectRefs: () => [],
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../../state/queries", () => ({
  usePaginatedBranches: () => ({
    refs: [],
    data: null,
    isPending: false,
    isFetchingNextPage: false,
    loadNext: vi.fn(),
  }),
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { stopSession: {}, updateMetadata: {} },
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { status: () => null, listRefs: () => null, switchRef: {}, createRef: {} },
}));
vi.mock("../../hooks/useT3ProjectFileScripts", () => ({ useT3ProjectFileScripts: () => [] }));
vi.mock("../../hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("../ThreadStatusIndicators", () => ({
  useLinkedThreadPullRequest: () => null,
  prStatusIndicator: () => null,
  resolveThreadPullRequestBadge: () => null,
  ThreadPullRequestBadgeControl: () => null,
}));
vi.mock("./composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({
    children,
  }: ComponentProps<typeof import("./ThreadDetailsCard").ThreadDetailsCard>) =>
    children(state.density),
}));
vi.mock("./ThreadAutomationsPanel", () => ({ ThreadAutomationsPanel: () => null }));
vi.mock("./ThreadRelationshipsControl", () => ({ ThreadRelationshipsPanel: () => null }));
vi.mock("../GitActionsControl", () => ({ default: () => null }));
vi.mock("./OpenInPicker", () => ({ OpenInPicker: () => null }));
vi.mock("../ProjectScriptsControl", () => ({ default: () => null }));
vi.mock("../BranchToolbarEnvironmentSelector", () => ({
  BranchToolbarEnvironmentSelector: () => null,
}));
vi.mock("../BranchToolbarEnvModeSelector", () => ({ BranchToolbarEnvModeSelector: () => null }));
vi.mock("../BranchPicker", () => ({
  BranchPicker: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BranchPickerRefItem: () => null,
}));
vi.mock("../ui/combobox", () => ({
  ComboboxTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  ComboboxItem: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render,
    children,
  }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) =>
    isValidElement(render) ? cloneElement(render, undefined, children) : <>{children}</>,
  TooltipPopup: () => null,
}));

import { useRightPanelStore } from "../../rightPanelStore";
import { BranchToolbar } from "../BranchToolbar";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import { PopoverCreateHandle } from "../ui/popover";
import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const props: ThreadDetailsPanelProps = {
  anchor: { current: null },
  handle: PopoverCreateHandle(),
  onPresentationChange: vi.fn(),
  environmentId: threadRef.environmentId,
  threadId: threadRef.threadId,
  activeProjectName: "Plain folder",
  activeProjectScripts: undefined,
  preferredScriptId: null,
  keybindings: [],
  availableEditors: [],
  showOpenInPicker: false,
  gitCwd: "/plain",
  isGitRepo: true,
  envLocked: true,
  availableEnvironments: [],
  onEnvironmentChange: vi.fn(),
  onEnvModeChange: vi.fn(),
  envMode: "local",
  startFromOrigin: false,
  onStartFromOriginChange: vi.fn(),
  onComposerFocusRequest: vi.fn(),
  onRunProjectScript: vi.fn(),
  onAddProjectScript: vi.fn(),
  onUpdateProjectScript: vi.fn(),
  onDeleteProjectScript: vi.fn(),
};
let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.density = "full";
  state.draft = false;
  state.command.mockReset();
  state.thread.issues = [
    {
      tracker: IssueTrackerKind.make("linear"),
      host: "linear.app",
      scope: "workspace/ENG",
      key: "ENG-7",
      projectId: ProjectId.make("project"),
      url: "https://linear.app/workspace/issue/ENG-7",
      source: "manual",
      linkedAt: "2026-10-14T00:00:00Z",
      snapshot: {
        displayKey: "ENG-7",
        title: "Saved issue",
        state: { category: "open", name: "Todo" },
        syncedAt: "2026-10-14T00:00:00Z",
      },
    },
  ];
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  vi.unstubAllGlobals();
});

it.each(["linear", "jira"])(
  "keeps a saved %s issue reachable with Git on, off, or no Git directory",
  async (tracker) => {
    const saved = state.thread.issues[0]!;
    const link = {
      ...saved,
      tracker: IssueTrackerKind.make(tracker),
      host: tracker === "jira" ? "acme.atlassian.net" : saved.host,
      url: tracker === "jira" ? "https://acme.atlassian.net/browse/ENG-7" : saved.url,
    };
    state.thread.issues = [link];
    for (const [isGitRepo, gitCwd] of [
      [true, "/plain"],
      [false, "/plain"],
      [false, null],
      [true, null],
    ] as const) {
      await act(async () =>
        root.render(<ThreadDetailsPanel {...props} isGitRepo={isGitRepo} gitCwd={gitCwd} />),
      );
      const rows = element.querySelectorAll<HTMLButtonElement>(`button[aria-label="${link.url}"]`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain("ENG-7: Saved issue");
      expect(rows[0]?.closest("section")?.getAttribute("aria-label")).toBe(
        isGitRepo && gitCwd ? "Version Control" : "Workspace",
      );
      expect(element.querySelectorAll(".lucide-git-branch")).toHaveLength(
        isGitRepo && gitCwd ? 1 : 0,
      );
      await act(async () => rows[0]!.click());
      expect(
        useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.surfaces,
      ).toEqual([
        expect.objectContaining({
          kind: "issue",
          projectId: link.projectId,
          tracker: link.tracker,
          host: link.host,
          scope: link.scope,
          key: link.key,
          url: link.url,
        }),
      ]);
      expect(state.command).not.toHaveBeenCalled();
    }
  },
);

it.each(["full", "compact", "essential"] as const)(
  "shows saved issue rows without Git at %s density",
  async (density) => {
    state.density = density;
    await act(async () => root.render(<ThreadDetailsPanel {...props} isGitRepo={false} />));
    const rows = element.querySelectorAll(`button[aria-label="${state.thread.issues[0]!.url}"]`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closest("section")?.getAttribute("aria-label")).toBe("Workspace");
  },
);

it.each(["branch", "all", "workspace"] as const)(
  "keeps other panel toolbar callers at one issue row for %s",
  async (panelSection) => {
    await act(async () =>
      root.render(
        <BranchToolbar {...props} layout="panel" showGitControls panelSection={panelSection} />,
      ),
    );
    expect(
      element.querySelectorAll(`button[aria-label="${state.thread.issues[0]!.url}"]`),
    ).toHaveLength(panelSection === "workspace" ? 0 : 1);
  },
);

it("keeps issue rows out of the composer branch selector", async () => {
  await act(async () =>
    root.render(<BranchToolbarBranchSelector {...props} displayMode="toolbar" />),
  );
  expect(
    element.querySelectorAll(`button[aria-label="${state.thread.issues[0]!.url}"]`),
  ).toHaveLength(0);
});

it("shows no issue rows for a draft that has no server thread", async () => {
  state.draft = true;
  await act(async () => root.render(<ThreadDetailsPanel {...props} isGitRepo={false} />));
  expect(element.querySelectorAll('button[aria-label^="https://"]')).toHaveLength(0);
  expect(state.command).not.toHaveBeenCalled();
});
