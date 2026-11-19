import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ command: vi.fn() }));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.command) as never,
}));

import { render } from "../../../test/render";
import "../../index.css";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";

const COMMITS = 2000;

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Huge pull request",
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
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: Array.from({ length: COMMITS }, (_, index) => ({
    oid: `${index.toString(16).padStart(7, "0")}${"0".repeat(33)}`,
    messageHeadline: `Commit number ${index}`,
    committedDate: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
  })),
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

it("mounts only the timeline rows near the viewport of a huge pull request", async () => {
  await using screen = await render(
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={detail}
        environmentId={EnvironmentId.make("environment")}
        reference={detail}
        order="oldest"
        onOpenCommit={() => {}}
        onRefresh={() => {}}
      />
    </div>,
  );
  await expect.element(screen.getByText("Commit number 0")).toBeVisible();
  const mounted = screen.container.querySelectorAll("button").length;
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(COMMITS / 10);
});

it.each(["review", "issue-comment", "resolved-reply", "bot-comment"] as const)(
  "reveals a linked %s below the virtual viewport",
  async (kind) => {
    const url = `${detail.url}#${kind === "review" ? "pullrequestreview-123" : kind === "resolved-reply" ? "discussion_r123" : "issuecomment-123"}`;
    const linkedDetail: PullRequestDetailView = {
      ...detail,
      comments:
        kind === "resolved-reply"
          ? []
          : [
              {
                id: "linked",
                kind: kind === "bot-comment" ? "issue-comment" : kind,
                author: {
                  login: "author",
                  name: null,
                  avatarUrl: null,
                  isBot: kind === "bot-comment",
                },
                body: "Linked reply",
                createdAt: "2026-10-01T00:00:00Z",
                url,
                path: null,
                reviewState: kind === "review" ? "CHANGES_REQUESTED" : null,
              },
            ],
      reviewThreads:
        kind !== "resolved-reply"
          ? []
          : [
              {
                id: "thread",
                path: "src/test.ts",
                line: 5,
                side: "right",
                isResolved: true,
                isOutdated: false,
                comments: [
                  {
                    id: "root",
                    author: detail.author,
                    body: "Root comment",
                    createdAt: "2026-10-01T00:00:00Z",
                    url: `${detail.url}#discussion_r122`,
                  },
                  {
                    id: "reply",
                    author: detail.author,
                    body: "Linked reply",
                    createdAt: "2026-10-01T00:01:00Z",
                    url,
                  },
                ],
              },
            ],
    };
    const settled = vi.fn();
    await using screen = await render(
      <div style={{ height: 600 }}>
        <PullRequestTimelineTab
          scrollerRef={() => {}}
          detail={linkedDetail}
          environmentId={EnvironmentId.make("environment")}
          reference={detail}
          order="oldest"
          // The saved defaults hide resolved threads; a link must land anyway.
          filter={{ bots: false, resolved: false }}
          onOpenCommit={() => {}}
          onRefresh={() => {}}
          revealUrl={url}
          onRevealSettled={settled}
        />
      </div>,
    );
    await expect.element(screen.getByText("Linked reply", { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(url));
    await screen.rerender(
      <div style={{ height: 600 }}>
        <PullRequestTimelineTab
          scrollerRef={() => {}}
          detail={linkedDetail}
          environmentId={EnvironmentId.make("environment")}
          reference={detail}
          order="oldest"
          filter={{ bots: false, resolved: false }}
          onOpenCommit={() => {}}
          onRefresh={() => {}}
          onRevealSettled={settled}
        />
      </div>,
    );
    await expect.element(screen.getByText("Linked reply", { exact: true })).toBeVisible();
  },
);

it("fixes an overview thread as its opening remark, since it has no line to attach", async () => {
  const author = { login: "reviewer", name: null, avatarUrl: null };
  const note = { author, createdAt: "2026-09-01T00:00:00Z", url: null };
  const remark = {
    ...note,
    id: "10",
    kind: "review-comment" as const,
    body: "Mention the flag in the README",
    path: null,
    reviewState: null,
  };
  const value: PullRequestDetailView = {
    ...detail,
    commits: [],
    comments: [remark],
    overviewThreads: [
      {
        id: "overview",
        path: null,
        line: null,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [{ ...note, id: "10", body: remark.body }],
      },
    ],
  };
  const onFixFinding = vi.fn();
  await using screen = await render(
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={value}
        environmentId={EnvironmentId.make("environment")}
        reference={value}
        order="oldest"
        onOpenCommit={() => {}}
        onRefresh={() => {}}
        onFixFinding={onFixFinding}
      />
    </div>,
  );

  await screen.getByRole("button", { name: "Fix in a thread" }).click();
  expect(onFixFinding).toHaveBeenCalledWith({ kind: "comment", comment: remark });
});

it("hides bot comments under the saved filter and shows them when the filter allows", async () => {
  const value: PullRequestDetailView = {
    ...detail,
    commits: [],
    comments: [
      {
        id: "bot",
        kind: "issue-comment",
        author: { login: "ci-bot", name: null, avatarUrl: null, isBot: true },
        body: "Deployed a preview",
        createdAt: "2026-09-01T00:00:00Z",
        url: null,
        path: null,
        reviewState: null,
      },
    ],
  };
  const timeline = (filter: { bots: boolean; resolved: boolean }) => (
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={value}
        environmentId={EnvironmentId.make("environment")}
        reference={value}
        order="oldest"
        filter={filter}
        onOpenCommit={() => {}}
        onRefresh={() => {}}
      />
    </div>
  );
  await using screen = await render(timeline({ bots: false, resolved: false }));
  await expect.element(screen.getByText("opened this pull request")).toBeVisible();
  expect(screen.container.textContent).not.toContain("1 comment");

  await screen.rerender(timeline({ bots: true, resolved: false }));
  await expect.element(screen.getByText("1 comment")).toBeVisible();
});

it("adds a review thread to the chat as its whole conversation", async () => {
  const note = { author: detail.author, createdAt: "2026-09-01T00:00:00Z", url: null };
  const thread = {
    id: "thread",
    path: "src/a.ts",
    line: 3,
    side: "right" as const,
    isResolved: false,
    isOutdated: false,
    comments: [
      { ...note, id: "root", body: "Rename this." },
      { ...note, id: "reply", body: "Done.", createdAt: "2026-09-02T00:00:00Z" },
    ],
  };
  const value: PullRequestDetailView = { ...detail, commits: [], reviewThreads: [thread] };
  const onAddToChat = vi.fn();
  await using screen = await render(
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={value}
        environmentId={EnvironmentId.make("environment")}
        reference={value}
        order="oldest"
        onOpenCommit={() => {}}
        onRefresh={() => {}}
        onAddToChat={onAddToChat}
      />
    </div>,
  );

  await screen.getByRole("button", { name: "Add to chat" }).click();
  expect(onAddToChat).toHaveBeenCalledWith({
    kind: "thread",
    thread: expect.objectContaining({
      id: "thread",
      comments: [expect.objectContaining({ id: "root" }), expect.objectContaining({ id: "reply" })],
    }),
  });
});

it("keeps an unsent reply when resolving the thread remounts its row", async () => {
  const note = { author: detail.author, createdAt: "2026-09-01T00:00:00Z", url: null };
  const value = (isResolved: boolean): PullRequestDetailView => ({
    ...detail,
    number: 77,
    commits: [],
    capabilities: {
      ...detail.capabilities,
      review: { ...detail.capabilities.review, reply: true },
    },
    viewerPermissions: { ...detail.viewerPermissions, comment: true },
    reviewThreads: [
      {
        id: "draft-thread",
        path: "src/a.ts",
        line: 3,
        side: "right",
        isResolved,
        isOutdated: false,
        comments: [{ ...note, id: "draft-root", body: "Rename this." }],
      },
    ],
  });
  const timeline = (isResolved: boolean) => (
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={value(isResolved)}
        environmentId={EnvironmentId.make("environment")}
        reference={value(isResolved)}
        order="oldest"
        onOpenCommit={() => {}}
        onRefresh={() => {}}
      />
    </div>
  );
  await using screen = await render(timeline(false));
  await screen.getByRole("button", { name: "Reply", exact: true }).click();
  await screen.getByRole("textbox", { name: "Reply to this conversation" }).fill("Unsent");

  await screen.rerender(timeline(true));
  await screen.getByRole("button", { name: /src\/a\.ts/ }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Reply to this conversation" }))
    .toHaveValue("Unsent");
});

it("posts a reply once even when its row remounts while it is sending", async () => {
  state.command.mockReset();
  let finish = (_result: unknown) => {};
  state.command.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  const note = { author: detail.author, createdAt: "2026-09-01T00:00:00Z", url: null };
  const value: PullRequestDetailView = {
    ...detail,
    number: 78,
    commits: [],
    capabilities: {
      ...detail.capabilities,
      review: { ...detail.capabilities.review, reply: true },
    },
    viewerPermissions: { ...detail.viewerPermissions, comment: true },
    reviewThreads: [
      {
        id: "sending-thread",
        path: "src/a.ts",
        line: 3,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [{ ...note, id: "sending-root", body: "Rename this." }],
      },
    ],
  };
  const timeline = () => (
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={value}
        environmentId={EnvironmentId.make("environment")}
        reference={value}
        order="oldest"
        onOpenCommit={() => {}}
        onRefresh={() => {}}
      />
    </div>
  );
  {
    await using first = await render(timeline());
    await first.getByRole("button", { name: "Reply", exact: true }).click();
    await first.getByRole("textbox", { name: "Reply to this conversation" }).fill("Once");
    await first.getByRole("button", { name: "Reply", exact: true }).click();
    expect(state.command).toHaveBeenCalledTimes(1);
  }

  // The row mounts again while the reply is still on its way.
  await using screen = await render(timeline());
  const send = screen.getByRole("button", { name: "Reply", exact: true });
  await expect.element(send).toBeDisabled();
  expect(state.command).toHaveBeenCalledTimes(1);

  finish({ _tag: "Success", value: undefined });
  await expect
    .element(screen.getByRole("textbox", { name: "Reply to this conversation" }))
    .not.toBeInTheDocument();
  expect(state.command).toHaveBeenCalledTimes(1);
});
