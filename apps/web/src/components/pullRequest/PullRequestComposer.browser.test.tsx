import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => mocks.post) as never,
}));

import { PullRequestComposer } from "./PullRequestComposer";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "reviewer",
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
  checks: [],
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
    review: {
      inlineComment: false,
      reply: false,
      resolve: false,
      verdicts: ["comment", "approve"],
    },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: ["comment", "approve"],
    requestReviewers: false,
  },
};

const composer = (
  <PullRequestComposer
    environmentId={EnvironmentId.make("environment")}
    reference={detail}
    detail={detail}
    actionPending={false}
    onCommentAction={async () => ({ commentPosted: false })}
    onCommented={() => {}}
    onReviewSubmitted={() => {}}
    compact={false}
  />
);

it("expands the bar into a focused composer and collapses on Escape, keeping the draft", async () => {
  await using screen = await render(composer);
  const bar = screen.getByRole("button", { name: "Comment on pull request" });
  await userEvent.click(bar);
  const textarea = screen.getByRole("textbox", { name: "Comment on this pull request" });
  await expect.element(textarea).toHaveFocus();

  await userEvent.type(textarea, "Draft note");
  await userEvent.keyboard("{Escape}");
  await expect.element(bar).toHaveFocus();

  await userEvent.click(bar);
  await expect.element(textarea).toHaveValue("Draft note");
  await expect.element(textarea).toHaveFocus();
});

it("closes only the verdict menu on Escape", async () => {
  await using screen = await render(composer);
  await userEvent.click(screen.getByRole("button", { name: "Comment on pull request" }));
  await userEvent.click(screen.getByRole("button", { name: "Review", exact: true }));
  await userEvent.click(screen.getByRole("combobox", { name: "Review verdict" }));
  await expect.element(page.getByRole("option", { name: "Approve" })).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("option", { name: "Approve" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("textbox", { name: "Review summary" })).toBeVisible();
});

it("returns focus to the bar after posting unless the user moved it elsewhere", async () => {
  mocks.post.mockReset();
  mocks.post.mockResolvedValueOnce({ _tag: "Success" });
  await using screen = await render(
    <>
      <input aria-label="Elsewhere" />
      {composer}
    </>,
  );
  const bar = screen.getByRole("button", { name: "Comment on pull request" });
  const textarea = screen.getByRole("textbox", { name: "Comment on this pull request" });
  const post = async () => {
    await userEvent.click(bar);
    await userEvent.type(textarea, "Note");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
  };

  await post();
  await expect.element(bar).toHaveFocus();

  let finish = (_result: { _tag: "Success" }) => {};
  mocks.post.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  await post();
  const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
  await userEvent.click(elsewhere);
  await act(async () => finish({ _tag: "Success" }));
  await expect.element(bar).toBeVisible();
  await expect.element(elsewhere).toHaveFocus();
});
