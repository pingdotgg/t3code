import type { EnvironmentId, IssueActivity, IssueDetail } from "@t3tools/contracts";
import type { DraftId } from "~/composerDraftStore";
import { Cause } from "effect";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const commands = vi.hoisted(() => ({
  comment: vi.fn(),
  action: vi.fn(),
  refresh: vi.fn(),
  commentsPage: vi.fn(),
  newThread: vi.fn(),
}));
const permission = vi.hoisted(() => ({ allowed: true }));
afterEach(() => {
  vi.clearAllMocks();
  permission.allowed = true;
  currentDetail = detail;
  currentActivity = activity;
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => permission.allowed }));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => commands.newThread }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/issues", () => ({
  issueEnvironment: {
    detail: () => "detail",
    activity: () => "activity",
    commentsPage: "commentsPage",
    invalidate: "invalidate",
    runAction: "runAction",
    comment: "comment",
    update: { permissionAtom: () => null },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data: query === "detail" ? currentDetail : currentActivity,
    error: null,
    isPending: false,
    refresh: commands.refresh,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "commentsPage"
      ? commands.commentsPage
      : command === "comment"
        ? commands.comment
        : command === "runAction"
          ? commands.action
          : async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../sourceControl/ActivityUnavailableState", () => ({
  ActivityUnavailableState: () => null,
}));
vi.mock("../pullRequest/pullRequestPresentation", () => ({
  PullRequestActorLabel: () => null,
  PullRequestActorAvatar: () => null,
  PullRequestMetaLine: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../sourceControl/DetailTabStrip", () => ({
  DetailTabStrip: ({ children }: { children?: ReactNode }) => (
    <div data-detail-tabs>{children}</div>
  ),
}));
vi.mock("../sourceControl/ListGhosts", () => ({
  DetailGhost: () => null,
  TimelineGhost: () => null,
}));
vi.mock("./IssueSummaryTab", () => ({ IssueSummaryTab: () => null }));
vi.mock("./IssueTimelineTab", () => ({ IssueTimelineTab: () => null }));
vi.mock("./IssuesUnavailableState", () => ({ IssuesUnavailableState: () => null }));
const detail: IssueDetail = {
  provider: "linear",
  capabilities: {
    sorts: ["updated"],
    referenceStyle: "hash",
    closesViaPullRequest: false,
    comment: false,
    actions: [],
    closeReasons: [],
    create: false,
    issueTemplates: false,
    edit: false,
    labels: false,
    assignees: false,
    listLabelCandidates: false,
    listAssigneeCandidates: false,
    search: true,
    linkedPullRequests: false,
    timelineEvents: false,
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    edit: false,
    labels: false,
    assignees: false,
    create: false,
  },
  projectId: "project-1" as IssueDetail["projectId"],
  projectTitle: "T3 Code",
  workspaceRoot: "/tmp/project",
  repository: "acme/project",
  number: 42,
  title: "A Linear issue",
  body: "",
  url: "https://linear.app/acme/issue/ABC-42",
  author: null,
  state: "open",
  stateReason: null,
  createdAt: "2026-08-17T00:00:00Z",
  updatedAt: "2026-08-17T00:00:00Z",
  closedAt: null,
  assignees: [],
  labels: [],
  milestone: null,
  commentCount: 0,
  linkedPullRequests: [],
};

const activity: IssueActivity = {
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  nextCommentsCursor: null,
  events: [],
};
let currentDetail = detail;
let currentActivity = activity;

import { IssueDetailPanel } from "./IssueDetailPanel";
import { useComposerDraftStore } from "~/composerDraftStore";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { writeHandoffToComposer } from "../sourceControl/handoff";

const handoffChip = (id: string): ReviewCommentContext => ({
  id,
  sectionId: id,
  sectionTitle: id,
  filePath: id,
  startIndex: 0,
  endIndex: 0,
  rangeLabel: id,
  text: "",
  diff: "",
});
import { IssuesPanel } from "./IssuesPanel";
import { DetailTabStrip } from "../sourceControl/DetailTabStrip";
import { CommentComposer } from "../sourceControl/CommentComposer";
import { IssueSummaryTab } from "./IssueSummaryTab";
import { AlertDialog } from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem } from "../ui/menu";
import { TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function textContent(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textContent).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textContent(node.props.children) : "";
}

function renderPanel(
  chromeVariant?: "full" | "collapse",
  handoffTarget?: Parameters<typeof IssueDetailPanel>[0]["handoffTarget"],
) {
  hooks.beginRender();
  return IssueDetailPanel({
    environmentId: "environment-1" as EnvironmentId,
    reference: {
      projectId: "project-1" as IssueDetail["projectId"],
      repository: "acme/project",
      number: 42,
    },
    handoffTarget: handoffTarget ?? { kind: "new-thread" },
    ...(chromeVariant ? { chromeVariant } : {}),
  });
}

function panelHeader(panel: ReturnType<typeof IssueDetailPanel>) {
  return Children.toArray(panel.props.children)[0] as ReactElement<{
    readonly children: ReactNode;
  }>;
}

describe("IssueDetailPanel provider labels", () => {
  it.each([false, true])(
    "drops exhausted comment pages on revision change, late response: %s",
    async (lateResponse) => {
      hooks.reset();
      currentActivity = { ...activity, commentsTruncated: true, nextCommentsCursor: "first-page" };
      let resolve!: (value: unknown) => void;
      const pending = new Promise<unknown>((done) => {
        resolve = done;
      });
      commands.commentsPage
        .mockResolvedValue({ _tag: "Success", value: { comments: [], nextCursor: null } })
        .mockReturnValueOnce(pending);
      const summary = visitElements(renderPanel(), (element) => element.type === IssueSummaryTab)!;
      (summary.props.onLoadMoreComments as () => void)();
      if (!lateResponse) {
        resolve({ _tag: "Success", value: { comments: [], nextCursor: null } });
        await pending;
        const exhausted = visitElements(
          renderPanel(),
          (element) => element.type === IssueSummaryTab,
        )!;
        expect(
          (exhausted.props.detail as { nextCommentsCursor: string | null }).nextCommentsCursor,
        ).toBeNull();
      }
      currentDetail = { ...detail, updatedAt: "2026-08-18T00:00:00Z" };
      currentActivity = { ...activity, commentsTruncated: true, nextCommentsCursor: "fresh-page" };
      renderPanel();
      if (lateResponse) {
        resolve({ _tag: "Success", value: { comments: [], nextCursor: null } });
        await pending;
      }
      const refreshed = visitElements(
        renderPanel(),
        (element) => element.type === IssueSummaryTab,
      )!;
      expect(
        (refreshed.props.detail as { nextCommentsCursor: string | null }).nextCommentsCursor,
      ).toBe("fresh-page");
      (refreshed.props.onLoadMoreComments as () => void)();
      expect(commands.commentsPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ cursor: "fresh-page" }) }),
      );
    },
  );

  it("matches the pull request header height and keeps the tab row stable", () => {
    hooks.reset();
    const panel = renderPanel("collapse");
    const header = panelHeader(panel);
    const headerChildren = Children.toArray(header.props.children);

    expect(renderToStaticMarkup(header)).toContain("h-7");
    expect(
      headerChildren.some((child) => isValidElement(child) && child.type === DetailTabStrip),
    ).toBe(true);
  });

  it("keeps the default full chrome expanded when content scrolls", () => {
    hooks.reset();
    const panel = renderPanel();
    const header = panelHeader(panel);
    const fold = visitElements(
      header,
      (element) =>
        typeof element.props.ref === "object" &&
        typeof element.props.className === "string" &&
        element.props.className.includes("translate-y-0 opacity-100 delay-50"),
    );
    expect(fold).not.toBeNull();
    (fold!.props.ref as { current: { scrollHeight: number } | null }).current = {
      scrollHeight: 64,
    };
    const content = Children.toArray(panel.props.children)[1] as ReactElement<{
      readonly onScrollCapture: (event: { target: HTMLElement }) => void;
    }>;
    content.props.onScrollCapture({
      target: {
        scrollTop: 128,
        parentElement: { hasAttribute: () => true },
      } as unknown as HTMLElement,
    });

    const markup = renderToStaticMarkup(panelHeader(renderPanel()));
    expect(markup.indexOf('aria-hidden="false"')).toBeLessThan(
      markup.indexOf('aria-hidden="true"'),
    );
  });

  it("renders Linear labels in the header, tooltips, menu, and aria attributes", () => {
    hooks.reset();
    const panel = renderPanel();
    const menu = visitElements(panel, (element) => element.type === Menu);
    expect(menu).not.toBeNull();

    const panelMarkup = renderToStaticMarkup(panel);
    const menuItem = visitElements(
      menu,
      (element) =>
        element.type === MenuItem && textContent(element.props.children).includes("Open on Linear"),
    );
    const solveTrigger = visitElements(
      panel,
      (element) =>
        element.type === TooltipTrigger && textContent(element.props.children).includes("Solve"),
    );
    const solveButton = visitElements(solveTrigger, (element) => element.type === Button);
    const solveTooltip = visitElements(
      panel,
      (element) =>
        element.type === TooltipPopup &&
        textContent(element.props.children) === "Opens a thread for this issue in a worktree",
    );
    const markup = renderToStaticMarkup(cloneElement(menu!, { open: true }));

    expect(panelMarkup).toContain('aria-label="Open on Linear"');
    expect(menuItem).not.toBeNull();
    expect(textContent(menuItem?.props.children)).toContain("Open on Linear");
    expect(solveButton).not.toBeNull();
    expect(solveButton?.props.title).toBeUndefined();
    expect(solveTooltip).not.toBeNull();
    // Base UI portals do not emit popup contents during SSR; the real open root still renders
    // here, while the MenuItem assertion above checks the child mounted in that root.
    expect(markup).toContain('aria-haspopup="menu"');
  });
});

it("opens Solve in a worktree even beside a thread for the same project", async () => {
  hooks.reset();
  commands.newThread.mockResolvedValueOnce(null);
  const panel = renderPanel(undefined, {
    kind: "existing-thread",
    projectRef: { environmentId: "environment-1" as EnvironmentId, projectId: detail.projectId },
    draftId: "existing-draft" as DraftId,
  });
  const trigger = visitElements(
    panel,
    (element) =>
      element.type === TooltipTrigger && textContent(element.props.children).includes("Solve"),
  );
  const button = visitElements(trigger, (element) => element.type === Button);
  (button!.props.onClick as () => void)();
  expect(commands.newThread).toHaveBeenCalledWith(
    { environmentId: "environment-1", projectId: detail.projectId },
    { envMode: "worktree", branch: null, worktreePath: null },
  );
  await Promise.resolve();
});

it.each(["comment-failed", "action-failed", "success"])(
  "handles comment and close without losing a posted comment: %s",
  async (outcome) => {
    hooks.reset();
    const failure = { _tag: "Failure", cause: Cause.fail(new Error("Host refused")) };
    commands.comment.mockResolvedValue(
      outcome === "comment-failed" ? failure : { _tag: "Success" },
    );
    commands.action.mockResolvedValue(outcome === "action-failed" ? failure : { _tag: "Success" });
    currentDetail = {
      ...detail,
      capabilities: { ...detail.capabilities, comment: true },
      viewerPermissions: { ...detail.viewerPermissions, comment: true },
    };
    const composer = visitElements(renderPanel(), (element) => element.type === CommentComposer);
    const onCommentAction = composer!.props.onCommentAction as (
      body: string,
      action: "close",
    ) => Promise<{ commentPosted: boolean }>;
    expect(await onCommentAction("Done", "close")).toEqual({
      commentPosted: outcome !== "comment-failed",
    });
    expect(commands.action).toHaveBeenCalledTimes(outcome === "comment-failed" ? 0 : 1);
    expect(commands.refresh).toHaveBeenCalledTimes(outcome === "comment-failed" ? 0 : 2);
  },
);

it.each([true, false])("offers issue writes only with write permission (%s)", (allowed) => {
  hooks.reset();
  permission.allowed = allowed;
  currentDetail = {
    ...detail,
    capabilities: { ...detail.capabilities, comment: true, edit: true, reactions: true },
    viewerPermissions: { ...detail.viewerPermissions, comment: true, edit: true, labels: true },
  };
  const panel = renderPanel();
  const summary = visitElements(panel, (element) => element.type === IssueSummaryTab)!;
  const shown = summary.props.detail as IssueDetail;
  expect(shown.title).toBe(detail.title);
  expect(shown.capabilities.reactions).toBe(allowed);
  expect(shown.viewerPermissions.edit).toBe(allowed);
  expect(shown.viewerPermissions.labels).toBe(allowed);
});

it("keeps the comment composer mounted while write access is withdrawn and restored", () => {
  hooks.reset();
  currentDetail = {
    ...detail,
    capabilities: { ...detail.capabilities, comment: true },
    viewerPermissions: { ...detail.viewerPermissions, comment: true },
  };
  const composer = () =>
    visitElements(renderPanel(), (element) => element.type === CommentComposer)!;
  const mounted = composer();
  expect(mounted.props.actionPending).toBe(false);
  permission.allowed = false;
  const revoked = composer();
  expect(revoked.key).toBe(mounted.key);
  expect(revoked.props.actionPending).toBe(true);
  permission.allowed = true;
  expect(composer().props.actionPending).toBe(false);
});

it("opens a related pull request through the thread issues panel handler", () => {
  hooks.reset();
  const onOpenLinkedPullRequest = vi.fn();
  const issues = IssuesPanel({
    environmentId: "environment-1" as EnvironmentId,
    projectId: detail.projectId,
    selected: { projectId: detail.projectId, repository: "acme/project", number: 42 },
    onSelect: vi.fn(),
    handoffTarget: { kind: "new-thread" },
    onStateChange: vi.fn(),
    onOpenLinkedPullRequest,
  });
  const panel = visitElements(
    (issues.type as (props: typeof issues.props) => ReactElement)(issues.props),
    (element) => element.type === IssueDetailPanel,
  )!;
  hooks.reset();
  const summary = visitElements(
    IssueDetailPanel(panel.props as Parameters<typeof IssueDetailPanel>[0]),
    (element) => element.type === IssueSummaryTab,
  )!;
  const link = {
    repository: "acme/project",
    number: 503,
    url: "https://github.com/acme/project/pull/503",
  };
  (summary.props.onOpenLinkedPullRequest as (value: typeof link) => void)(link);
  expect(onOpenLinkedPullRequest).toHaveBeenCalledWith(link);
});

it("blocks an open close confirmation while write access is revoked", async () => {
  hooks.reset();
  commands.action.mockResolvedValue({ _tag: "Success" });
  currentDetail = {
    ...detail,
    capabilities: { ...detail.capabilities, actions: ["close"], comment: true },
    viewerPermissions: { ...detail.viewerPermissions, actions: ["close"], comment: true },
  };
  const confirmButton = (panel: ReturnType<typeof IssueDetailPanel>) =>
    visitElements(
      panel,
      (element) => element.type === Button && element.props.children === "Close issue",
    )!;
  const closeItem = visitElements(
    renderPanel(),
    (element) => element.type === MenuItem && textContent(element.props.children) === "Close issue",
  );
  (closeItem!.props.onClick as () => void)();

  permission.allowed = false;
  let panel = renderPanel();
  expect(confirmButton(panel).props.disabled).toBe(true);
  (confirmButton(panel).props.onClick as () => void)();
  const composer = visitElements(panel, (element) => element.type === CommentComposer)!;
  expect(
    await (composer.props.onCommentAction as (body: string, action: "close") => Promise<unknown>)(
      "Done",
      "close",
    ),
  ).toEqual({ commentPosted: false });
  expect(commands.comment).not.toHaveBeenCalled();
  expect(commands.action).not.toHaveBeenCalled();
  panel = renderPanel();
  expect(visitElements(panel, (element) => element.type === AlertDialog)!.props.open).toBe(true);

  permission.allowed = true;
  panel = renderPanel();
  expect(confirmButton(panel).props.disabled).toBe(false);
  (confirmButton(panel).props.onClick as () => void)();
  await Promise.resolve();
  expect(commands.action).toHaveBeenCalledTimes(1);
});

it("replaces a pull request hand-off's prompt and chip when the issue is explained", async () => {
  hooks.reset();
  const target = "existing-draft" as DraftId;
  const own = { ...handoffChip("review-comment:own"), text: "mine" };
  useComposerDraftStore.getState().setPrompt(target, "Keep my draft");
  useComposerDraftStore.getState().setReviewComments(target, [own]);
  writeHandoffToComposer(target, {
    prompt: "Explain this pull request.",
    reviewComments: [handoffChip("pull-request-context:9")],
  });
  const panel = renderPanel(undefined, {
    kind: "existing-thread",
    projectRef: { environmentId: "environment-1" as EnvironmentId, projectId: detail.projectId },
    draftId: target,
  });
  const explain = visitElements(
    panel,
    (element) =>
      element.type === MenuItem && textContent(element.props.children).includes("Explain"),
  );
  await (explain!.props.onClick as () => Promise<void>)();
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  expect(draft?.reviewComments.map((comment) => comment.id)).toEqual([
    "review-comment:own",
    "issue-context:42",
  ]);
  expect(draft?.prompt).toContain("Keep my draft");
  expect(draft?.prompt).toContain("Explain this issue.");
  expect(draft?.prompt).not.toContain("Explain this pull request.");
});
