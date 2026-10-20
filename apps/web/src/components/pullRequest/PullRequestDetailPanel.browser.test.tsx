import {
  EnvironmentId,
  GitCommandError,
  GitManagerError,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type PullRequestDetailView,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";

import "~/index.css";

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
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
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
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => (command === "update" ? update : hostCommand)) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const cannotWriteGuides = Atom.make(false);
  const diff = Atom.make(null);
  queries.diff = diff;
  return {
    ...actual,
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
    data: query === "detail" ? currentDetail : query === queries.diff ? diff : null,
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
// The summary stand-in exposes its panel actions and nested scrolling.
vi.mock(import("./PullRequestSummaryTab"), async (original) => ({
  ...(await original()),
  PullRequestSummaryTab: (({
    onFixFinding,
    scrollerRef,
  }: ComponentProps<typeof import("./PullRequestSummaryTab").PullRequestSummaryTab>) => (
    <div ref={scrollerRef} data-testid="summary-scroller" className="h-full overflow-y-auto">
      <button
        type="button"
        onClick={() =>
          onFixFinding?.({
            kind: "check",
            check: { name: "Unit tests", status: "failure", description: "Test failed", url: null },
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
  )) as never,
}));

vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: addToast, update: updateToast } as never,
  };
});

import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import { pullRequestPanelContext } from "./pullRequestDetail.logic";
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
const draftId = DraftId.make("draft-1");
const newDraftId = DraftId.make("new-draft");
const shortcutContext = () => ({
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
});

const roots: Root[] = [];

function render(props: Partial<ComponentProps<typeof PullRequestDetailPanel>> = {}) {
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  return act(async () =>
    root.render(
      <PullRequestDetailPanel
        environmentId={threadRef.environmentId}
        reference={detail}
        context="page"
        shortcutsEnabled={false}
        getShortcutContext={shortcutContext}
        {...props}
      />,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  currentDetail = detail;
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
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
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

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
  linkedPullRequest: { ...surface, number: 3, url: link(3, "manual").url },
};
const unrelatedThread = {
  projectId: detail.projectId,
  pullRequests: [link(9, "created")],
  linkedPullRequest: { ...surface, number: 9, url: link(9, "created").url },
};

const tab = (name: string) => page.getByRole("button", { name, exact: true });

const selectionDraft = () => page.getByRole("textbox", { name: "Comment on lines a.ts:1" });

async function selectFirstLine() {
  const line = page.getByText("broken()", { exact: true });
  await expect.element(line).toBeVisible();
  const host = line.element().getRootNode() as ShadowRoot;
  const gutter = host.querySelector<HTMLElement>('[data-column-number="1"]')!;
  await userEvent.click(gutter);
}

it.each([
  { isComposing: true, keyCode: 13 },
  { isComposing: false, keyCode: 229 },
])("does not save the PR title during IME composition (%j)", async ({ isComposing, keyCode }) => {
  await render();
  await page.getByRole("button", { name: "Edit title" }).click();
  const titleInput = page.getByRole("textbox", { name: "Pull request title" });
  const title = "日本語のタイトル";
  await titleInput.fill(title);
  const pressEnter = (init: KeyboardEventInit) =>
    act(async () => {
      titleInput
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
        );
    });

  await pressEnter({ isComposing, keyCode });
  expect(update).not.toHaveBeenCalled();
  await expect.element(titleInput).toHaveValue(title);

  await pressEnter({ keyCode: 13 });
  expect(update).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { ...surface, title },
  });
  await expect.element(titleInput).not.toBeInTheDocument();
});

async function runAction(action: string) {
  if (action === "Add to agent") {
    await tab("Code").click();
    await page.getByRole("button", { name: "Expand all files", exact: true }).click();
    await selectFirstLine();
    const draft = page.getByRole("textbox", { name: "Comment on lines a.ts:1" });
    await expect.element(draft).toBeVisible();
    expect(
      page.getByRole("button", { name: "Add to review", exact: true }).elements(),
    ).toHaveLength(0);
    await draft.fill("Fix this line");
  }
  if (["Ask a question", "Explain this PR"].includes(action) || action.startsWith("Fix findings")) {
    await page.getByRole("button", { name: "More pull request actions" }).click();
    // Menu items carry a description under their label.
    await page.getByRole("menuitem", { name: new RegExp(`^${action}`) }).click();
    return;
  }
  await page.getByRole("button", { name: action, exact: true }).click();
}

describe.each([
  ["own PR, a lower layer of the thread's stack", stackThread, threadRef],
  ["another PR beside the current thread", unrelatedThread, threadRef],
  ["PR beside an unsent draft", null, draftId],
  ["standalone PR page", null, undefined],
] as const)("%s", (_name, thread, target) => {
  const context = thread ? pullRequestPanelContext(thread, surface) : "page";
  const renderPanel = () =>
    render({ context, ...(target ? { composerDraftTarget: target, threadRef } : {}) });

  it(`${thread === stackThread ? "hides" : "offers"} the checkout`, async () => {
    await renderPanel();
    await expect.element(page.getByText("Test pull request").first()).toBeVisible();
    expect(page.getByRole("button", { name: "Check out" }).elements()).toHaveLength(
      thread === stackThread ? 0 : 1,
    );
  });

  it.each([
    "Resolve conflicts",
    "Ask a question",
    "Explain this PR",
    "Fix findings in this thread",
    "Fix check",
    "Add to agent",
  ])("%s writes to the correct composer", async (action) => {
    // Cover both a host without inline comments and an account that cannot write them.
    currentDetail =
      thread === stackThread
        ? {
            ...detail,
            capabilities: {
              ...detail.capabilities,
              review: { ...detail.capabilities.review, inlineComment: true },
            },
          }
        : { ...detail, viewerPermissions: { ...detail.viewerPermissions, comment: true } };
    if (target) useComposerDraftStore.getState().setPrompt(target, "Keep my draft");
    await renderPanel();
    await runAction(target ? action : action.replace("in this thread", "in a thread"));
    const draft = () => useComposerDraftStore.getState().getComposerDraft(target ?? newDraftId);
    await vi.waitFor(() => {
      if (action === "Resolve conflicts")
        expect(draft()?.prompt).toContain("resolve every conflict");
      else if (action === "Fix check") expect(draft()?.prompt).toContain("Fix the failing check");
      else if (action.startsWith("Fix findings"))
        expect(draft()?.prompt).toContain("Fix the actionable findings");
      else expect(draft()?.reviewComments?.length).toBeGreaterThan(0);
    });
    if (action === "Add to agent") {
      expect(draft()?.prompt).toContain("Fix this line");
      expect(draft()?.reviewComments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filePath: "a.ts",
            diff: expect.stringContaining("+broken()"),
            startIndex: 0,
            endIndex: 0,
          }),
        ]),
      );
      expect(usePullRequestReviewStore.getState().drafts).toEqual({});
      expect(hostCommand).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("textbox", { name: "Comment on lines a.ts:1" }))
        .not.toBeInTheDocument();
    }
    if (target) {
      expect(draft()?.prompt).toContain("Keep my draft");
      expect(newThread).not.toHaveBeenCalled();
      expect(prepareThread).not.toHaveBeenCalled();
    } else {
      expect(newThread).toHaveBeenCalled();
    }
  });
});

it("offers both selection actions and queues a permitted host review locally", async () => {
  currentDetail = {
    ...detail,
    capabilities: {
      ...detail.capabilities,
      review: { ...detail.capabilities.review, inlineComment: true },
    },
    viewerPermissions: { ...detail.viewerPermissions, comment: true },
  };
  await render({ composerDraftTarget: draftId, threadRef });
  await tab("Code").click();
  await page.getByRole("button", { name: "Expand all files", exact: true }).click();
  await selectFirstLine();
  const addToReview = page.getByRole("button", { name: "Add to review", exact: true });
  await expect.element(addToReview).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Add to agent", exact: true }))
    .toBeVisible();
  await selectionDraft().fill("Fix this line before merging");
  await addToReview.click();
  await expect.element(selectionDraft()).not.toBeInTheDocument();
  expect(Object.values(usePullRequestReviewStore.getState().drafts).flat()).toEqual([
    expect.objectContaining({ path: "a.ts", body: "Fix this line before merging" }),
  ]);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.reviewComments ?? []).toEqual(
    [],
  );
  expect(hostCommand).not.toHaveBeenCalled();
});

it("cancels an agent-only selection and submits a fresh one with the keyboard without a host review", async () => {
  await render({ composerDraftTarget: draftId, threadRef });
  await tab("Code").click();
  await page.getByRole("button", { name: "Expand all files", exact: true }).click();
  await selectFirstLine();
  await selectionDraft().fill("Discard this request");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(selectionDraft()).not.toBeInTheDocument();
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.reviewComments ?? []).toEqual(
    [],
  );
  expect(usePullRequestReviewStore.getState().drafts).toEqual({});
  expect(hostCommand).not.toHaveBeenCalled();

  await selectFirstLine();
  await expect.element(selectionDraft()).toHaveValue("");
  await selectionDraft().fill("Fix this line");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await expect.element(selectionDraft()).not.toBeInTheDocument();
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toContain(
    "Fix this line",
  );
  expect(usePullRequestReviewStore.getState().drafts).toEqual({});
  expect(hostCommand).not.toHaveBeenCalled();
});

it("folds the title only for the active tab's own scroller", async () => {
  await render();
  const title = page.getByRole("heading", { level: 1, name: "Test pull request" });
  await expect.element(title).toBeVisible();
  const titleFold = () => title.element().closest("[inert]") !== null;
  const scrollTo = async (testId: string, top: number) => {
    const scroller =
      testId === "code-scroller"
        ? document.querySelector<HTMLElement>(".\\@container.overflow-auto")!
        : (page.getByTestId(testId).element() as HTMLElement);
    await act(async () => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    });
    return scroller;
  };

  await scrollTo("nested-scroller", 600);
  expect(titleFold()).toBe(false);

  const summary = await scrollTo("summary-scroller", 600);
  await vi.waitFor(() => expect(titleFold()).toBe(true));
  // Folding the header keeps the content under the reader's eye.
  expect(summary.scrollTop).toBeLessThan(600);

  await scrollTo("summary-scroller", 0);
  await vi.waitFor(() => expect(titleFold()).toBe(false));
  await scrollTo("summary-scroller", 600);
  await vi.waitFor(() => expect(titleFold()).toBe(true));

  await tab("Code").click();
  await page.getByRole("button", { name: "Expand all files", exact: true }).click();
  await expect.element(page.getByText("broken()", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(titleFold()).toBe(false));
  await scrollTo("code-scroller", 600);
  await vi.waitFor(() => expect(titleFold()).toBe(true));

  await tab("Summary").click();
  await vi.waitFor(() => expect(titleFold()).toBe(true));
  await scrollTo("summary-scroller", 0);
  await vi.waitFor(() => expect(titleFold()).toBe(false));
  await tab("Code").click();
  await vi.waitFor(() => expect(titleFold()).toBe(true));
});

it("stays collapsed at the bottom after native scroll clamping and reopens at the top", async () => {
  await render();
  const title = page.getByRole("heading", { level: 1, name: "Test pull request" });
  await expect.element(title).toBeVisible();
  const scroller = page.getByTestId("summary-scroller").element() as HTMLElement;
  const content = scroller.lastElementChild as HTMLElement;
  // Leave only a short scroll range so folding the header makes the browser clamp it.
  content.style.height = `${scroller.clientHeight - 24}px`;
  const expandedHeight = scroller.clientHeight;
  const expandedBottom = scroller.scrollHeight - scroller.clientHeight;

  await act(async () => {
    const scrolled = new Promise<void>((resolve) =>
      scroller.addEventListener("scroll", () => resolve(), { once: true }),
    );
    scroller.scrollTop = scroller.scrollHeight;
    await scrolled;
  });

  await vi.waitFor(() => {
    expect(title.element().closest("[inert]")).not.toBeNull();
    expect(scroller.clientHeight).toBeGreaterThan(expandedHeight);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(scroller.scrollTop).toBeLessThan(expandedBottom);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
  });

  await act(async () => {
    const scrolled = new Promise<void>((resolve) =>
      scroller.addEventListener("scroll", () => resolve(), { once: true }),
    );
    scroller.scrollTop = 0;
    await scrolled;
  });
  await vi.waitFor(() => expect(title.element().closest("[inert]")).toBeNull());
});

it("shows the current checkout recovery detail on the first failure and on retry", async () => {
  const first = new GitManagerError({
    cwd: "/workspace",
    operation: "preparePullRequestThread",
    detail: "This PR branch is already checked out in the main repo. Use Local.",
  });
  const second = new GitCommandError({
    cwd: "/workspace",
    operation: "GitVcsDriver.createWorktree",
    command: "git worktree add",
    detail: "The worktree directory already exists. Choose another directory.",
  });
  await render();

  for (const [index, error] of [first, second].entries()) {
    prepareThread.mockImplementationOnce(async () => {
      checkoutState.error = error;
      return { _tag: "Failure", cause: Cause.fail(error) };
    });
    await page.getByRole("button", { name: "Check out", exact: true }).click();
    await page.getByRole("menuitem", { name: /In a separate worktree/ }).click();
    await vi.waitFor(() => expect(updateToast).toHaveBeenCalledTimes(index + 1));
  }
  expect(updateToast.mock.calls.map(([, toast]) => toast.description)).toEqual([
    expect.stringContaining(first.detail),
    second.detail,
  ]);
});
