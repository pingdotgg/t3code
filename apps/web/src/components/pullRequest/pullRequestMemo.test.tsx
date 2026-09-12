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
  return {
    provider: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: [],
      mergeMethods: [],
      search: false,
      review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
      reviewers: { request: false, listCandidates: false },
    },
    viewerPermissions: {
      actions: [],
      comment: true,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
    },
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
    reviewers: [],
    labels: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    comments,
    commentCount: comments.length,
    commentsTruncated: false,
    reviewThreads: [],
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

    // The same conversation behind a panel re-render: no rebuild.
    await act(() => {
      renderer?.update(<PullRequestTimelineTab {...base} />);
    });
    expect(buildCalls.timeline).toBe(1);

    // Flipping the reading order re-sorts the built events rather than rebuilding them.
    await act(() => {
      renderer?.update(<PullRequestTimelineTab {...base} order="oldest" />);
    });
    expect(buildCalls.timeline).toBe(1);

    // A new conversation still rebuilds, exactly once.
    await act(() => {
      renderer?.update(
        <PullRequestTimelineTab {...base} detail={{ ...detail, title: "Changed" }} />,
      );
    });
    expect(buildCalls.timeline).toBe(2);
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
      actionPending: false,
      onCommentAction: async () => ({ commentPosted: false }),
      onRefresh: () => {},
    };
    await act(() => {
      renderer = create(<PullRequestSummaryTab {...base} />);
    });
    expect(buildCalls.outcomes).toBe(1);

    // The same conversation behind a panel re-render (a tab switch, a handoff, a
    // draft-store update): no rescan.
    await act(() => {
      renderer?.update(<PullRequestSummaryTab {...base} />);
    });
    expect(buildCalls.outcomes).toBe(1);

    // Unrelated panel state (an action arming, a finding handing off) reads the same way.
    await act(() => {
      renderer?.update(
        <PullRequestSummaryTab {...base} actionPending pendingFinding="finding:1" />,
      );
    });
    expect(buildCalls.outcomes).toBe(1);

    // Keystrokes in the composer below stay inside CommentComposer's own `body` state, so
    // they never re-render this tab at all — there is no rescan to count. The actionPending
    // flip above is the panel-level re-render a typing-adjacent flow drives through this tab.

    // A rebuilt detail wrapper over the same conversation still skips the scan: the memos
    // are keyed by the comment and commit arrays, not by the wrapper's identity.
    await act(() => {
      renderer?.update(<PullRequestSummaryTab {...base} detail={{ ...detail }} />);
    });
    expect(buildCalls.outcomes).toBe(1);

    // A new conversation still rescans, exactly once.
    await act(() => {
      renderer?.update(
        <PullRequestSummaryTab {...base} detail={{ ...detail, comments: [...detail.comments] }} />,
      );
    });
    expect(buildCalls.outcomes).toBe(2);
  });
});
