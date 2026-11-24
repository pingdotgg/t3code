import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import appCss from "~/index.css?inline";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { act, fakeTimers, render } from "../../../test/render";

const { command, permissions, reads, shown } = vi.hoisted(() => ({
  command: vi.fn(),
  permissions: { checkout: true, operate: true },
  reads: { diff: [] as unknown[] },
  shown: { detail: null as PullRequestDetailView | null },
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (_environmentId: unknown, scope: unknown) =>
    scope === AuthOrchestrationOperateScope ? permissions.operate : permissions.checkout,
  readEnvironmentScope: (_environmentId: unknown, scope: unknown) =>
    scope === AuthOrchestrationOperateScope ? permissions.operate : permissions.checkout,
}));
vi.mock(import("~/state/sourceControlActions"), async (original) => ({
  ...(await original()),
  usePreparePullRequestThreadAction: (() => ({
    isAllowed: permissions.checkout,
    run: vi.fn(),
    error: null,
  })) as never,
}));
vi.mock(import("./usePullRequestDetail"), async (original) => ({
  ...(await original()),
  usePullRequestDetail: (() => ({
    canWriteSourceControl: permissions.checkout,
    detailQuery: { isPending: false, refresh: vi.fn() },
    activityQuery: { isPending: false, refresh: vi.fn(), error: null },
    activity: null,
    sharedSummary: shown.detail,
    coreDetail: shown.detail,
    detail: shown.detail,
  })) as never,
}));
vi.mock(import("~/state/usePullRequestStack"), async (original) => ({
  ...(await original()),
  usePullRequestStack: (() => ({
    data: null,
    isFresh: true,
    isPending: false,
    error: null,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    usePullRequestList: () => ({
      data: null,
      error: null,
      isPending: false,
      observations: [],
      refresh: vi.fn(),
      retry: vi.fn(),
    }),
    usePullRequestListStats: () => ({ stats: null, isPending: false, refresh: vi.fn() }),
    usePullRequestTurnRefreshes: () => [],
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      diff: ((target: unknown) => {
        reads.diff.push(target);
        return actual.pullRequestEnvironment.diff(target as never);
      }) as never,
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => command) as never,
}));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useAllEnvironmentShellsBootstrapped: () => true,
  useProjects: (() => [
    {
      id: "project",
      environmentId: "environment",
      title: "Project",
      workspaceRoot: "/workspace",
      repositoryIdentity: null,
      isScratch: false,
    },
  ]) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: "environment",
        label: "Server",
        connection: { phase: "connected" },
        serverConfig: { environment: { platform: "linux" } },
      },
    ],
  })) as never,
}));
vi.mock(import("~/hooks/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: (() => [
    {
      displayName: "Project",
      memberProjectRefs: [{ environmentId: "environment", projectId: "project" }],
    },
  ]) as never,
}));
import { createWorkspaceFocusController, workspaceAreaProps } from "~/lib/workspaceFocus";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import { PullRequestsPage } from "./PullRequestsPage";
import { SidebarProvider } from "../ui/sidebar";
import { useRightPanelStore } from "~/rightPanelStore";

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
  commits: [
    {
      oid: "a".repeat(40),
      messageHeadline: "Earlier commit",
      committedDate: "2026-09-01T00:00:00Z",
    },
    { oid: "b".repeat(40), messageHeadline: "Later commit", committedDate: "2026-09-02T00:00:00Z" },
  ],
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

const environmentId = EnvironmentId.make("environment");
const draftId = DraftId.make("conflicts-draft");
const panel = (attach = false, shortcutsEnabled = false, reference = detail) => (
  <PullRequestDetailPanel
    environmentId={environmentId}
    reference={reference}
    context="page"
    shortcutsEnabled={shortcutsEnabled}
    getShortcutContext={() => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
    })}
    {...(attach ? { composerDraftTarget: draftId } : {})}
  />
);

function setup() {
  permissions.checkout = true;
  permissions.operate = true;
  reads.diff = [];
  shown.detail = detail;
  command.mockReset();
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
}

it.each([AuthSourceControlWriteScope, AuthOrchestrationOperateScope])(
  "disables conflict checkout when the connection loses %s",
  async (scope) => {
    setup();
    await using screen = await render(panel());
    const resolve = screen.getByRole("button", { name: "Resolve conflicts" });
    await expect.element(resolve).toBeEnabled();
    if (scope === AuthSourceControlWriteScope) permissions.checkout = false;
    else permissions.operate = false;
    await screen.rerender(panel());
    await expect.element(resolve).toBeDisabled();
  },
);

it("can still add conflict resolution to an existing composer without checkout scopes", async () => {
  setup();
  permissions.checkout = false;
  permissions.operate = false;
  await using screen = await render(panel(true));
  const resolve = screen.getByRole("button", { name: "Resolve conflicts" });
  await expect.element(resolve).toBeEnabled();
  await act(() => resolve.click());
  const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
  expect(draft?.prompt).toContain("conflicts");
  expect(draft?.prompt).toContain(detail.url);
});

it("keeps a merge and a review on the head the reader was shown until they load new commits", async () => {
  setup();
  command.mockResolvedValue({ _tag: "Success", value: undefined });
  const at = (headSha: string): PullRequestDetailView => ({
    ...detail,
    headSha,
    mergeability: "mergeable",
    mergeCapabilities: { merge: false, squash: true, rebase: false },
    capabilities: {
      ...detail.capabilities,
      actions: ["merge"],
      mergeMethods: ["squash"],
      review: { ...detail.capabilities.review, verdicts: ["approve"] },
    },
    viewerPermissions: { ...detail.viewerPermissions, actions: ["merge"], verdicts: ["approve"] },
  });
  const sent = (key: "action" | "verdict") =>
    command.mock.calls.flatMap(([call]) =>
      call?.input?.[key] === undefined ? [] : [call.input.expectedHeadSha],
    );
  const merge = async () => {
    await screen.getByRole("button", { name: "Squash and merge" }).click();
    await screen.getByRole("button", { name: "Confirm merge?" }).click();
  };
  shown.detail = at("shown-head");
  await using screen = await render(panel());
  await expect.element(screen.getByRole("button", { name: "Squash and merge" })).toBeVisible();
  // A background refresh brings a push the reader has not looked at.
  shown.detail = at("pushed-head");
  await screen.rerender(panel());
  await expect.element(screen.getByText(/still applies to shown-h/)).toBeVisible();
  await merge();
  await screen.getByRole("button", { name: "Review pull request" }).click();
  // The composer popup is portalled outside the rendered tree.
  await page.getByRole("button", { name: "Submit review" }).click();
  await vi.waitFor(() => expect(sent("verdict")).toEqual(["shown-head"]));
  expect(sent("action")).toEqual(["shown-head"]);

  // The pin moves once the reload has been asked of the host, not at the click.
  const reload = Promise.withResolvers<{ _tag: "Success"; value: undefined }>();
  command.mockImplementation((call) =>
    call?.input?.reference === undefined
      ? Promise.resolve({ _tag: "Success", value: undefined })
      : reload.promise,
  );
  await screen.getByRole("button", { name: "Load new commits" }).click();
  await merge();
  await vi.waitFor(() => expect(sent("action")).toEqual(["shown-head", "shown-head"]));
  reload.resolve({ _tag: "Success", value: undefined });
  await expect.element(screen.getByText(/still applies to/)).not.toBeInTheDocument();
  await merge();
  await vi.waitFor(() =>
    expect(sent("action")).toEqual(["shown-head", "shown-head", "pushed-head"]),
  );
});

it("reads the first diff page once the pointer rests on the Code tab", async () => {
  setup();
  await using screen = await render(panel());
  using _timers = fakeTimers({ now: 0 });
  const code = screen.getByRole("button", { name: "Code", exact: true });
  await expect.element(code).toBeVisible();

  await userEvent.hover(code);
  await act(() => vi.advanceTimersByTime(149));
  expect(reads.diff).toEqual([]);
  await act(() => vi.advanceTimersByTime(1));
  // The page the Code tab reads first, keyed as the tab keys it, so a click paints from it.
  expect(reads.diff).toContainEqual({
    environmentId,
    input: { projectId: detail.projectId, repository: detail.repository, number: detail.number },
  });
});

it("copies the pull request's link from the copy link shortcut", async () => {
  setup();
  await using screen = await render(panel(false, true));
  await expect.element(screen.getByText("Original description", { exact: true })).toBeVisible();
  using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await userEvent.keyboard("{Control>}{Shift>}C{/Shift}{/Control}");
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(detail.url));
});

it("opens a URL-selected pull request without repeatedly reopening its detail", async () => {
  setup();
  await page.viewport(1400, 900);
  await using screen = await render(
    <SidebarProvider>
      <PullRequestsPage />
    </SidebarProvider>,
    {
      router:
        "/pull-requests?repository=owner%2Frepo&number=1&selectedProjectId=project&selectedEnvironmentId=environment",
    },
  );
  await expect.element(screen.getByText("Original description", { exact: true })).toBeVisible();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search pull requests" }), "missing");
  await userEvent.click(screen.getByRole("button", { name: "Clear pull request search" }));
  await expect
    .element(screen.getByRole("searchbox", { name: "Search pull requests" }))
    .toHaveValue("");
  await userEvent.click(screen.getByRole("button", { name: "Filters", exact: true }));
  await userEvent.hover(page.getByRole("menuitem", { name: /^State/ }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Closed", exact: true }));
  await expect.element(screen.getByRole("button", { name: "Filters, 1 active" })).toBeVisible();
  await userEvent.keyboard("{Escape}{Escape}");
  await expect.element(screen.getByText("Original description", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Timeline", exact: true }));
  await expect.element(screen.getByText("Later commit", { exact: true })).toBeVisible();
  // Too narrow for the list beside the review: the review fills the page and goes back to the list.
  await page.viewport(600, 900);
  const back = screen.getByRole("button", { name: /^Back to/ });
  await userEvent.click(back);
  await expect.element(back).not.toBeInTheDocument();
  await expect.element(screen.getByText("Later commit", { exact: true })).not.toBeInTheDocument();
  await page.viewport(414, 896);
});

it("switches the timeline between newest and oldest activity first", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(screen.getByRole("button", { name: "Timeline", exact: true }));
  await expect.element(screen.getByText("Later commit", { exact: true })).toBeVisible();
  expect(
    screen
      .getByText("Later commit", { exact: true })
      .element()
      .compareDocumentPosition(screen.getByText("Earlier commit", { exact: true }).element()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "More pull request actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Show oldest activity first" }));
  expect(
    screen
      .getByText("Earlier commit", { exact: true })
      .element()
      .compareDocumentPosition(screen.getByText("Later commit", { exact: true }).element()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "More pull request actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Show newest activity first" }));
  expect(
    screen
      .getByText("Later commit", { exact: true })
      .element()
      .compareDocumentPosition(screen.getByText("Earlier commit", { exact: true }).element()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("keeps a screen reader's place when scrolling the description condenses the header", async () => {
  setup();
  shown.detail = {
    ...detail,
    body: Array.from({ length: 80 }, (_, line) => `Line ${line}`).join("\n\n"),
  };
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  using _style = { [Symbol.dispose]: () => style.remove() };
  const controller = createWorkspaceFocusController(document);
  using _controller = { [Symbol.dispose]: () => controller.dispose() };
  await using screen = await render(
    <div {...workspaceAreaProps("pull-requests", 1)} className="flex h-[600px] flex-col">
      {panel()}
    </div>,
  );
  const openOnHost = screen.getByRole("button", { name: "Open pull request #1 on host" });
  await expect.element(openOnHost).toBeVisible();
  const expanded = openOnHost.element() as HTMLButtonElement;
  expanded.focus();
  await expect.element(screen.getByText("Line 79")).toBeInTheDocument();
  // The description starts collapsed; read all of it so the panel can scroll.
  (screen.getByRole("button", { name: "Read more" }).element() as HTMLButtonElement).click();
  expanded.focus();
  let scroller = screen.getByText("Line 79").element().parentElement;
  while (scroller && getComputedStyle(scroller).overflowY !== "auto") {
    scroller = scroller.parentElement;
  }
  using _timers = fakeTimers();
  using moves = vi.spyOn(HTMLElement.prototype, "focus");
  // Browse mode scrolls a heading into view without moving DOM focus.
  await act(() => {
    scroller!.scrollTop = scroller!.scrollHeight;
  });
  await act(() => vi.advanceTimersToNextFrame());
  // A programmatic focus() pulls the screen reader's browse cursor back to the header.
  expect(moves).not.toHaveBeenCalled();
});
