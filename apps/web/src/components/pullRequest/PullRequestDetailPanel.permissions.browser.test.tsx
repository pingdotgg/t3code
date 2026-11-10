import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { act, fakeTimers, render } from "../../../test/render";

const { permissions, reads } = vi.hoisted(() => ({
  permissions: { checkout: true, operate: true },
  reads: { detailPending: false, diff: [] as unknown[] },
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
    detailQuery: { isPending: reads.detailPending, refresh: vi.fn() },
    activityQuery: { isPending: false, refresh: vi.fn(), error: null },
    activity: null,
    sharedSummary: detail,
    coreDetail: detail,
    detail,
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
  useAtomCommand: (() => vi.fn()) as never,
}));

import { PullRequestDetailPanel } from "./PullRequestDetailPanel";

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

const environmentId = EnvironmentId.make("environment");
const draftId = DraftId.make("conflicts-draft");
const panel = (attach = false) => (
  <PullRequestDetailPanel
    environmentId={environmentId}
    reference={detail}
    context="page"
    shortcutsEnabled={false}
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
  reads.detailPending = false;
  reads.diff = [];
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
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

it("keeps the actions menu still while a shown pull request is read again in the background", async () => {
  setup();
  reads.detailPending = true;
  await using screen = await render(panel());
  await expect.element(screen.getByRole("button", { name: "Resolve conflicts" })).toBeVisible();
  expect(screen.getByRole("button", { name: /^Refreshing / }).query()).toBeNull();
  await expect.element(screen.getByRole("button", { name: /^More .* actions$/ })).toBeVisible();
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
