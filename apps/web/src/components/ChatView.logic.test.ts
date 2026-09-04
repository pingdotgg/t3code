import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { deriveProviderInstanceEntries, NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import type { RightPanelSurface } from "../rightPanelStore";
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
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Thread } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import {
  agentControlledBrowserCloseConfirmation,
  ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  getAntigravitySendBlockReason,
  resolveBackgroundDraftWorkspaceOptions,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  resolveDraftHeroState,
  scheduleEnvironmentReconnectWarning,
  codexArtifactTemplatePromptToAppend,
  shouldDockDraftHeroForSubmission,
  shouldReleaseTimelineAnchorForToolActivity,
  shouldOpenProactivePullRequest,
  shouldOpenProactiveTurnDiff,
  shouldRenderPreviewMiniPlayer,
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  createLocalDispatchSnapshot,
  deriveCommittedServerUserMessageIds,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  getStartedThreadModelChangeBlockReason,
  hasEnvironmentReconnectWarningGraceElapsed,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  resolveDraftPromotionNavigationTarget,
  resolveEffectiveInteractionMode,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  startNewThreadForProject,
  shouldShowBranchMismatchBanner,
  shouldShowComposerContextStrip,
  shouldShowPlanFollowUpPrompt,
  shouldWriteThreadErrorToCurrentServerThread,
  toolGroupConsumesUpwardNavigation,
} from "./ChatView.logic";

describe("toolGroupConsumesUpwardNavigation", () => {
  class ScrollElement extends EventTarget {
    scrollTop = 0;
    scrollHeight = 100;
    clientHeight = 100;
    overflowY = "visible";

    constructor(
      readonly parentElement: ScrollElement | null = null,
      readonly isToolGroup = false,
    ) {
      super();
    }

    closest(selector: string): ScrollElement | null {
      if (selector !== "[data-tool-group-scroll]") return null;
      return this.isToolGroup ? this : (this.parentElement?.closest(selector) ?? null);
    }
  }

  beforeEach(() => {
    vi.stubGlobal("Element", ScrollElement);
    vi.stubGlobal("getComputedStyle", (element: ScrollElement) => ({
      overflowY: element.overflowY,
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("releases upward navigation when an overflowing group is at the top", () => {
    const group = Object.assign(new ScrollElement(null, true), {
      overflowY: "auto",
      scrollHeight: 300,
    });

    expect(toolGroupConsumesUpwardNavigation(new ScrollElement(group))).toBe(false);
  });

  it.each([
    { overflowY: "auto", scrollTop: 1 },
    { overflowY: "auto", scrollTop: 0.25 },
    { overflowY: "scroll", scrollTop: 80 },
  ])("consumes upward navigation within a scrolled group: %j", (scroll) => {
    const group = Object.assign(new ScrollElement(null, true), {
      scrollHeight: 300,
      ...scroll,
    });

    expect(toolGroupConsumesUpwardNavigation(group)).toBe(true);
  });

  it.each([100, 300])(
    "consumes scrolling in a nested result with a group content height of %i",
    (scrollHeight) => {
      const group = Object.assign(new ScrollElement(null, true), {
        overflowY: "auto",
        scrollHeight,
      });
      const result = Object.assign(new ScrollElement(group), {
        overflowY: "auto",
        scrollHeight: 300,
        scrollTop: 0.25,
      });

      expect(toolGroupConsumesUpwardNavigation(new ScrollElement(result))).toBe(true);
    },
  );

  it("releases upward navigation when the group and nested result are both at the top", () => {
    const group = Object.assign(new ScrollElement(null, true), {
      overflowY: "auto",
      scrollHeight: 300,
    });
    const result = Object.assign(new ScrollElement(group), {
      overflowY: "scroll",
      scrollHeight: 300,
    });

    expect(toolGroupConsumesUpwardNavigation(new ScrollElement(result))).toBe(false);
  });

  it("ignores targets outside a tool group and non-element targets", () => {
    const outside = Object.assign(new ScrollElement(), {
      overflowY: "auto",
      scrollHeight: 300,
      scrollTop: 40,
    });

    expect(toolGroupConsumesUpwardNavigation(outside)).toBe(false);
    expect(toolGroupConsumesUpwardNavigation(new EventTarget())).toBe(false);
    expect(toolGroupConsumesUpwardNavigation(null)).toBe(false);
  });

  it("does not consume scrolling from an ancestor beyond the tool group", () => {
    const timeline = Object.assign(new ScrollElement(), {
      overflowY: "auto",
      scrollHeight: 300,
      scrollTop: 40,
    });
    const group = new ScrollElement(timeline, true);

    expect(toolGroupConsumesUpwardNavigation(new ScrollElement(group))).toBe(false);
  });

  it.each(["hidden", "clip", "visible"])(
    "ignores a non-scrollable child with overflow-y %s",
    (overflowY) => {
      const group = new ScrollElement(null, true);
      const result = Object.assign(new ScrollElement(group), {
        overflowY,
        scrollHeight: 300,
        scrollTop: 40,
      });

      expect(toolGroupConsumesUpwardNavigation(new ScrollElement(result))).toBe(false);
    },
  );

  it("does not consume programmatic scrolling on an overflow-hidden group", () => {
    const group = Object.assign(new ScrollElement(null, true), {
      overflowY: "hidden",
      scrollHeight: 300,
      scrollTop: 40,
    });

    expect(toolGroupConsumesUpwardNavigation(group)).toBe(false);
  });
});

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";
const helloWorldTemplate: CodexArtifactTemplate = {
  artifactKind: "document",
  displayName: "Hello World",
  skillDirectory: "/Users/test/.codex/skills/artifact-template-hello-world",
  skillName: "artifact-template-hello-world",
};

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

describe("resolveDraftPromotionNavigationTarget", () => {
  const serverThreadRef = { environmentId, threadId };
  const preparingRun = {
    ...completedTurn,
    status: "preparing" as const,
    startedAt: null,
    completedAt: null,
  };

  it("stays on the draft while the workspace is still preparing", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({ latestRun: preparingRun }),
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread(),
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
  });

  it("navigates once the run starts or startup stops", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({ latestRun: completedTurn }),
        backgroundSubmissionPending: false,
      }),
    ).toBe(serverThreadRef);
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({
          latestRun: { ...preparingRun, status: "failed" as const },
        }),
        backgroundSubmissionPending: false,
      }),
    ).toBe(serverThreadRef);
  });

  it("defers while a background submission is pending", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({ latestRun: completedTurn }),
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});

describe("resolveEffectiveInteractionMode", () => {
  it("forces build mode when legacy plan mode is disabled", () => {
    expect(
      resolveEffectiveInteractionMode({
        planModeEnabled: false,
        composerInteractionMode: "plan",
        threadInteractionMode: "plan",
      }),
    ).toBe("default");
  });

  it("uses the saved mode while legacy plan mode is enabled", () => {
    expect(
      resolveEffectiveInteractionMode({
        planModeEnabled: true,
        composerInteractionMode: null,
        threadInteractionMode: "plan",
      }),
    ).toBe("plan");
  });
});

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

describe("shouldShowPlanFollowUpPrompt", () => {
  const base = {
    pendingUserInputCount: 0,
    interactionMode: "plan" as const,
    latestTurnSettled: true,
    hasActionableProposedPlan: true,
    hasComposerAttachments: false,
  };

  it("shows plan actions for a settled actionable plan without attachments", () => {
    expect(shouldShowPlanFollowUpPrompt(base)).toBe(true);
  });

  it("hides plan actions while the composer has staged attachments", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasComposerAttachments: true })).toBe(false);
  });

  it("preserves the existing plan follow-up gates", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, pendingUserInputCount: 1 })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, interactionMode: "default" })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, latestTurnSettled: false })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasActionableProposedPlan: false })).toBe(false);
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

describe("agent browser close confirmation", () => {
  const surfaces = [
    { id: "browser:one", kind: "preview", resourceId: "tab-1" },
    { id: "browser:two", kind: "preview", resourceId: "tab-2" },
    { id: "diff", kind: "diff" },
  ] satisfies RightPanelSurface[];

  it("only warns for browsers under active agent control", () => {
    expect(
      agentControlledBrowserCloseConfirmation(surfaces, {
        "tab-1": { controller: "none" },
        "tab-2": { controller: "human" },
      }),
    ).toBeNull();

    expect(
      agentControlledBrowserCloseConfirmation([surfaces[0]!], {
        "tab-1": { controller: "agent" },
      }),
    ).toBe(
      [
        "Close browser while the agent is using it?",
        "The agent is actively controlling this browser. Closing it may interrupt the current browser action.",
      ].join("\n"),
    );
  });

  it("counts every agent-controlled browser in a bulk close", () => {
    expect(
      agentControlledBrowserCloseConfirmation(surfaces, {
        "tab-1": { controller: "agent" },
        "tab-2": { controller: "agent" },
      }),
    ).toContain("Close 2 browsers");
  });
});

describe("floating browser preview", () => {
  it("only hides the duplicate while the same browser is rendered in the panel", () => {
    expect(shouldRenderPreviewMiniPlayer(null, null)).toBe(false);
    expect(
      shouldRenderPreviewMiniPlayer("tab-1", {
        id: "browser:one",
        kind: "preview",
        resourceId: "tab-1",
      }),
    ).toBe(false);
    expect(
      shouldRenderPreviewMiniPlayer("tab-1", {
        id: "browser:two",
        kind: "preview",
        resourceId: "tab-2",
      }),
    ).toBe(true);
    expect(shouldRenderPreviewMiniPlayer("tab-1", { id: "diff", kind: "diff" })).toBe(true);
  });
});

describe("proactive panels", () => {
  it("opens a pull request only after a newly observed link appears", () => {
    expect(shouldOpenProactivePullRequest(undefined, "project:repo:42")).toBe(false);
    expect(shouldOpenProactivePullRequest(null, "project:repo:42")).toBe(true);
    expect(shouldOpenProactivePullRequest("project:repo:42", "project:repo:42")).toBe(false);
    expect(shouldOpenProactivePullRequest("project:repo:42", null)).toBe(false);
  });

  it("opens the diff only when the observed running turn settles", () => {
    const turnId = RunId.make("turn-1");
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: undefined,
        runningTurnId: null,
        settledTurnId: turnId,
        turnCompleted: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: turnId,
        runningTurnId: null,
        settledTurnId: turnId,
        turnCompleted: true,
      }),
    ).toBe(true);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: turnId,
        runningTurnId: RunId.make("turn-2"),
        settledTurnId: turnId,
        turnCompleted: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: turnId,
        runningTurnId: null,
        settledTurnId: turnId,
        turnCompleted: false,
      }),
    ).toBe(false);
  });
});

describe("artifact template composer insertion", () => {
  it("does not insert an already-present prompt", () => {
    const prompt = "Create a document using this $artifact-template-hello-world about…";

    expect(codexArtifactTemplatePromptToAppend(prompt, helloWorldTemplate)).toBeNull();
  });
});

describe("draft hero submission transition", () => {
  it("does not dock the composer before a background submission", () => {
    expect(
      shouldDockDraftHeroForSubmission({
        isDraftHeroState: true,
        activeThreadKey: "environment-local:thread-1",
        submissionIntent: "background",
      }),
    ).toBe(false);
  });

  it("keeps the composer in the hero layout until navigation after server promotion", () => {
    expect(
      resolveDraftHeroState({
        isLocalDraftThread: false,
        hasTimelineEntries: true,
        isWorking: true,
        draftHeroDockRequested: false,
        backgroundSubmissionPending: true,
      }),
    ).toBe(true);
  });

  it("does not auto-navigate a background submission after server promotion", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef: { environmentId, threadId },
        serverThread: makeThread({ latestRun: completedTurn }),
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});

describe("shouldReleaseTimelineAnchorForToolActivity", () => {
  const activeTurnId = RunId.make("active-turn");
  const anchorMessageId = MessageId.make("anchored-message");
  const activeToolEntry = {
    id: "tool-entry",
    kind: "work" as const,
    createdAt: now,
    entry: {
      id: "active-tool",
      createdAt: now,
      runId: activeTurnId,
      label: "Run command",
      tone: "tool" as const,
      command: "git status",
    },
  };

  it("releases the send anchor for tool activity in the active turn", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(true);
  });

  it("keeps the anchor while the user reads history", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: false,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(false);
  });

  it("ignores tool activity from earlier turns", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              ...activeToolEntry.entry,
              runId: RunId.make("previous-turn"),
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("ignores thinking and error rows without tool activity", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              id: "thinking-entry",
              createdAt: now,
              runId: activeTurnId,
              label: "Thinking",
              tone: "thinking",
            },
          },
          {
            ...activeToolEntry,
            id: "error-entry",
            entry: {
              id: "error-entry",
              createdAt: now,
              runId: activeTurnId,
              label: "Provider error",
              tone: "error",
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("does nothing without an anchor or running turn", () => {
    const input = {
      anchorMessageId,
      liveFollowEnabled: true,
      runningTurnId: activeTurnId,
      timelineEntries: [activeToolEntry],
    };

    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, anchorMessageId: null })).toBe(
      false,
    );
    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, runningTurnId: null })).toBe(
      false,
    );
  });
});

describe("environment reconnect warning grace", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a persistent reconnect after the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    scheduleEnvironmentReconnectWarning(showWarning);
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS - 1);
    expect(showWarning).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(showWarning).toHaveBeenCalledOnce();
  });

  it("cancels the warning when the connection recovers during the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    const cancel = scheduleEnvironmentReconnectWarning(showWarning);
    cancel();
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);

    expect(showWarning).not.toHaveBeenCalled();
  });

  it("does not reuse elapsed grace from another environment", () => {
    const anotherEnvironmentId = EnvironmentId.make("environment-remote");

    expect(hasEnvironmentReconnectWarningGraceElapsed(environmentId, environmentId)).toBe(true);
    expect(hasEnvironmentReconnectWarningGraceElapsed(anotherEnvironmentId, environmentId)).toBe(
      false,
    );
  });
});

describe("resolveComposerProviderSelection", () => {
  const catalogModels: ServerProvider["models"] = [
    { slug: "gemini-pro", name: "Gemini Pro", isCustom: false, capabilities: null },
  ];

  function entry(driver: string, instanceId = driver, overrides: Partial<ServerProvider> = {}) {
    return deriveProviderInstanceEntries([
      {
        driver: ProviderDriverKind.make(driver),
        instanceId: ProviderInstanceId.make(instanceId),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        ...overrides,
      },
    ])[0]!;
  }

  it("uses the custom instance's capability instead of the default instance", () => {
    const defaultEntry = entry("antigravity", "antigravity", {
      showInteractionModeToggle: true,
    });
    const customEntry = entry("antigravity", "google_work", {
      showInteractionModeToggle: false,
    });
    const selection = resolveComposerProviderSelection({
      entries: [defaultEntry, customEntry],
      candidateInstanceIds: [customEntry.instanceId],
      lockedProvider: null,
      lockedInstanceId: null,
    });

    expect(selection.selectedProviderEntry?.instanceId).toBe(customEntry.instanceId);
    expect(
      resolveComposerInteractionMode({
        provider: selection.selectedProviderEntry?.snapshot,
        planModeEnabled: true,
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });

  it("uses the fallback provider's plan capability after the draft's instance is disabled", () => {
    const disabledEntry = entry("antigravity", "antigravity", {
      enabled: false,
      showInteractionModeToggle: false,
    });
    const fallbackEntry = entry("codex");
    const selection = resolveComposerProviderSelection({
      entries: [disabledEntry, fallbackEntry],
      candidateInstanceIds: [disabledEntry.instanceId],
      lockedProvider: null,
      lockedInstanceId: null,
    });

    expect(selection.selectedProviderEntry?.instanceId).toBe(fallbackEntry.instanceId);
    expect(
      resolveComposerInteractionMode({
        provider: selection.selectedProviderEntry?.snapshot,
        planModeEnabled: true,
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: true, interactionMode: "plan" });
  });

  it("keeps a signed-out selection instead of silently switching providers", () => {
    const signedOutEntry = entry("antigravity", "google_work", {
      status: "error",
      auth: { status: "unauthenticated" },
      models: catalogModels,
    });
    const selection = resolveComposerProviderSelection({
      entries: [entry("codex"), signedOutEntry],
      candidateInstanceIds: [signedOutEntry.instanceId],
      lockedProvider: null,
      lockedInstanceId: null,
    });

    expect(selection.selectedProviderEntry?.instanceId).toBe(signedOutEntry.instanceId);
    expect(
      getAntigravitySendBlockReason(selection.selectedProviderEntry?.snapshot, "gemini-pro"),
    ).toBe("Sign in to Antigravity in provider settings before sending.");
  });

  it("blocks sends until the selected Antigravity profile is installed", () => {
    const provider = entry("antigravity", "google_work", {
      installed: false,
      models: catalogModels,
    }).snapshot;

    expect(getAntigravitySendBlockReason(provider, "gemini-pro")).toBe(
      "Install Antigravity in provider settings before sending.",
    );
  });

  it("lets Antigravity check saved credentials when resuming after a restart", () => {
    const provider = entry("antigravity", "google_work", {
      status: "warning",
      auth: { status: "unknown" },
      models: [],
    }).snapshot;

    expect(getAntigravitySendBlockReason(provider, "gemini-pro")).toBeNull();
    expect(getAntigravitySendBlockReason(provider, ANTIGRAVITY_DEFAULT_MODEL)).toBeNull();
    expect(
      getAntigravitySendBlockReason({ ...provider, models: catalogModels }, "gemini-pro"),
    ).toBeNull();
    expect(getAntigravitySendBlockReason(provider, "")).toBe(
      "Choose an Antigravity model before sending.",
    );
  });

  it("blocks saved model sends until Antigravity loads its account catalog", () => {
    expect(getAntigravitySendBlockReason(entry("antigravity").snapshot, "gemini-pro")).toBe(
      "Refresh Antigravity models in provider settings before sending.",
    );
  });

  it("blocks an empty Antigravity selection after the catalog has loaded", () => {
    const provider = entry("antigravity", "google_work", { models: catalogModels }).snapshot;

    expect(getAntigravitySendBlockReason(provider, "")).toBe(
      "Choose an Antigravity model before sending.",
    );
  });

  it("blocks a saved model that a ready catalog no longer lists", () => {
    const provider = entry("antigravity", "google_work", {
      status: "ready",
      models: catalogModels,
    }).snapshot;

    expect(getAntigravitySendBlockReason(provider, "saved-model-not-in-current-catalog")).toBe(
      "That Antigravity model is no longer available. Choose another model.",
    );
    expect(getAntigravitySendBlockReason(provider, "gemini-pro")).toBeNull();
  });

  it("allows a saved native model to retry after a provider error without changing it", () => {
    const provider = entry("antigravity", "google_work", {
      status: "error",
      models: catalogModels,
    }).snapshot;

    expect(
      getAntigravitySendBlockReason(provider, "saved-model-not-in-current-catalog"),
    ).toBeNull();
  });

  it("keeps existing send behavior for other providers", () => {
    const provider = entry("codex", "codex", {
      installed: false,
      auth: { status: "unknown" },
      models: [],
    }).snapshot;

    expect(getAntigravitySendBlockReason(provider, "gpt-model")).toBeNull();
  });

  it("does not continue an existing Antigravity thread in another profile after deletion", () => {
    const missingInstanceId = ProviderInstanceId.make("google_work");
    const selection = resolveComposerProviderSelection({
      entries: [entry("antigravity")],
      candidateInstanceIds: [missingInstanceId],
      lockedProvider: ProviderDriverKind.make("antigravity"),
      lockedInstanceId: missingInstanceId,
    });

    expect(selection.selectedProviderEntry).toBeUndefined();
    expect(selection.unavailableProviderInstanceId).toBe(missingInstanceId);
  });

  it("does not treat the empty draft placeholder as a provider setup target", () => {
    const selection = resolveComposerProviderSelection({
      entries: [entry("antigravity", "antigravity", { enabled: false })],
      candidateInstanceIds: [NO_PROVIDER_MODEL_SELECTION.instanceId],
      lockedProvider: null,
      lockedInstanceId: null,
    });

    expect(selection.selectedProviderEntry).toBeUndefined();
    expect(selection.unavailableProviderInstanceId).toBeUndefined();
  });

  it("keeps the session's continuation group when another instance was selected", () => {
    const sessionEntry = entry("antigravity", "google_work", {
      enabled: false,
      continuation: { groupKey: "work-profile" },
    });
    const anotherEntry = entry("antigravity", "google_personal", {
      continuation: { groupKey: "personal-profile" },
    });
    const selection = resolveComposerProviderSelection({
      entries: [sessionEntry, anotherEntry],
      candidateInstanceIds: [anotherEntry.instanceId, sessionEntry.instanceId],
      lockedProvider: ProviderDriverKind.make("antigravity"),
      lockedInstanceId: sessionEntry.instanceId,
    });

    expect(selection.selectedProviderEntry).toBeUndefined();
  });
});

describe("resolveComposerInteractionMode", () => {
  it("resets a restored plan draft when the selected instance does not support plan mode", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: true,
        provider: { showInteractionModeToggle: false },
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });

  it("keeps legacy plan behavior for providers that omit the capability", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: true,
        provider: {},
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: true, interactionMode: "plan" });
  });

  it("resets a restored plan draft when the beta setting is off", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: false,
        provider: { showInteractionModeToggle: true },
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });

  it("disables plan mode until the selected provider is available", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: true,
        provider: null,
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });
});

describe("resolveBackgroundDraftWorkspaceOptions", () => {
  it("keeps New worktree selected without reusing the launched worktree", () => {
    expect(
      resolveBackgroundDraftWorkspaceOptions({
        envMode: "worktree",
        branch: "main",
        startFromOrigin: true,
      }),
    ).toEqual({
      envMode: "worktree",
      branch: "main",
      worktreePath: null,
      startFromOrigin: true,
    });
  });
});
