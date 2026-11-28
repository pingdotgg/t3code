import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetail,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { RightPanelSheet } from "../RightPanelSheet";
import { PullRequestTitleEditor } from "./PullRequestTitleEditor";

const detail: PullRequestDetail = {
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
  checks: [],
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

it("Escape cancels the title edit without closing the right panel sheet", async () => {
  const onCloseSheet = vi.fn();
  await using _screen = await render(
    <RightPanelSheet animationDurationMs={0} open onClose={onCloseSheet}>
      <PullRequestTitleEditor
        environmentId={EnvironmentId.make("environment")}
        reference={{ projectId: detail.projectId, repository: "owner/repo", number: 1 }}
        pullRequestKey="owner/repo#1"
        detail={detail}
        canWriteSourceControl
      />
    </RightPanelSheet>,
  );
  await act(() =>
    (page.getByRole("button", { name: "Edit title" }).element() as HTMLElement).click(),
  );
  const input = page.getByRole("textbox", { name: "Pull request title" });
  await expect.element(input).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await expect.element(input).not.toBeInTheDocument();
  expect(onCloseSheet).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  expect(onCloseSheet).toHaveBeenCalledTimes(1);
});
