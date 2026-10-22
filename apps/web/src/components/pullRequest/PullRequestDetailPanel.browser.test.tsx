import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type PullRequestDetailView,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { RightPanelSurfaceContent } from "../chat/RightPanelSurfaceContent";

import "~/index.css";
import { act, render as renderUi } from "../../../test/render";

const {
  newThread,
  prepareThread,
  refresh,
  update,
  addToast,
  updateToast,
  checkoutState,
  hostCommand,
  queries,
  runPullRequestAction,
  connection,
} = vi.hoisted(() => ({
  hostCommand: vi.fn(),
  queries: { diff: undefined as unknown },
  newThread: vi.fn(),
  prepareThread: vi.fn(),
  refresh: vi.fn(),
  update: vi.fn(),
  addToast: vi.fn(),
  updateToast: vi.fn(),
  checkoutState: { error: null as Error | null },
  runPullRequestAction: vi.fn(),
  connection: { writable: true },
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => connection.writable,
  readEnvironmentScope: () => true,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => undefined) as never,
}));
vi.mock(import("~/hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => newThread) as never,
}));
vi.mock(import("~/lib/sourceControlActions"), async (original) => ({
  ...(await original()),
  usePreparePullRequestThreadAction: (() => ({
    run: prepareThread,
    isAllowed: true,
    error: checkoutState.error,
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { pullRequestEnvironment } = await import("~/state/pullRequests");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === "update"
        ? update
        : command === pullRequestEnvironment.runAction
          ? runPullRequestAction
          : hostCommand) as never,
  };
});
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const cannotWriteGuides = Atom.make(false);
  const diff = Atom.make(null);
  queries.diff = diff;
  return {
    ...actual,
    useSharedPullRequestSummary: () => null,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      detail: (() => "detail") as never,
      diff: (() => diff) as never,
      activity: (() => "activity") as never,
      update: "update" as never,
      reviewGuide: (() => "review-guide") as never,
      generateReviewGuide: {
        ...actual.pullRequestEnvironment.generateReviewGuide,
        permissionAtom: () => cannotWriteGuides,
      },
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((query: unknown) => ({
    data:
      query === "detail"
        ? (activityDetail ?? currentDetail)
        : query === "activity"
          ? activityDetail
          : query === queries.diff
            ? diff
            : null,
    dataUpdatedAt: 0,
    failure: null,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh,
  })) as never,
}));
vi.mock(import("~/state/usePullRequestStack"), async (original) => ({
  ...(await original()),
  usePullRequestStack: (() => ({
    data: null,
    isSuccess: true,
    isPending: false,
    error: null,
    refresh,
  })) as never,
}));
// Action and scroll tests use stand-ins; activity tests render the real Summary.
vi.mock(import("./PullRequestSummaryTab"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    PullRequestSummaryTab: ((props: ComponentProps<typeof actual.PullRequestSummaryTab>) => {
      if (activityDetail !== null) return <actual.PullRequestSummaryTab {...props} />;
      const { onFixFinding, scrollerRef } = props;
      return (
        <div ref={scrollerRef} data-testid="summary-scroller" className="h-full overflow-y-auto">
          <button
            type="button"
            onClick={() =>
              onFixFinding?.({
                kind: "check",
                check: {
                  name: "Unit tests",
                  status: "failure",
                  description: "Test failed",
                  url: null,
                },
              })
            }
          >
            Fix check
          </button>
          <div data-testid="nested-scroller" className="h-40 overflow-y-auto">
            <div className="h-[2000px]" />
          </div>
          <div className="h-[3000px]" />
        </div>
      );
    }) as never,
  };
});
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: addToast, update: updateToast } as never,
  };
});

import { PullRequestDetailPanel } from "./PullRequestDetailPanel";

import { usePullRequestReviewStore } from "./pullRequestReviewStore";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
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

let currentDetail = detail;
let activityDetail: PullRequestDetailView | null = null;

// Enough lines to exercise the panel's title folding with the real virtualized Code tab.
const diff = {
  patch: [
    "diff --git a/a.ts b/a.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/a.ts",
    "@@ -0,0 +1,100 @@",
    "+broken()",
    ...Array.from({ length: 99 }, (_, index) => `+// line ${index + 2}`),
    "",
  ].join("\n"),
  truncated: false,
  nextCursor: null,
};

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

const newDraftId = DraftId.make("new-draft");
const shortcutContext = () => ({
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
});

function panelContainer() {
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  return container;
}

function render(props: Partial<ComponentProps<typeof PullRequestDetailPanel>> = {}) {
  return renderUi(
    <PullRequestDetailPanel
      environmentId={threadRef.environmentId}
      reference={detail}
      context="page"
      shortcutsEnabled={false}
      getShortcutContext={shortcutContext}
      {...props}
    />,
    { container: panelContainer() },
  );
}

// The mocked modules and stores are shared by the whole file, so every test starts by
// resetting them.
function setup() {
  activityDetail = null;
  connection.writable = true;
  runPullRequestAction.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  currentDetail = detail;
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  usePullRequestReviewStore.setState({ drafts: {}, summaries: {} });
  hostCommand.mockReset();
  newThread
    .mockReset()
    .mockResolvedValue({ draftId: newDraftId, threadId: ThreadId.make("new-thread") });
  addToast.mockReset().mockReturnValue("checkout-toast");
  updateToast.mockReset();
  checkoutState.error = null;
  prepareThread.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { branch: "feature", worktreePath: "/workspace/pr" },
  });
  update.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
}

const surface = { projectId: detail.projectId, repository: detail.repository, number: 1 };

const tab = (name: string) => page.getByRole("button", { name, exact: true });

function setAzureDraftFixture() {
  currentDetail = {
    ...detail,
    provider: SourceControlProviderKind.make("azure-devops"),
    isDraft: true,
    capabilities: {
      ...detail.capabilities,
      hostActions: true,
      actions: ["ready", "draft"],
      review: { ...detail.capabilities.review, verdicts: ["comment", "approve"] },
    },
    viewerPermissions: { ...detail.viewerPermissions, actions: ["ready", "draft"] },
  };
}

it("publishes a visibly marked Azure draft before offering approval, and can return to draft", async () => {
  setup();
  setAzureDraftFixture();
  await using screen = await render();
  await expect.element(page.getByText("Draft", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Approve pull request" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
  runPullRequestAction.mockImplementation(async ({ input }: { input: { action: string } }) => {
    currentDetail = { ...currentDetail, isDraft: input.action === "draft" };
    return { _tag: "Success", value: {} };
  });

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await screen.rerender(
    <PullRequestDetailPanel
      environmentId={threadRef.environmentId}
      reference={detail}
      context="page"
      shortcutsEnabled={false}
      getShortcutContext={shortcutContext}
    />,
  );
  expect(runPullRequestAction).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: expect.objectContaining({ action: "ready", number: detail.number }),
  });
  await expect.element(page.getByText("Draft", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Publish", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Approve pull request" })).toBeVisible();

  await page.getByRole("button", { name: "More pull request actions" }).click();
  await page.getByRole("menuitem", { name: "Convert to draft", exact: true }).click();
  await screen.rerender(
    <PullRequestDetailPanel
      environmentId={threadRef.environmentId}
      reference={detail}
      context="page"
      shortcutsEnabled={false}
      getShortcutContext={shortcutContext}
    />,
  );
  expect(runPullRequestAction).toHaveBeenLastCalledWith({
    environmentId: threadRef.environmentId,
    input: expect.objectContaining({ action: "draft", number: detail.number }),
  });
  await expect.element(page.getByText("Draft", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Approve pull request" }))
    .not.toBeInTheDocument();
});

it.each(["token", "connection", "account"])(
  "keeps Publish visible but prevents it without %s permission",
  async (denial) => {
    setup();
    setAzureDraftFixture();
    if (denial === "token") {
      currentDetail = {
        ...currentDetail,
        viewerPermissions: {
          ...currentDetail.viewerPermissions,
          deniedActions: { ready: "Your token does not allow this action." },
        },
      };
    } else if (denial === "account") {
      currentDetail = {
        ...currentDetail,
        viewerPermissions: { ...currentDetail.viewerPermissions, actions: [] },
      };
    } else {
      connection.writable = false;
    }
    await using _screen = await render();
    await expect.element(page.getByText("Draft", { exact: true })).toBeVisible();
    const publish = page.getByRole("button", { name: "Publish", exact: true });
    await expect.element(publish).toBeVisible();
    await expect.element(publish).toBeDisabled();
    await act(async () => (publish.element() as HTMLButtonElement).click());
    expect(runPullRequestAction).not.toHaveBeenCalled();
  },
);

it.each(["github", "azure-devops", "gitlab", "bitbucket", "forgejo", "gitcafe"])(
  "keeps draft conflict resolution reachable while publishing is primary on %s",
  async (provider) => {
    setup();
    setAzureDraftFixture();
    currentDetail = {
      ...currentDetail,
      provider: SourceControlProviderKind.make(provider),
      mergeability: "conflicting",
    };
    await using _screen = await render();
    await expect
      .element(
        page.getByRole("button", {
          name: provider === "azure-devops" ? "Publish" : "Ready for review",
          exact: true,
        }),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "More pull request actions" }).click();
    await page.getByRole("menuitem", { name: "Resolve conflicts", exact: true }).click();
    await vi.waitFor(() => {
      const draft = useComposerDraftStore.getState().getComposerDraft(newDraftId);
      expect(draft?.prompt).toContain("resolve every conflict");
    });
    expect(newThread).toHaveBeenCalled();
    expect(runPullRequestAction).not.toHaveBeenCalled();
  },
);

it("restores the selected PR tab when switching threads and remounting the right panel", async () => {
  setup();
  const otherThread = { ...threadRef, threadId: ThreadId.make("thread-2") };
  useRightPanelStore.getState().openPullRequest(threadRef, surface);
  useRightPanelStore.getState().openPullRequest(otherThread, surface);
  const codeTab = () => page.getByRole("button", { name: "Expand all files", exact: true });
  const content = (ref: ScopedThreadRef) => {
    const selected = selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);
    return (
      <RightPanelSurfaceContent
        surface={selected}
        activeSurfaceId={selected?.id ?? null}
        threadRef={ref}
        environmentId={ref.environmentId}
        visible
        composerDraftTarget={ref}
        keybindings={[]}
        configuredPreviewUrls={[]}
        workspaceMutationId={null}
        getShortcutContext={shortcutContext}
        onSendAnnotation={() => {}}
        onCloseSurface={() => {}}
        terminal={{
          launchContext: null,
          focusRequestId: 0,
          keybindings: [],
          onAddTerminalContext: () => {},
          onSplitTerminal: () => {},
          onSplitTerminalVertical: () => {},
          onNewTerminal: () => {},
          onActiveTerminalChange: () => {},
          onCloseTerminal: () => {},
        }}
        pullRequest={{
          capabilityKnown: true,
          supported: true,
          projectId: detail.projectId,
          pullRequests: [],
          linkedPullRequest: null,
          branchPullRequest: null,
          onBack: undefined,
        }}
        files={{
          projectName: null,
          workspaceRoot: undefined,
          availableEditors: [],
          pendingSurfaceIds: new Set(),
          onOpenFile: () => {},
          onPendingChange: () => {},
        }}
      />
    );
  };
  await using screen = await renderUi(content(threadRef), { container: panelContainer() });
  const show = (ref: ScopedThreadRef) => screen.rerender(content(ref));

  await expect.element(page.getByTestId("summary-scroller")).toBeVisible();
  await tab("Code").click();
  await expect.element(codeTab()).toBeVisible();
  await show(otherThread);
  await expect.element(page.getByTestId("summary-scroller")).toBeVisible();
  await show(threadRef);
  await expect.element(codeTab()).toBeVisible();

  useRightPanelStore
    .getState()
    .openPullRequest(threadRef, { ...surface, projectId: "other-project" });
  await show(threadRef);
  await expect.element(page.getByTestId("summary-scroller")).toBeVisible();
  useRightPanelStore.getState().openPullRequest(threadRef, surface);
  await show(threadRef);
  await expect.element(codeTab()).toBeVisible();

  await screen.rerender(null);
  useRightPanelStore.getState().openPullRequest(threadRef, { ...surface, url: detail.url });
  await show(threadRef);
  await expect.element(codeTab()).toBeVisible();
  await tab("Summary").click();
  await show(otherThread);
  await show(threadRef);
  await expect.element(page.getByTestId("summary-scroller")).toBeVisible();
});
