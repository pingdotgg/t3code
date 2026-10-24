import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ThreadId,
  RunId,
  type AuthSessionState,
} from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes" | "permissions"> | null,
  sessionError: null as string | null,
  sessionAtom: {},
  effects: [] as Array<() => void>,
  checkpoints: [] as ReadonlyArray<ThreadCheckpointSummary>,
  gitSections: [] as ReadonlyArray<import("@t3tools/contracts").ReviewDiffPreviewSource>,
  gitAtom: {},
  turnAtom: {},
}));

vi.mock("@t3tools/client-runtime/state/thread-checkpoints", () => ({
  deriveThreadCheckpointSummaries: () => state.checkpoints,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === state.gitAtom
      ? state.gitSections
      : atom === state.turnAtom
        ? { 1: checkpointDiff }
        : [],
}));
vi.mock("../../state/reviewTurnDiffs", () => ({ lastReviewTurnDiffsAtom: () => state.turnAtom }));
vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: (effect: () => void) => state.effects.push(effect),
  useMemo: <A>(factory: () => A) => factory(),
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  }),
}));
vi.mock("../../state/use-thread-detail", () => ({
  useSelectedThreadProjection: () => ({ projection: {} }),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === state.sessionAtom ? state.session : null,
    error: atom === state.sessionAtom ? state.sessionError : null,
    isPending: atom === state.sessionAtom && state.session === null,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/queries", () => ({
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));
vi.mock("../../state/review", () => ({
  reviewEnvironment: { diffPreview: vi.fn() },
  lastReviewGitSectionsAtom: () => state.gitAtom,
}));
vi.mock("./reviewState", () => ({
  setReviewAsyncError: vi.fn(),
  setReviewGitSections: vi.fn(),
  setReviewSelectedSectionId: vi.fn(),
  setReviewTurnDiff: vi.fn(),
  setReviewTurnDiffLoading: vi.fn(),
}));

import { setReviewSelectedSectionId, type ReviewCacheForThread } from "./reviewState";
import { useReviewSections } from "./useReviewSections";

beforeEach(() => {
  vi.clearAllMocks();
  state.effects = [];
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionError = null;
  state.checkpoints = [
    {
      runId: RunId.make("turn-1"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread/1"),
      status: "ready",
      files: [],
      assistantMessageId: MessageId.make("message-1"),
      completedAt: "2026-04-01T00:00:00.000Z",
    },
  ];
});

const checkpointDiff = "diff --git a/checkpoint.ts b/checkpoint.ts";
const localDiff = "diff --git a/local.ts b/local.ts";
function makeReviewCache(
  kind: "working-tree" | "branch-range" = "working-tree",
): ReviewCacheForThread {
  state.gitSections = [
    {
      id: kind,
      kind,
      title: "Dirty worktree",
      baseRef: "HEAD",
      headRef: null,
      diff: localDiff,
      diffHash: "cached-local",
      truncated: false,
    },
  ];
  return {
    threadKey: "environment:thread",
    selectedSectionId: `git:${kind}`,
    expandedFileIdsBySection: {},
    revealedLargeFileIdsBySection: {},
    viewedFileIdsBySection: {},
  };
}

function makeInput(reviewCache = makeReviewCache()) {
  return {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    reviewCache,
  };
}

function renderSections(input: Parameters<typeof useReviewSections>[0]) {
  const result = useReviewSections(input);
  const effects = state.effects.splice(0);
  effects.forEach((effect) => effect());
  return result;
}

it("keeps an opened file on its requested comparison without changing the overview selection", () => {
  const input = makeInput();
  const opened = renderSections({ ...input, selectedSectionId: "turn:1" });
  expect(opened.selectedSection?.diff).toBe(checkpointDiff);
  expect(input.reviewCache.selectedSectionId).toBe("git:working-tree");
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();
});

it("does not expose a forced local comparison after filesystem access is denied", () => {
  state.session = { authenticated: true, scopes: [] };
  const opened = renderSections({ ...makeInput(), selectedSectionId: "git:working-tree" });
  expect(opened.selectedSection?.diff).toBe(checkpointDiff);
  expect(opened.reviewSections.some((section) => section.kind === "working-tree")).toBe(false);
});

it("explains old connection permissions even when a recorded turn remains readable", () => {
  state.session = {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope],
    permissions: [AuthOrchestrationReadScope],
  };
  const review = renderSections(makeInput());
  expect(review.selectedSection?.diff).toBe(checkpointDiff);
  expect(review.reviewSections.map((section) => section.id)).toEqual(["turn:1"]);
  expect(review.liveGitUnavailableReason).toContain("Pair again with Read files access");
});
