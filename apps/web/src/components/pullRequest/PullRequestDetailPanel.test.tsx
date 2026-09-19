import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
  type PullRequestDetailView,
  type PullRequestSummary,
  type PullRequestListEntry,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, type ReactNode, type ReactElement, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";

const { newThread, prepareThread, refresh, Wrapper, Trigger } = vi.hoisted(() => ({
  newThread: vi.fn(),
  prepareThread: vi.fn(),
  refresh: vi.fn(),
  Wrapper: ({ children }: { children?: ReactNode }) => children,
  Trigger: ({ children, render }: { children?: ReactNode; render?: ReactElement }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("~/state/entities", () => ({ useProjects: () => [], useServerConfigs: () => new Map() }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => EnvironmentId.make("env-1"),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
}));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => newThread }));
vi.mock("~/lib/sourceControlActions", () => ({
  usePreparePullRequestThreadAction: () => ({ run: prepareThread }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/pullRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/pullRequests")>()),
  pullRequestEnvironment: { detail: () => "detail", activity: () => "activity" },
  usePullRequestTurnRefresh: () => 0,
  useSharedPullRequestSummary: () => observedSummary,
}));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { listRefs: () => null } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data: query === "detail" ? loadedDetail : null,
    isPending: query === "detail" && loadedDetail === null,
    isSuccess: true,
    error: null,
    refresh,
  }),
}));
vi.mock("~/state/usePullRequestStack", () => ({
  usePullRequestStack: () => ({
    data: null,
    isSuccess: true,
    isPending: false,
    error: null,
    refresh,
  }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn(), update: vi.fn() } }));
vi.mock("../ui/tooltip", () => ({
  TooltipProvider: Wrapper,
  Tooltip: Wrapper,
  TooltipTrigger: Trigger,
  TooltipPopup: () => null,
}));
vi.mock("../ui/menu", () => ({
  Menu: Wrapper,
  MenuPopup: Wrapper,
  MenuTrigger: Trigger,
  MenuItem: "button",
  MenuRadioGroup: Wrapper,
  MenuRadioItem: "button",
  MenuSeparator: () => null,
  MenuShortcut: () => null,
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: () => null,
  AlertDialogPopup: Wrapper,
  AlertDialogHeader: Wrapper,
  AlertDialogTitle: Wrapper,
  AlertDialogDescription: Wrapper,
  AlertDialogFooter: Wrapper,
  AlertDialogClose: Wrapper,
}));
vi.mock("./PullRequestMarkdown", () => ({
  PullRequestMarkdownContext: Wrapper,
  PullRequestMarkdown: () => null,
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("./PullRequestThreadLinks", () => ({ PullRequestThreadLinks: () => null }));
vi.mock("./PullRequestSummaryTab", () => ({
  PullRequestSummaryTab: ({
    onFixFinding,
  }: ComponentProps<typeof import("./PullRequestSummaryTab").PullRequestSummaryTab>) => (
    <button
      onClick={() =>
        onFixFinding?.({
          kind: "check",
          check: { name: "Unit tests", status: "failure", description: "Test failed", url: null },
        })
      }
    >
      Fix check
    </button>
  ),
}));
vi.mock("./PullRequestCodeTab", () => ({
  default: ({
    onAddToAgentSelection,
  }: ComponentProps<typeof import("./PullRequestCodeTab").default>) => (
    <button
      onClick={() =>
        onAddToAgentSelection?.({
          request: "Fix this line",
          comment: {
            id: "note-1",
            sectionId: "file:a.ts",
            sectionTitle: "a.ts",
            filePath: "a.ts",
            startIndex: 0,
            endIndex: 0,
            rangeLabel: "L1",
            text: "Please fix",
            diff: "+broken()",
          },
        })
      }
    >
      Add to agent
    </button>
  ),
}));

import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import { pullRequestPanelContext } from "./pullRequestDetail.logic";

const detail: PullRequestDetailView = {
  provider: "github",
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "conflicting",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const draftId = DraftId.make("draft-1");
const newDraftId = DraftId.make("new-draft");
let renderer: ReactTestRenderer;
let loadedDetail: PullRequestDetailView | null = detail;
let observedSummary: PullRequestSummary | null = null;

beforeEach(() => {
  loadedDetail = detail;
  observedSummary = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  newThread
    .mockReset()
    .mockResolvedValue({ draftId: newDraftId, threadId: ThreadId.make("new-thread") });
  prepareThread.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { branch: "feature", worktreePath: "/workspace/pr" },
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find(
      (node) =>
        node.props["aria-label"] === label ||
        node.findAll((child) => child.children.includes(label)).length > 0,
    );
  expect(button, label).toBeDefined();
  await act(async () =>
    button!.props.onClick({
      nativeEvent: new Event("click"),
      preventDefault() {},
      stopPropagation() {},
    }),
  );
}

const actions = [
  "Resolve conflicts",
  "Ask a question",
  "Explain this PR",
  "Fix findings in this thread",
  "Fix check",
  "Add to agent",
];

// The surface ChatView opens for `detail`, and the thread states it can be opened beside. The
// context prop is derived here the way ChatView derives it, so a wrong answer from the thread's
// link list fails these cases rather than only a hand-picked prop.
const surface = { projectId: detail.projectId, repository: detail.repository, number: 1 };
const link = (number: number, source: ThreadPullRequestLink["source"]): ThreadPullRequestLink => ({
  host: "github.com",
  repository: detail.repository,
  number,
  url: `https://github.com/${detail.repository}/pull/${number}`,
  source,
  linkedAt: "2026-09-01T00:00:00Z",
  snapshot: null,
  stack: null,
});
const stackThread = {
  projectId: detail.projectId,
  pullRequests: [link(3, "manual"), link(2, "stack"), link(1, "stack")],
  // The server's one-slot field names the top layer; the panel shows the bottom one.
  linkedPullRequest: { ...surface, number: 3, url: link(3, "manual").url },
};
const unrelatedThread = {
  projectId: detail.projectId,
  pullRequests: [link(9, "created")],
  linkedPullRequest: { ...surface, number: 9, url: link(9, "created").url },
};

describe.each([
  ["own PR, a lower layer of the thread's stack", stackThread, threadRef],
  ["another PR beside the current thread", unrelatedThread, threadRef],
  ["PR beside an unsent draft", null, draftId],
  ["standalone PR page", null, undefined],
] as const)("%s", (_name, thread, target) => {
  const context = thread ? pullRequestPanelContext(thread, surface) : "page";

  function render() {
    renderer = create(
      <PullRequestDetailPanel
        environmentId={threadRef.environmentId}
        reference={detail}
        context={context}
        {...(target ? { composerDraftTarget: target, threadRef } : {})}
        shortcutsEnabled={false}
        getShortcutContext={() => ({
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        })}
      />,
    );
  }

  it(`${thread === stackThread ? "hides" : "offers"} the checkout`, async () => {
    await act(async () => render());
    const checkout = renderer.root
      .findAllByType("button")
      .filter((node) => node.props["aria-label"] === "Check out");
    expect(checkout).toHaveLength(thread === stackThread ? 0 : 1);
  });

  it.each(actions)("%s writes to the correct composer", async (action) => {
    if (target) useComposerDraftStore.getState().setPrompt(target, "Keep my draft");
    await act(async () => render());
    if (action === "Add to agent") await click("Code");
    await click(target ? action : action.replace("in this thread", "in a thread"));
    const draft = useComposerDraftStore.getState().getComposerDraft(target ?? newDraftId);
    if (action === "Resolve conflicts") expect(draft?.prompt).toContain("resolve every conflict");
    else if (action === "Fix check") expect(draft?.prompt).toContain("Fix the failing check");
    else if (action.startsWith("Fix findings"))
      expect(draft?.prompt).toContain("Fix the actionable findings");
    else expect(draft?.reviewComments?.length).toBeGreaterThan(0);
    if (action === "Add to agent") {
      expect(draft?.prompt).toContain("Fix this line");
      expect(draft?.reviewComments).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "note-1", diff: "+broken()" })]),
      );
    }
    if (target) {
      expect(draft?.prompt).toContain("Keep my draft");
      expect(newThread).not.toHaveBeenCalled();
      expect(prepareThread).not.toHaveBeenCalled();
    } else {
      expect(newThread).toHaveBeenCalled();
    }
  });
});

describe("PR list status in the sidebar detail", () => {
  const panel = (listEntry: PullRequestListEntry | null = null) => (
    <PullRequestDetailPanel
      environmentId={threadRef.environmentId}
      reference={detail}
      listEntry={listEntry}
      shortcutsEnabled={false}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
    />
  );

  it("shows the known title and conflict before full detail arrives", async () => {
    loadedDetail = null;
    observedSummary = detail;
    await act(async () => {
      renderer = create(panel());
    });
    expect(
      renderer.root.findAll((node) => node.children.includes("Conflicts with main")),
    ).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.children.includes(detail.title))).toHaveLength(1);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });

  it("keeps the list conflict when the shared summary omits mergeability", async () => {
    loadedDetail = null;
    observedSummary = { ...detail, mergeability: undefined, isDraft: undefined };
    const row = { ...detail, host: "github.com", viewerReviewRequested: false };
    await act(async () => {
      renderer = create(panel(row));
    });
    expect(
      renderer.root.findAll((node) => node.children.includes("Conflicts with main")),
    ).toHaveLength(1);
  });

  it("uses the list conflict while an older detail snapshot is displayed", async () => {
    loadedDetail = { ...detail, mergeability: "mergeable" };
    await act(async () => {
      renderer = create(panel());
    });
    expect(
      renderer.root.findAll((node) => node.children.includes("Resolve conflicts")),
    ).toHaveLength(0);

    loadedDetail = null;
    observedSummary = detail;
    await act(async () => {
      renderer.update(panel());
    });
    expect(
      renderer.root.findAll((node) => node.children.includes("Resolve conflicts")).length,
    ).toBeGreaterThan(0);
  });
});
