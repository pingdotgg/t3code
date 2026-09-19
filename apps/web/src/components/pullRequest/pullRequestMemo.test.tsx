import type {
  EnvironmentId,
  ProjectId,
  PullRequestComment,
  PullRequestDetailView,
  PullRequestRef,
} from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";

import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import type * as logic from "./pullRequestDetail.logic";

/**
 * The tooltip's floating-ui effects need a real window, which the node test project does
 * not have. The memoization under test does not depend on how a tooltip floats, so the
 * trigger's content renders inline and the popup stays shut.
 */
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  TooltipPopup: () => null,
}));

/**
 * How many times the full-conversation builders ran. The tabs memoize them, so an
 * unrelated re-render — a keystroke in the composer, a tab switch, a reading-order flip —
 * must not run them again. Only a new conversation may.
 */
const buildCalls = vi.hoisted(() => ({ outcomes: 0, timeline: 0 }));

vi.mock("./pullRequestDetail.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof logic>();
  return {
    ...actual,
    latestPullRequestReviewOutcomes: (
      ...args: Parameters<typeof actual.latestPullRequestReviewOutcomes>
    ) => {
      buildCalls.outcomes += 1;
      return actual.latestPullRequestReviewOutcomes(...args);
    },
    buildPullRequestTimeline: (...args: Parameters<typeof actual.buildPullRequestTimeline>) => {
      buildCalls.timeline += 1;
      return actual.buildPullRequestTimeline(...args);
    },
  };
});

const ENVIRONMENT_ID = "env-memo" as EnvironmentId;
const REFERENCE = {
  projectId: "proj-memo",
  repository: "acme/app",
  number: 42,
} as PullRequestRef;

function discussionComment(index: number): PullRequestComment {
  return {
    id: `comment-${index}`,
    kind: "issue-comment",
    author: { login: `reviewer-${index % 25}`, name: null, avatarUrl: null },
    body: `Comment ${index} on the change.`,
    // Minutes overflow into hours and days, so every remark keeps its own instant.
    createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    url: null,
    path: null,
    reviewState: null,
  };
}

/** A large-discussion pull request: hundreds of remarks, one commit, no threads. */
function discussionDetail(commentCount: number): PullRequestDetailView {
  const comments = Array.from({ length: commentCount }, (_, index) => discussionComment(index));
  const ada = { login: "ada", name: "Ada Lovelace", avatarUrl: null };
  // The newest remarks, so they sit inside the recent window both tabs read: a standing
  // approval (reviewer row + badge), a remark the viewer may rewrite (pencil), and a
  // resolved line thread (collapsed card). These populate the reviewerEntries,
  // threadByCommentId and editable memos the discussion alone leaves empty.
  const approval: PullRequestComment = {
    id: "review-approval",
    kind: "review",
    author: ada,
    body: "Looks good to me.",
    createdAt: new Date(Date.UTC(2026, 7, 2, 0, 0)).toISOString(),
    url: null,
    path: null,
    reviewState: "APPROVED",
  };
  const editable: PullRequestComment = {
    id: "comment-editable",
    kind: "issue-comment",
    author: ada,
    body: "A note I can rewrite.",
    createdAt: new Date(Date.UTC(2026, 7, 2, 0, 1)).toISOString(),
    url: null,
    path: null,
    reviewState: null,
    reactions: [{ content: "thumbs-up", count: 2, actors: ["bilal"], viewerHasReacted: false }],
  };
  const threaded: PullRequestComment = {
    id: "comment-thread-1",
    kind: "review-comment",
    author: { login: "bilal", name: null, avatarUrl: null },
    body: "A line note that got resolved.",
    createdAt: new Date(Date.UTC(2026, 7, 2, 0, 2)).toISOString(),
    url: null,
    path: "src/app.ts",
    reviewState: null,
  };
  return {
    provider: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: [],
      mergeMethods: [],
      search: false,
      reactions: true,
      review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
      reviewers: { request: false, listCandidates: false },
      edit: { changeRequest: false, comment: true },
    },
    viewerPermissions: {
      actions: [],
      comment: true,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
    },
    viewer: "ada",
    projectId: "proj-memo" as ProjectId,
    projectTitle: "app",
    workspaceRoot: "/tmp/app",
    repository: "acme/app",
    number: 42,
    title: "Memoize the pull request tabs",
    body: "A description.",
    url: "https://github.com/acme/app/pull/42",
    author: { login: "octocat", name: null, avatarUrl: null },
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    headBranch: "memo",
    baseBranch: "main",
    createdAt: new Date(Date.UTC(2026, 7, 1)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 7, 2)).toISOString(),
    mergedAt: null,
    closedAt: null,
    reviewers: [ada],
    labels: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    comments: [...comments, approval, editable, threaded],
    commentCount: comments.length + 3,
    commentsTruncated: false,
    reviewThreads: [
      {
        id: "thread-1",
        path: "src/app.ts",
        line: 10,
        side: "right",
        isResolved: true,
        isOutdated: false,
        comments: [
          {
            id: "comment-thread-1",
            author: { login: "bilal", name: null, avatarUrl: null },
            body: "A line note that got resolved.",
            createdAt: new Date(Date.UTC(2026, 7, 2, 0, 2)).toISOString(),
            url: null,
          },
        ],
      },
    ],
    commits: [
      {
        oid: "abc1234",
        messageHeadline: "First",
        committedDate: new Date(Date.UTC(2026, 7, 1)).toISOString(),
      },
    ],
    reactions: [],
  } as PullRequestDetailView;
}

/** The rendered page as text: memo tests must show the derives still read right, not just rarely. */
function renderedText(): string {
  return JSON.stringify(renderer?.toJSON() ?? null);
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The node test project has no window. Mount effects subscribe to storage events and
  // read persisted preferences through it; the memoization under test never writes, so
  // a listener sink plus an empty storage is enough to mount headlessly.
  vi.stubGlobal("window", {
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  });
  buildCalls.outcomes = 0;
  buildCalls.timeline = 0;
});

afterEach(async () => {
  // Unmount inside act while the window stub is still in place: the unmount flushes the
  // useLocalStorage/useTheme passive-effect cleanups, which call window.removeEventListener.
  // Unstubbing first (or unmounting outside act) lets those cleanups run after the stub is
  // gone, which surfaces as `window is not defined` unhandled errors.
  await act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("pull request tab memoization", () => {
  it("builds the timeline once while the panel re-renders around the same detail", async () => {
    const detail = discussionDetail(60);
    const base = {
      detail,
      environmentId: ENVIRONMENT_ID,
      reference: REFERENCE,
      order: "newest" as const,
      onOpenCommit: () => {},
      onRefresh: () => {},
    };
    await act(() => {
      renderer = create(<PullRequestTimelineTab {...base} />);
    });
    expect(buildCalls.timeline).toBe(1);
    // The derives read right, not just rarely: the standing verdict, the commit headline
    // and the lifecycle row all come out of the memoized event list. (Conversation bodies
    // stay inside their collapsed groups until opened, so they cannot prove anything here.)
    expect(renderedText()).toContain("Approved");
    expect(renderedText()).toContain("First");
    expect(renderedText()).toContain("Pull request opened");

    // The same conversation behind a panel re-render: no rebuild.
    await act(() => {
      renderer?.update(<PullRequestTimelineTab {...base} />);
    });
    expect(buildCalls.timeline).toBe(1);
    expect(renderedText()).toContain("Approved");

    // Flipping the reading order re-sorts the built events rather than rebuilding them.
    await act(() => {
      renderer?.update(<PullRequestTimelineTab {...base} order="oldest" />);
    });
    expect(buildCalls.timeline).toBe(1);

    // A title-only wrapper update over the same conversation does not rebuild.
    await act(() => {
      renderer?.update(
        <PullRequestTimelineTab {...base} detail={{ ...detail, title: "Changed" }} />,
      );
    });
    expect(buildCalls.timeline).toBe(1);
    expect(renderedText()).toContain("Approved");

    // A new commit is a timeline input too: the branch moved, so the events rebuild.
    await act(() => {
      renderer?.update(
        <PullRequestTimelineTab
          {...base}
          detail={{
            ...detail,
            commits: [
              ...detail.commits,
              {
                oid: "def5678",
                messageHeadline: "Second",
                committedDate: new Date(Date.UTC(2026, 8, 1)).toISOString(),
              },
            ],
          }}
        />,
      );
    });
    expect(buildCalls.timeline).toBe(2);
    // The new commit's headline comes out of the rebuilt list, and the approval it
    // overtook reads as stale rather than current.
    expect(renderedText()).toContain("Second");
    expect(renderedText()).toContain("before the latest commits");

    // A new conversation still rebuilds, exactly once.
    await act(() => {
      renderer?.update(
        <PullRequestTimelineTab
          {...base}
          detail={{ ...detail, comments: [...detail.comments, discussionComment(60)] }}
        />,
      );
    });
    expect(buildCalls.timeline).toBe(3);
    expect(renderedText()).toContain("Approved");
  });

  it("does not rescan a 500-comment conversation on panel re-renders", async () => {
    const detail = discussionDetail(500);
    const base = {
      environmentId: ENVIRONMENT_ID,
      threadRef: null,
      reference: REFERENCE,
      detail,
      activityPending: false,
      activityError: null,
      onRefresh: () => {},
    };
    await act(() => {
      renderer = create(<PullRequestSummaryTab {...base} />);
    });
    expect(buildCalls.outcomes).toBe(1);
    // The populated derives read right: the reviewer's standing verdict, the resolved
    // thread's card, the pencil on the viewer's own remark, and the recent window's bodies.
    expect(renderedText()).toContain("Approved");
    expect(renderedText()).toContain("Resolved");
    expect(renderedText()).toContain("Edit comment");
    expect(renderedText()).toContain("Looks good to me.");
    expect(renderedText()).toContain("A note I can rewrite.");
    expect(renderedText()).toContain("Comment 499 on the change.");
    expect(renderedText()).not.toContain("Comment 400 on the change.");

    // The same conversation behind a panel re-render (a tab switch, a handoff, a
    // draft-store update): no rescan.
    await act(() => {
      renderer?.update(<PullRequestSummaryTab {...base} />);
    });
    expect(buildCalls.outcomes).toBe(1);

    // Unrelated panel state (an activity load, a finding handing off) reads the same way.
    // The comment composer now floats as a panel sibling, so action arming no longer
    // reaches this tab; activityPending is the panel-driven prop that does.
    await act(() => {
      renderer?.update(
        <PullRequestSummaryTab {...base} activityPending pendingFinding="finding:1" />,
      );
    });
    expect(buildCalls.outcomes).toBe(1);
    // The verdict row lives outside the conversation, so it stays while the activity
    // load replaces the comments with their skeleton: same panel re-render, no rescan.
    expect(renderedText()).toContain("Approved");
    expect(renderedText()).toContain("Loading pull request conversation");
    expect(renderedText()).not.toContain("Resolved");

    // Keystrokes in the floating composer stay inside PullRequestCommentComposer's own
    // `body` state, so they never re-render this tab at all — there is no rescan to
    // count. The activityPending flip above is the panel-level re-render that reaches
    // this tab while the conversation stays the same.

    // A rebuilt detail wrapper over the same conversation still skips the scan: the memos
    // are keyed by the comment and commit arrays, not by the wrapper's identity. The load
    // is over, so the thread card and the pencil read again.
    await act(() => {
      renderer?.update(<PullRequestSummaryTab {...base} detail={{ ...detail }} />);
    });
    expect(buildCalls.outcomes).toBe(1);
    expect(renderedText()).toContain("Resolved");
    expect(renderedText()).toContain("Edit comment");

    // A new conversation still rescans, exactly once.
    await act(() => {
      renderer?.update(
        <PullRequestSummaryTab {...base} detail={{ ...detail, comments: [...detail.comments] }} />,
      );
    });
    expect(buildCalls.outcomes).toBe(2);

    // A new commit is a verdict input too: the branch moved, so the scan runs again.
    await act(() => {
      renderer?.update(
        <PullRequestSummaryTab
          {...base}
          detail={{
            ...detail,
            commits: [
              ...detail.commits,
              {
                oid: "def5678",
                messageHeadline: "Second",
                committedDate: new Date(Date.UTC(2026, 8, 1)).toISOString(),
              },
            ],
          }}
        />,
      );
    });
    expect(buildCalls.outcomes).toBe(3);
    // The approval now speaks for older code, but the verdict still reads on the row —
    // qualified as earlier changes, which only the stale branch renders.
    expect(renderedText()).toContain("Approved");
    expect(renderedText()).toContain("earlier changes");
  });
});
