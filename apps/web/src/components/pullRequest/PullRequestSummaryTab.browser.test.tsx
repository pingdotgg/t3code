import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetailView,
  type PullRequestReviewThread,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

import { act, fakeTimers, render as renderUi } from "../../../test/render";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";

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
  mergeability: "mergeable",
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
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

// The comment filter persists to localStorage, so tests that touch it start and end empty.

const tab = (value = detail) => (
  <PullRequestSummaryTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    threadRef={null}
    reference={value}
    detail={value}
    activityPending={false}
    activityError={null}
    onRefresh={() => {}}
  />
);

async function render(value = detail) {
  const screen = await renderUi(tab(value));
  const { container } = screen;
  const heading = (title: string) => {
    const section = container.querySelector(`section[aria-label="${title}"]`);
    expect(section, `section ${title}`).not.toBeNull();
    return [...section!.querySelectorAll("button")].find(
      (button) => button.querySelector("span")?.textContent === title,
    )!;
  };
  return Object.assign(screen, {
    click: (title: string) => act(async () => heading(title).click()),
    expanded: (title: string) => heading(title).getAttribute("aria-expanded"),
    visibleText: () => container.innerText,
  });
}

it("updates comment ages without another panel render", async () => {
  using _timers = fakeTimers({ now: new Date("2026-09-01T00:05:00Z") });
  await using screen = await render({
    ...detail,
    commentCount: 1,
    comments: [
      {
        id: "comment",
        kind: "issue-comment",
        author: detail.author,
        body: "Review comment",
        createdAt: detail.createdAt,
        url: null,
        path: null,
        reviewState: null,
      },
    ],
  });
  const time = screen.container.querySelector("time")!;
  expect(time.textContent).toBe("5m ago");
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(time.textContent).toBe("6m ago");
});

it("keeps an unsaved description when collapsed and reopened", async () => {
  await using screen = await render();
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
  );
  const textarea = screen.container.querySelector("textarea")!;
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "Unsaved description");
  await screen.click("Description");
  expect(screen.expanded("Description")).toBe("false");
  await screen.click("Description");
  expect(screen.container.querySelector("textarea")!.value).toBe("Unsaved description");
});

function openThread(id: string, bot = false): PullRequestReviewThread {
  return {
    id,
    path: `src/${id}.ts`,
    line: 1,
    side: "right",
    isResolved: false,
    isOutdated: false,
    comments: [
      {
        id: `${id}-comment`,
        author: { ...detail.author!, isBot: bot },
        body: `Finding ${id}`,
        createdAt: detail.createdAt,
        url: null,
      },
    ],
  };
}

it("filters promoted bot threads while retaining human replies and bot verdicts", async () => {
  localStorage.removeItem("t3code:pull-request-comment-filter:v1");
  const mixed = openThread("mixed", true);
  await using screen = await render({
    ...detail,
    reviewThreads: [
      openThread("bot-only", true),
      {
        ...mixed,
        comments: [...mixed.comments, { ...openThread("human").comments[0]!, body: "Human reply" }],
      },
    ],
    comments: [
      {
        ...openThread("verdict", true).comments[0]!,
        kind: "review",
        path: null,
        reviewState: "CHANGES_REQUESTED",
        body: "Bot verdict",
      },
    ],
  });
  await expect.element(screen.getByText("Finding bot-only")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Finding mixed")).toBeVisible();
  await expect.element(screen.getByText("Human reply")).toBeVisible();
  await expect.element(screen.getByText("Bot verdict")).toBeVisible();
  await expect.element(screen.getByText("1 hidden", { exact: true })).toBeVisible();
});

it("pages promoted open threads together with the remaining conversations", async () => {
  localStorage.removeItem("t3code:pull-request-comment-filter:v1");
  await using screen = await render({
    ...detail,
    reviewThreads: Array.from({ length: 12 }, (_, index) => openThread(`thread-${index}`)),
    comments: [
      {
        ...openThread("loose").comments[0]!,
        kind: "issue-comment",
        path: null,
        reviewState: null,
        body: "Loose conversation",
      },
    ],
  });
  await expect.element(screen.getByText("Finding thread-9", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Finding thread-10", { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("Loose conversation")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Show 3 .*conversation/ }));
  await expect.element(screen.getByText("Finding thread-11", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Loose conversation")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show only 10 recent conversations" }));
  await expect
    .element(screen.getByText("Finding thread-10", { exact: true }))
    .not.toBeInTheDocument();
});
