import {
  AuthFilesystemReadScope,
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type AuthSessionState,
  type OrchestrationCheckpointSummary,
} from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  sessionAtom: {},
  effects: [] as Array<() => void>,
  checkpoints: [] as ReadonlyArray<OrchestrationCheckpointSummary>,
}));

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
  useSelectedThreadDetail: () => ({ checkpoints: state.checkpoints }),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === state.sessionAtom ? state.session : null,
    error: null,
    isPending: atom === state.sessionAtom && state.session === null,
    refresh: vi.fn(),
  }),
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

import { setReviewSelectedSectionId, type ReviewCacheForThread } from "./reviewState";
import { useReviewSections } from "./useReviewSections";

beforeEach(() => {
  vi.clearAllMocks();
  state.effects = [];
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
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
});

const checkpointDiff = "diff --git a/checkpoint.ts b/checkpoint.ts";
const localDiff = "diff --git a/local.ts b/local.ts";
function makeReviewCache(
  kind: "working-tree" | "branch-range" = "working-tree",
): ReviewCacheForThread {
  return {
    threadKey: "environment:thread",
    gitSections: [
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
    ],
    turnDiffById: { "turn:1": checkpointDiff },
    selectedSectionId: `git:${kind}`,
    asyncState: { loadingTurnIds: {}, error: null },
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

function renderSections(input: ReturnType<typeof makeInput>) {
  const result = useReviewSections(input);
  const effects = state.effects.splice(0);
  effects.forEach((effect) => effect());
  return result;
}

it("hides cached local diffs after file access is lost while retaining checkpoint diffs", () => {
  const input = makeInput();
  expect(renderSections(input).selectedSection?.diff).toBe(localDiff);

  state.session = { authenticated: true, scopes: [] };
  const denied = renderSections(input);
  expect(denied.reviewSections.map((section) => section.id)).toEqual(["turn:1"]);
  expect(denied.selectedSection?.diff).toBe(checkpointDiff);

  expect(setReviewSelectedSectionId).toHaveBeenCalledWith("environment:thread", "turn:1");
});

it.each(["working-tree", "branch-range"] as const)(
  "preserves a cached %s selection while an expired grant reloads",
  (kind) => {
    const input = makeInput(makeReviewCache(kind));
    expect(renderSections(input).selectedSection?.diff).toBe(localDiff);

    state.session = null;
    const pending = renderSections(input);
    expect(pending.selectedSection).toEqual(
      expect.objectContaining({ id: `git:${kind}`, diff: null, isLoading: true }),
    );
    expect(pending.loadingGitDiffs).toBe(true);
    expect(pending.reviewSections.find((section) => section.id === "turn:1")?.diff).toBe(
      checkpointDiff,
    );
    expect(setReviewSelectedSectionId).not.toHaveBeenCalled();

    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    expect(renderSections(input).selectedSection).toEqual(
      expect.objectContaining({ id: `git:${kind}`, diff: localDiff, isLoading: false }),
    );
    expect(setReviewSelectedSectionId).not.toHaveBeenCalled();
  },
);

it("falls back to a checkpoint when a pending grant resolves without file access", () => {
  const input = makeInput();
  state.session = null;
  renderSections(input);
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();

  state.session = { authenticated: true, scopes: [] };
  const denied = renderSections(input);
  expect(denied.reviewSections.map((section) => section.id)).toEqual(["turn:1"]);
  expect(denied.selectedSection?.diff).toBe(checkpointDiff);
  expect(setReviewSelectedSectionId).toHaveBeenCalledWith("environment:thread", "turn:1");
});
