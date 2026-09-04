import {
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointSummary,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canReadFiles: true,
  checkpoints: [] as ReadonlyArray<OrchestrationCheckpointSummary>,
}));

vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: () => {},
  useMemo: <A>(factory: () => A) => factory(),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.canReadFiles,
}));
vi.mock("../../state/use-thread-detail", () => ({
  useSelectedThreadDetail: () => ({ checkpoints: state.checkpoints }),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));
vi.mock("../../state/queries", () => ({
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));
vi.mock("../../state/review", () => ({
  reviewEnvironment: { diffPreview: vi.fn() },
}));
vi.mock("./reviewState", () => ({
  setReviewAsyncError: vi.fn(),
  setReviewGitSections: vi.fn(),
  setReviewSelectedSectionId: vi.fn(),
  setReviewTurnDiff: vi.fn(),
  setReviewTurnDiffLoading: vi.fn(),
}));

import type { ReviewCacheForThread } from "./reviewState";
import { useReviewSections } from "./useReviewSections";

it("hides cached local diffs after file access is lost while retaining checkpoint diffs", () => {
  state.checkpoints = [
    {
      turnId: TurnId.make("turn-1"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread/1"),
      status: "ready",
      files: [],
      assistantMessageId: MessageId.make("message-1"),
      completedAt: "2026-04-01T00:00:00.000Z",
    },
  ];
  const checkpointDiff = "diff --git a/checkpoint.ts b/checkpoint.ts";
  const localDiff = "diff --git a/local.ts b/local.ts";
  const reviewCache: ReviewCacheForThread = {
    threadKey: "environment:thread",
    gitSections: [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Dirty worktree",
        baseRef: "HEAD",
        headRef: null,
        diff: localDiff,
        diffHash: "cached-local",
        truncated: false,
      },
    ],
    turnDiffById: { "turn:1": checkpointDiff },
    selectedSectionId: "git:working-tree",
    asyncState: { loadingTurnIds: {}, error: null },
    expandedFileIdsBySection: {},
    revealedLargeFileIdsBySection: {},
    viewedFileIdsBySection: {},
  };
  const input = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    reviewCache,
  };

  state.canReadFiles = true;
  expect(useReviewSections(input).selectedSection?.diff).toBe(localDiff);

  state.canReadFiles = false;
  const denied = useReviewSections(input);
  expect(denied.reviewSections.map((section) => section.id)).toEqual(["turn:1"]);
  expect(denied.selectedSection?.diff).toBe(checkpointDiff);

  state.canReadFiles = true;
  expect(useReviewSections(input).selectedSection?.diff).toBe(localDiff);
});
