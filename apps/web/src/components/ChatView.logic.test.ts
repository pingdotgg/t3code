import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { Thread } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  createLocalDispatchSnapshot,
  deriveCommittedServerUserMessageIds,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  getStartedThreadModelChangeBlockReason,
  isStartedThreadOptionChangeBlocked,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  resolveComposerDisplayModelOptions,
  resolveDispatchedModelSelection,
  resolveModelChangeRuntime,
  resolveSessionLockedInstanceId,
  resolveThreadMetadataUpdateForNextTurn,
  resolveTraitsOptionChangeBlocked,
  resolveSendEnvMode,
  startNewThreadForProject,
  shouldShowBranchMismatchBanner,
  shouldShowComposerContextStrip,
  shouldWriteThreadErrorToCurrentServerThread,
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
    messages: [],
    proposedPlans: [],
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

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("shouldShowComposerContextStrip", () => {
  it("shows git context while composing a new thread", () => {
    expect(
      shouldShowComposerContextStrip({
        isDraftHeroState: true,
        isGitRepo: true,
        hasActiveProject: true,
        persistInActiveThreads: false,
      }),
    ).toBe(true);
  });

  it("keeps git context in an active thread only when requested", () => {
    expect(
      shouldShowComposerContextStrip({
        isDraftHeroState: false,
        isGitRepo: true,
        hasActiveProject: true,
        persistInActiveThreads: true,
      }),
    ).toBe(true);
    expect(
      shouldShowComposerContextStrip({
        isDraftHeroState: false,
        isGitRepo: true,
        hasActiveProject: true,
        persistInActiveThreads: false,
      }),
    ).toBe(false);
  });

  it("hides git context without a git-backed project", () => {
    expect(
      shouldShowComposerContextStrip({
        isDraftHeroState: true,
        isGitRepo: false,
        hasActiveProject: true,
        persistInActiveThreads: true,
      }),
    ).toBe(false);
    expect(
      shouldShowComposerContextStrip({
        isDraftHeroState: true,
        isGitRepo: true,
        hasActiveProject: false,
        persistInActiveThreads: true,
      }),
    ).toBe(false);
  });
});
describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes for providers that require a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });
});

describe("resolveModelChangeRuntime", () => {
  it("uses shell runtime while the detailed projection is loading", () => {
    const shellRuntime = makeThread({ runtime: readySession }).runtime;
    expect(
      resolveModelChangeRuntime({
        projectedRuntime: null,
        shellRuntime,
      }),
    ).toBe(shellRuntime);
  });

  it("keeps a failed first turn without a runtime unlocked", () => {
    expect(
      resolveModelChangeRuntime({
        projectedRuntime: null,
        shellRuntime: null,
      }),
    ).toBeNull();
  });
});

describe("isStartedThreadOptionChangeBlocked", () => {
  const grokPrimary = ProviderInstanceId.make("grok");
  const grokSecondary = ProviderInstanceId.make("grok_work");
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: grokPrimary,
      requiresNewThreadForModelChange: true,
    },
    {
      instanceId: grokSecondary,
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows option changes before a provider session has started", () => {
    expect(
      isStartedThreadOptionChangeBlocked({
        providers,
        lockedInstanceId: null,
        instanceId: grokPrimary,
      }),
    ).toBe(false);
  });

  it("allows started-session option changes for unrestricted providers", () => {
    expect(
      isStartedThreadOptionChangeBlocked({
        providers,
        lockedInstanceId: ProviderInstanceId.make("codex"),
        instanceId: ProviderInstanceId.make("codex"),
      }),
    ).toBe(false);
  });

  it("allows option changes when composing for a provider other than the running one", () => {
    expect(
      isStartedThreadOptionChangeBlocked({
        providers,
        lockedInstanceId: ProviderInstanceId.make("codex"),
        instanceId: grokPrimary,
      }),
    ).toBe(false);
  });

  it("blocks started-session option changes for the active session-bound instance", () => {
    expect(
      isStartedThreadOptionChangeBlocked({
        providers,
        lockedInstanceId: grokPrimary,
        instanceId: grokPrimary,
      }),
    ).toBe(true);
  });

  it("allows options when switching between two Grok instances", () => {
    // Active session is grok; composing for grok_work must keep that
    // instance's options editable and independently dispatchable.
    expect(
      isStartedThreadOptionChangeBlocked({
        providers,
        lockedInstanceId: grokPrimary,
        instanceId: grokSecondary,
      }),
    ).toBe(false);
  });
});

describe("resolveDispatchedModelSelection", () => {
  const grokInstance = ProviderInstanceId.make("grok");
  const committedAbsentOptions = {
    instanceId: grokInstance,
    model: "grok-4.5",
  };
  const materializedDefaultHigh = {
    instanceId: grokInstance,
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "high" as const }],
  };
  const handoffSelection = {
    instanceId: ProviderInstanceId.make("grok_work"),
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "low" as const }],
  };

  it("dispatches the exact committed selection when locked with absent options", () => {
    // Descriptor normalization would materialize default High for display;
    // dispatch must not rewrite pre-feature threads that never stored options.
    const dispatched = resolveDispatchedModelSelection({
      optionChangeBlocked: true,
      committedModelSelection: committedAbsentOptions,
      selectedInstanceId: grokInstance,
      selectedModel: "grok-4.5",
      selectedModelOptionsForDispatch: materializedDefaultHigh.options,
    });
    expect(dispatched).toEqual(committedAbsentOptions);
    expect(dispatched).not.toHaveProperty("options");
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: committedAbsentOptions,
        nextModelSelection: dispatched,
        currentBranch: "main",
        nextBranch: "main",
      }),
    ).toBeNull();
  });

  it("dispatches normalized options when unlocked", () => {
    expect(
      resolveDispatchedModelSelection({
        optionChangeBlocked: false,
        committedModelSelection: committedAbsentOptions,
        selectedInstanceId: grokInstance,
        selectedModel: "grok-4.5",
        selectedModelOptionsForDispatch: materializedDefaultHigh.options,
      }),
    ).toEqual(materializedDefaultHigh);
  });

  it("dispatches the new instance selection for cross-instance handoff", () => {
    // optionChangeBlocked is false when selected instance differs from lock.
    expect(
      resolveDispatchedModelSelection({
        optionChangeBlocked: false,
        committedModelSelection: committedAbsentOptions,
        selectedInstanceId: handoffSelection.instanceId,
        selectedModel: handoffSelection.model,
        selectedModelOptionsForDispatch: handoffSelection.options,
      }),
    ).toEqual(handoffSelection);
  });

  it("does not silently substitute the committed model for a locked draft model change", () => {
    expect(
      resolveDispatchedModelSelection({
        optionChangeBlocked: true,
        committedModelSelection: committedAbsentOptions,
        selectedInstanceId: grokInstance,
        selectedModel: "grok-build",
        selectedModelOptionsForDispatch: undefined,
      }),
    ).toEqual({
      instanceId: grokInstance,
      model: "grok-build",
    });
  });
});

describe("composed ChatComposer traits lock source", () => {
  const grokPrimary = ProviderInstanceId.make("grok");
  const grokSecondary = ProviderInstanceId.make("grok_work");
  const providers = [
    { instanceId: grokPrimary, requiresNewThreadForModelChange: true },
    { instanceId: grokSecondary, requiresNewThreadForModelChange: true },
  ];
  const committedLow = {
    instanceId: grokPrimary,
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "low" as const }],
  };
  const draftHigh = {
    instanceId: grokPrimary,
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "high" as const }],
  };
  const handoffSelection = {
    instanceId: grokSecondary,
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "medium" as const }],
  };

  it("keys the lock to the active session instance, not merely the driver kind", () => {
    expect(
      resolveSessionLockedInstanceId({
        hasStartedThread: true,
        runtimeProviderInstanceId: grokPrimary,
        committedModelSelectionInstanceId: grokSecondary,
      }),
    ).toBe(grokPrimary);

    // Selecting the other Grok instance (same driver kind) stays unlocked.
    expect(
      resolveTraitsOptionChangeBlocked({
        providers,
        hasStartedThread: true,
        runtimeProviderInstanceId: grokPrimary,
        committedModelSelectionInstanceId: grokPrimary,
        selectedInstanceId: grokSecondary,
      }),
    ).toBe(false);
  });

  it("locks traits and dispatches the committed selection for the active instance", () => {
    const optionChangeBlocked = resolveTraitsOptionChangeBlocked({
      providers,
      hasStartedThread: true,
      runtimeProviderInstanceId: grokPrimary,
      committedModelSelectionInstanceId: grokPrimary,
      selectedInstanceId: grokPrimary,
    });
    expect(optionChangeBlocked).toBe(true);
    expect(
      resolveDispatchedModelSelection({
        optionChangeBlocked,
        committedModelSelection: committedLow,
        selectedInstanceId: draftHigh.instanceId,
        selectedModel: draftHigh.model,
        selectedModelOptionsForDispatch: draftHigh.options,
      }),
    ).toEqual(committedLow);
  });

  it("does not lock when the draft handoff targets another instance", () => {
    const optionChangeBlocked = resolveTraitsOptionChangeBlocked({
      providers,
      hasStartedThread: true,
      runtimeProviderInstanceId: grokPrimary,
      committedModelSelectionInstanceId: grokPrimary,
      selectedInstanceId: grokSecondary,
    });
    expect(optionChangeBlocked).toBe(false);
    expect(
      resolveDispatchedModelSelection({
        optionChangeBlocked,
        committedModelSelection: committedLow,
        selectedInstanceId: handoffSelection.instanceId,
        selectedModel: handoffSelection.model,
        selectedModelOptionsForDispatch: handoffSelection.options,
      }),
    ).toEqual(handoffSelection);
  });

  it("leaves options unlocked when there is no session lock", () => {
    expect(
      resolveSessionLockedInstanceId({
        hasStartedThread: false,
        runtimeProviderInstanceId: grokPrimary,
        committedModelSelectionInstanceId: grokPrimary,
      }),
    ).toBeNull();
    expect(
      resolveTraitsOptionChangeBlocked({
        providers,
        hasStartedThread: false,
        runtimeProviderInstanceId: grokPrimary,
        committedModelSelectionInstanceId: grokPrimary,
        selectedInstanceId: grokPrimary,
      }),
    ).toBe(false);
  });

  it("locks a custom Grok instance from committed metadata while runtime is loading", () => {
    expect(
      resolveTraitsOptionChangeBlocked({
        providers,
        hasStartedThread: true,
        runtimeProviderInstanceId: null,
        committedModelSelectionInstanceId: grokSecondary,
        selectedInstanceId: grokSecondary,
      }),
    ).toBe(true);
  });

  it("swaps display options to committed while locked and draft while unlocked", () => {
    const committedOptions = committedLow.options;
    const draftOptions = draftHigh.options;
    // Locked same-instance: ChatComposer feeds committed options into
    // getComposerProviderState so the traits UI matches the in-force value.
    expect(
      resolveComposerDisplayModelOptions({
        optionChangeBlocked: true,
        selectedInstanceId: grokPrimary,
        selectedModel: "grok-4.5",
        committedModelSelectionInstanceId: grokPrimary,
        committedModel: "grok-4.5",
        committedModelOptions: committedOptions,
        draftModelOptions: draftOptions,
      }),
    ).toBe(committedOptions);
    // Cross-instance handoff and unlocked threads keep draft options.
    expect(
      resolveComposerDisplayModelOptions({
        optionChangeBlocked: false,
        selectedInstanceId: grokSecondary,
        selectedModel: "grok-4.5",
        committedModelSelectionInstanceId: grokPrimary,
        committedModel: "grok-4.5",
        committedModelOptions: committedOptions,
        draftModelOptions: handoffSelection.options,
      }),
    ).toBe(handoffSelection.options);
    // Pre-feature threads with absent committed options stay absent on display.
    expect(
      resolveComposerDisplayModelOptions({
        optionChangeBlocked: true,
        selectedInstanceId: grokPrimary,
        selectedModel: "grok-4.5",
        committedModelSelectionInstanceId: grokPrimary,
        committedModel: "grok-4.5",
        committedModelOptions: undefined,
        draftModelOptions: draftOptions,
      }),
    ).toBeUndefined();
    // Empty committed options arrays stay empty (not rewritten to draft).
    expect(
      resolveComposerDisplayModelOptions({
        optionChangeBlocked: true,
        selectedInstanceId: grokPrimary,
        selectedModel: "grok-4.5",
        committedModelSelectionInstanceId: grokPrimary,
        committedModel: "grok-4.5",
        committedModelOptions: [],
        draftModelOptions: draftOptions,
      }),
    ).toEqual([]);

    // A legacy or stale draft for another model keeps its own option state;
    // dispatch must not silently substitute the committed model.
    expect(
      resolveComposerDisplayModelOptions({
        optionChangeBlocked: true,
        selectedInstanceId: grokPrimary,
        selectedModel: "grok-build",
        committedModelSelectionInstanceId: grokPrimary,
        committedModel: "grok-4.5",
        committedModelOptions: committedOptions,
        draftModelOptions: draftOptions,
      }),
    ).toBe(draftOptions);
  });

  it("uses draft options when runtime lock is one Grok instance but committed metadata is another", () => {
    // Narrow handoff window: session/runtime still on grokPrimary so selecting
    // that instance reports optionChangeBlocked, but committed metadata has
    // already moved to grokSecondary. Display must not show secondary's
    // options while primary is selected.
    const primaryDraftOptions = draftHigh.options;
    const secondaryCommittedOptions = handoffSelection.options;
    expect(
      resolveComposerDisplayModelOptions({
        optionChangeBlocked: true,
        selectedInstanceId: grokPrimary,
        selectedModel: "grok-4.5",
        committedModelSelectionInstanceId: grokSecondary,
        committedModel: "grok-4.5",
        committedModelOptions: secondaryCommittedOptions,
        draftModelOptions: primaryDraftOptions,
      }),
    ).toBe(primaryDraftOptions);
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("requires the environment, route thread, and target thread to match", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("startNewThreadForProject", () => {
  it("starts a thread through the supplied shared handler for the active project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
    const projectRef = { environmentId, projectId };

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) => {
        calls.push(nextProjectRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([projectRef]);
  });

  it("does nothing when the active project is unavailable", () => {
    let called = false;

    expect(
      startNewThreadForProject(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestRun: completedTurn,
        runtime: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestRun: newerTurn,
        runtime: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      status: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: RunId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: runningTurn.runId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running run", () => {
    const runningRun = {
      ...completedTurn,
      status: "running" as const,
      completedAt: null,
    };
    const runningRuntime = {
      ...readySession,
      status: "running" as const,
      activeRunId: runningRun.runId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: runningRun, runtime: runningRuntime }),
      { latestUserMessageId: MessageId.make("message-before-steer") },
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningRun,
        latestUserMessageId: MessageId.make("message-steer"),
        runtime: runningRuntime,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestRun: null,
      runtime: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });
});

describe("deriveCommittedServerUserMessageIds", () => {
  it("tracks only committed user turn items, not assistant rows or projection-only messages", () => {
    const turnStartId = MessageId.make("message-turn-start");
    const steerId = MessageId.make("message-steer");
    const assistantId = MessageId.make("message-assistant");
    const committedAt = DateTime.makeUnsafe("2026-06-26T17:50:15.180Z");
    const runId = RunId.make("run:thread:thread-1:ordinal:1");
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-turn-start"),
        item: {
          id: TurnItemId.make("turn-item:message-turn-start"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: turnStartId,
          inputIntent: "turn_start",
          text: "start",
          attachments: [],
        },
      },
      {
        position: 1,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-assistant"),
        item: {
          id: TurnItemId.make("turn-item:message-assistant"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          type: "assistant_message",
          messageId: assistantId,
          text: "working",
          streaming: false,
        },
      },
      {
        position: 2,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-steer"),
        item: {
          id: TurnItemId.make("turn-item:message-steer"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: steerId,
          inputIntent: "steer",
          text: "continue",
          attachments: [],
        },
      },
    ];

    expect(deriveCommittedServerUserMessageIds(visibleTurnItems)).toEqual(
      new Set([turnStartId, steerId]),
    );
  });
});
