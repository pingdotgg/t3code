import {
  boundAttachmentIds,
  buildExpiredTerminalContextToastCopy,
  mergeDirectPreviewAnnotation,
  planComposerTurn,
  restorePlanFollowUpComposer,
  snapshotComposerSend,
  withMessageContext,
  deriveAvailableRevertTurnCounts,
} from "./ChatView.logic";
import { recallCheckoutIsRepo, rememberCheckoutIsRepo } from "./ChatView.logic";
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { ensureInlineContextReferences } from "../lib/composerContextReferences";
import { terminalContextReference } from "../lib/composerContextRecords";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import type { Thread } from "../types";
import { makeThreadFixture, makeThreadProjectionFixture } from "../test-fixtures";
import {
  getAntigravitySendBlockReason,
  resolveComposerProviderSelection,
  resolveWorktreeSetupProgress,
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resetHeldThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
  createLocalDispatchSnapshot,
  deriveCommittedServerUserMessageIds,
  deriveComposerSendState,
  deriveLockedProvider,
  hasServerAcknowledgedLocalDispatch,
  waitForRevertedMessage,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");

const projectId = ProjectId.make("project-1");

const threadId = ThreadId.make("thread-1");

const now = "2026-03-29T00:00:00.000Z";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

const completedTurn = {
  runId: RunId.make("turn-1"),
  status: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  status: "completed" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeRunId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("waitForRevertedMessage", () => {
  const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t") };

  const messageId = MessageId.make("message-2");

  const requestId = CommandId.make("rollback-1");

  function projectionAtom() {
    const base = makeThreadProjectionFixture();
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const projection = {
      ...base,
      thread: { ...base.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          driver: "codex",
          providerInstanceId: base.thread.providerInstanceId,
          providerSessionId: ProviderSessionId.make("provider-session"),
          appThreadId: base.thread.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 4,
          handoffIds: [],
          forkedFrom: null,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
      runs: [1, 2, 3, 4].map((ordinal) => ({
        id: RunId.make(`run-${ordinal}`),
        threadId: base.thread.id,
        ordinal,
        providerInstanceId: base.thread.providerInstanceId,
        modelSelection: base.thread.modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message-${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: base.updatedAt,
        startedAt: base.updatedAt,
        completedAt: base.updatedAt,
        checkpointId: null,
        contextHandoffId: null,
      })),
      messages: [
        {
          id: messageId,
          threadId: base.thread.id,
          runId: RunId.make("run-2"),
          nodeId: null,
          role: "user",
          text: "second",
          attachments: [],
          streaming: false,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
    const state = Atom.make({ data: Option.some(projection) });
    vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state as never);
    return { state, projection };
  }

  afterEach(() => vi.restoreAllMocks());

  it("rejects with the projected reason when the rollback fails for good", async () => {
    const { state, projection } = projectionAtom();
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {});
    await Promise.resolve();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackFailure: { requestId, message: "The provider could not roll back." },
        },
      }),
    });

    await expect(waiting).rejects.toThrow("The provider could not roll back.");
  });

  it.each([
    ["same", "streamed"],
    ["replacement", "streamed"],
    ["replacement", "refetched"],
  ] as const)(
    "waits for the retained rollback suffix when the edited message and run are paged out (%s provider, %s)",
    async (providerIdentity, projectionSource) => {
      vi.useFakeTimers();
      const { state, projection } = projectionAtom();
      const latestRunId = RunId.make("latest-run-9");
      const latestRun = {
        ...projection.runs[3]!,
        id: latestRunId,
        ordinal: 9,
        userMessageId: MessageId.make("latest-message-9"),
        status: "cancelled" as const,
      };
      const bounded = {
        ...projection,
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 9,
        })),
        runs: [
          {
            ...latestRun,
            id: RunId.make("old-rewound-run-3"),
            userMessageId: MessageId.make("old-rewound-message-3"),
            ordinal: 3,
            status: "rolled_back" as const,
          },
          latestRun,
        ],
      };
      const oldProviderThread = bounded.providerThreads[0]!;
      const completedProviderThread = {
        ...oldProviderThread,
        ...(providerIdentity === "replacement"
          ? { id: ProviderThreadId.make("replacement-provider-thread"), firstRunOrdinal: null }
          : {}),
        lastRunOrdinal: null,
      };
      appAtomRegistry.set(state, { data: Option.some(bounded) });
      let outcome = "pending";
      const waiting = waitForRevertedMessage(threadRef, 0, requestId, async () => {}).then(
        () => {
          outcome = "reverted";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );

      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("pending");

        appAtomRegistry.set(state, {
          data: Option.some({
            ...bounded,
            thread: {
              ...bounded.thread,
              activeProviderThreadId:
                projectionSource === "refetched"
                  ? completedProviderThread.id
                  : oldProviderThread.id,
            },
            providerThreads:
              providerIdentity === "replacement"
                ? [oldProviderThread, completedProviderThread]
                : [completedProviderThread],
            runs: bounded.runs.map((run) =>
              run.id === latestRunId ? { ...run, status: "rolled_back" as const } : run,
            ),
          }),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("reverted");
        await waiting;
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("waits for the requested target when another client finishes a shallower rewind", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    let outcome = "pending";
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {}).then(
      () => {
        outcome = "reverted";
      },
      (error: Error) => {
        outcome = error.message;
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");

      // Our command is accepted while the earlier target-3 effect is still running.
      const shallowerRewind = {
        ...projection,
        thread: { ...projection.thread, rollbackRequestId: requestId, rollbackFailure: null },
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 3,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 3 ? { ...run, status: "rolled_back" as const } : run,
        ),
      };
      appAtomRegistry.set(state, { data: Option.some(shallowerRewind) });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");

      appAtomRegistry.set(state, {
        data: Option.some({
          ...shallowerRewind,
          providerThreads: shallowerRewind.providerThreads.map((thread) => ({
            ...thread,
            lastRunOrdinal: 1,
          })),
          runs: shallowerRewind.runs.map((run) =>
            run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
          ),
        }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("reverted");
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rejects a stale edit already rewound by another client during attachment preparation", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: { ...projection.thread, rollbackRequestId: CommandId.make("other-client-rewind") },
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 1,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
        ),
      }),
    });
    const revert = vi.fn(async () => {});
    let outcome = "pending";
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, revert).then(
      () => {
        outcome = "reverted";
      },
      () => {
        outcome = "rejected";
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("rejected");
      expect(revert).not.toHaveBeenCalled();
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("mergeDirectPreviewAnnotation", () => {
  const annotation = (id: string) =>
    ({
      id,
      pageUrl: "http://localhost:5173/",
      pageTitle: null,
      comment: "tighten this",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: {
        dataUrl: "data:image/png;base64,AAAA",
        width: 10,
        height: 10,
        cropRect: { x: 0, y: 0, width: 10, height: 10 },
      },
      createdAt: "2026-10-16T00:00:00.000Z",
    }) as const;
  const image = (id: string) =>
    ({ id, type: "image", name: `${id}.png`, mimeType: "image/png", sizeBytes: 1 }) as never;

  it("drops the screenshot claim when the attachment cap is full", () => {
    const result = mergeDirectPreviewAnnotation({
      images: [],
      fileCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      previewAnnotations: [],
      direct: { annotation: annotation("a"), image: image("crop") },
    });
    expect(result.images).toEqual([]);
    expect(result.previewAnnotations[0]?.screenshot).toBeNull();
  });
});

describe("snapshotComposerSend", () => {
  const expired = {
    id: "ctx-expired",
    threadId,
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 4,
    lineEnd: 4,
    text: "",
    createdAt: now,
  };
  const live = { ...expired, id: "ctx-live", text: "pnpm test", lineStart: 9, lineEnd: 9 };

  it("drops expired terminal contexts from the contexts and from the prompt", () => {
    const snapshot = snapshotComposerSend({
      prompt: ensureInlineContextReferences("run", [
        terminalContextReference(expired),
        terminalContextReference(live),
      ]),
      images: [],
      files: [],
      terminalContexts: [expired, live],
      sendableTerminalContexts: [live],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      environmentContexts: [],
    });

    expect(snapshot.terminalContexts).toEqual([live]);
    expect(snapshot.messageText).toBe(
      ensureInlineContextReferences("run", [terminalContextReference(live)]).trim(),
    );
  });
});

describe("planComposerTurn", () => {
  const base = {
    messageText: "hello",
    sendQueuesBehindSetup: false,
    isServerThread: false,
    activeMessageCount: 0,
    sendEnvMode: "worktree" as const,
    worktreePath: null,
    activeThreadBranch: "main",
    resumeCompactionTokens: null,
    keepFullHistory: false,
    phase: "ready" as const,
    dispatchMode: "auto" as const,
  };

  it("prepares a worktree from the selected branch on a new thread", () => {
    expect(planComposerTurn(base)).toMatchObject({
      missingWorktreeBaseBranch: false,
      baseBranchForWorktree: "main",
      shouldQueueBehindActiveRun: false,
    });
  });

  it("refuses a new worktree without a base branch", () => {
    expect(planComposerTurn({ ...base, activeThreadBranch: null })).toMatchObject({
      missingWorktreeBaseBranch: true,
      baseBranchForWorktree: null,
    });
  });

  it("queues behind a compaction of a stale session, except for /compact itself", () => {
    const stale = { ...base, resumeCompactionTokens: 120_000 };
    for (const messageText of ["hello", "/compactfoo"]) {
      expect(planComposerTurn({ ...stale, messageText })).toMatchObject({
        compactBeforeSend: true,
        turnDispatchMode: "queue",
        shouldQueueBehindActiveRun: true,
      });
    }
    for (const messageText of ["/COMPACT", "/compact keep the API notes", "/compact\n  tests"]) {
      expect(planComposerTurn({ ...stale, messageText })).toMatchObject({
        compactBeforeSend: false,
        turnDispatchMode: "auto",
        shouldQueueBehindActiveRun: false,
      });
    }
  });

  it("queues behind a running turn only when asked to", () => {
    const running = {
      ...base,
      isServerThread: true,
      activeMessageCount: 3,
      phase: "running" as const,
    };
    expect(planComposerTurn({ ...running, dispatchMode: "queue" }).shouldQueueBehindActiveRun).toBe(
      true,
    );
    expect(planComposerTurn({ ...running, dispatchMode: "steer" })).toMatchObject({
      shouldQueueBehindActiveRun: false,
      baseBranchForWorktree: null,
    });
  });
});

describe("restorePlanFollowUpComposer", () => {
  // The draft is the failed follow-up's thread; the refs and cursor are whatever thread is on
  // screen.
  it.each([
    {
      name: "puts the follow-up back while its thread is open",
      before: { draft: "", refs: "", cursor: null },
      routeIsCurrent: true,
      after: { draft: "Tighten step 2", refs: "Tighten step 2", cursor: "Tighten step 2" },
    },
    {
      name: "keeps a draft typed while the follow-up was in flight",
      before: { draft: "Next idea", refs: "Next idea", cursor: null },
      routeIsCurrent: true,
      after: { draft: "Next idea", refs: "Next idea", cursor: null },
    },
    {
      name: "leaves another thread's composer alone after navigating away",
      before: { draft: "", refs: "Other thread", cursor: null },
      routeIsCurrent: false,
      after: { draft: "Tighten step 2", refs: "Other thread", cursor: null },
    },
  ])("$name", ({ before, routeIsCurrent, after }) => {
    const composer: { draft: string; refs: string; cursor: string | null } = { ...before };
    restorePlanFollowUpComposer({
      snapshot: {
        prompt: "Tighten step 2",
        environmentContexts: [],
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: [],
        threadContexts: [],
      },
      draftHasUserContent: composer.draft.trim().length > 0,
      routeIsCurrent,
      writeComposerRefs: (snapshot) => {
        composer.refs = snapshot.prompt;
      },
      writePrompt: (prompt) => {
        composer.draft = prompt;
      },
      writeTerminalContexts: () => undefined,
      writeReviewComments: () => undefined,
      writePreviewAnnotations: () => undefined,
      writeThreadContexts: () => undefined,
      writeEnvironmentContexts: () => undefined,
      resetCursor: ({ prompt }) => {
        composer.cursor = prompt;
      },
    });

    expect(composer).toEqual(after);
  });
});

describe("withMessageContext", () => {
  const context = { records: [] } as unknown as NonNullable<
    Parameters<typeof withMessageContext>[0]["context"]
  >;

  it("sends the context inline", () => {
    expect(withMessageContext({ text: "hi", context })).toEqual({ text: "hi", context });
  });

  it("sends the text alone without context", () => {
    expect(withMessageContext({ text: "hi", context: undefined })).toEqual({ text: "hi" });
  });
});

describe("boundAttachmentIds", () => {
  it("prefers the uploaded id and falls back to the local one", () => {
    expect(
      boundAttachmentIds([{ id: "upload-1" }, {}], [{ id: "local-1" }, { id: "local-2" }]),
    ).toEqual(["upload-1", "local-2"]);
  });
});

describe("deriveAvailableRevertTurnCounts", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const otherProviderThreadId = ProviderThreadId.make("other-provider-thread");

  function projection(input: { readonly providerSessionId: ProviderSessionId | null }) {
    const base = makeThreadProjectionFixture();
    const run = (ordinal: number) => ({
      id: RunId.make(`run-${ordinal}`),
      ordinal,
      activeAttemptId: `attempt-${ordinal}`,
    });
    const turn = (ordinal: number, attempt: number, threadId: ProviderThreadId) => ({
      id: `turn-${attempt}-${ordinal}`,
      runAttemptId: `attempt-${attempt}`,
      ordinal,
      providerThreadId: threadId,
    });
    return {
      ...base,
      thread: { ...base.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          providerInstanceId: base.thread.modelSelection.instanceId,
          providerSessionId: input.providerSessionId,
        },
      ],
      runs: [run(1), run(2), run(3)],
      attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, providerTurnId: null })),
      // Run 2's latest turn moved to another provider thread, so its checkpoint cannot restore
      // this conversation.
      providerTurns: [
        turn(1, 1, providerThreadId),
        turn(1, 2, providerThreadId),
        turn(2, 2, otherProviderThreadId),
        turn(1, 3, providerThreadId),
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
  }

  it("offers the thread start and runs whose latest turn is on the active provider thread", () => {
    const available = deriveAvailableRevertTurnCounts(
      projection({ providerSessionId: ProviderSessionId.make("session") }),
    );
    expect([...available].toSorted()).toEqual([0, 1, 3]);
  });

  it("offers nothing without a provider session to rewind", () => {
    expect(deriveAvailableRevertTurnCounts(projection({ providerSessionId: null })).size).toBe(0);
    expect(deriveAvailableRevertTurnCounts(null).size).toBe(0);
  });
});
