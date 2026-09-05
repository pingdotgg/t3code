import { AuthOrchestrationOperateScope, ApprovalRequestId } from "@t3tools/contracts";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  grantedEnvironments: new Set<string>(),
  connectionState: "connected",
  draft: { text: "Keep my draft", attachments: [] as DraftComposerImageAttachment[] },
  activities: [] as OrchestrationThreadActivity[],
  enqueue: vi.fn(async () => undefined),
  clearDraft: vi.fn(),
  approve: vi.fn(),
  answer: vi.fn(),
  feedback: vi.fn(),
  updateSettings: vi.fn(),
  question: {
    id: "language",
    header: "Language",
    question: "Which language?",
    options: [{ label: "TypeScript", description: "Use the existing code" }],
    multiSelect: false,
  },
  thread: {
    id: "thread",
    environmentId: "secondary",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: { status: "ready", providerName: "codex" },
    latestTurn: null,
  },
}));

vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: () => {},
  useMemo: <A>(factory: () => A) => factory(),
  useState: <A>(initial: A | (() => A)) => [
    typeof initial === "function" ? (initial as () => A)() : initial,
    vi.fn(),
  ],
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("./atom-registry");
  return { useAtomValue: <A>(atom: Atom.Atom<A>) => appAtomRegistry.get(atom) };
});
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.grantedEnvironments.has(environmentId),
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: state.thread,
    selectedEnvironmentRuntime: {
      connectionState: state.connectionState,
      serverConfig: {
        providers: [{ instanceId: "codex", driver: "codex" }],
        environment: { capabilities: {} },
      },
    },
  }),
}));
vi.mock("./use-thread-detail", () => ({
  useSelectedThreadDetail: () => ({ ...state.thread, messages: [], activities: state.activities }),
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: <A>(command: A) => command }));
vi.mock("./threads", () => ({
  threadEnvironment: {
    respondToApproval: state.approve,
    respondToUserInput: state.answer,
    uploadFeedback: state.feedback,
  },
}));
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { dispatchingQueuedMessageIdAtom: Atom.make(null), useThreadOutboxMessages: () => ({}) };
});
vi.mock("./thread-outbox", () => ({ enqueueThreadOutboxMessage: state.enqueue }));
vi.mock("./composer-attachment-uploads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    composerAttachmentUploadsAtom: Atom.make({}),
    composerAttachmentUploadBlockReason: () => null,
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    getComposerDraftSnapshot: () => state.draft,
    clearComposerDraftContent: state.clearDraft,
    setComposerDraftText: (_key: string, text: string) => {
      state.draft.text = text;
    },
    updateComposerDraftSettings: state.updateSettings,
    ensureComposerDraftsLoaded: () => {},
    scheduleUnusedComposerAttachmentCleanup: () => {},
    appendComposerDraftAttachments: vi.fn(),
    appendComposerDraftText: vi.fn(),
    mergeComposerDraftContent: vi.fn(),
    removeComposerDraftAttachment: vi.fn(),
    useComposerDraft: () => state.draft,
  };
});
vi.mock("../lib/composerImages", () => ({
  convertPastedImagesToAttachments: vi.fn(),
  pasteComposerClipboard: vi.fn(),
  pickComposerFiles: vi.fn(),
  pickComposerMedia: vi.fn(),
}));
vi.mock("../lib/commandMetadata", () => ({
  makeQueuedMessageMetadata: () => ({
    messageId: "message",
    commandId: "command",
    createdAt: "2026-09-05T00:00:00.000Z",
  }),
}));
vi.mock("../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../lib/modelOptions", () => ({ isModelSelectionUnavailable: () => false }));
vi.mock("./use-remote-environment-registry", () => ({ setPendingConnectionError: vi.fn() }));

import { useThreadComposerState } from "./use-thread-composer-state";
import { useSelectedThreadRequests } from "./use-selected-thread-requests";

beforeEach(() => {
  state.grantedEnvironments = new Set(["primary"]);
  state.connectionState = "connected";
  state.draft = { text: "Keep my draft", attachments: [] };
  state.activities = [];
  vi.clearAllMocks();
  state.approve.mockResolvedValue(AsyncResult.success(undefined));
  state.answer.mockResolvedValue(AsyncResult.success(undefined));
  state.feedback.mockResolvedValue(AsyncResult.success({ feedbackId: "feedback" }));
});

describe("mobile task permissions", () => {
  it("keeps a connected read-only task's draft instead of queueing it with another environment's grant", async () => {
    const composer = useThreadComposerState();
    expect(await composer.onSendMessage()).toBeNull();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();
    composer.onChangeDraftMessage("Edited locally");
    composer.onUpdateInteractionMode("plan");
    expect(state.draft.text).toBe("Edited locally");
    expect(state.updateSettings).toHaveBeenCalledWith("secondary:thread", {
      interactionMode: "plan",
    });
  });

  it("rechecks a retained send callback before clearing or queueing the draft", async () => {
    state.grantedEnvironments.add("secondary");
    const composer = useThreadComposerState();
    state.grantedEnvironments.delete("secondary");
    expect(await composer.onSendMessage()).toBeNull();
    expect(state.clearDraft).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
    state.grantedEnvironments.add("secondary");
    expect(await composer.onSendMessage()).toBe("message");
    expect(state.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "secondary",
        threadId: "thread",
        text: "Keep my draft",
      }),
    );
  });

  it("preserves offline queueing without dispatching feedback through the queue action", async () => {
    state.connectionState = "disconnected";
    expect(await useThreadComposerState().onSendMessage()).toBe("message");
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    state.draft.text = "/feedback The agent stopped early.";
    expect(await useThreadComposerState().onSendMessage()).toBeNull();
    expect(state.feedback).not.toHaveBeenCalled();
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    expect(state.clearDraft).toHaveBeenCalledTimes(1);
  });

  it("rechecks the target environment before an approval response", async () => {
    state.grantedEnvironments.add("secondary");
    const requests = useSelectedThreadRequests();
    state.grantedEnvironments.delete("secondary");
    await requests.onRespondToApproval(ApprovalRequestId.make("approval"), "accept");
    expect(state.approve).not.toHaveBeenCalled();
    state.grantedEnvironments.add("secondary");
    await requests.onRespondToApproval(ApprovalRequestId.make("approval"), "accept");
    expect(state.approve).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { threadId: "thread", requestId: "approval", decision: "accept" },
    });
  });

  it("keeps answer drafts editable after revocation while blocking their submission", async () => {
    state.activities = [
      {
        id: "input-activity",
        kind: "user-input.requested",
        summary: "Choose language",
        tone: "info",
        turnId: null,
        createdAt: "2026-09-05T00:00:00.000Z",
        payload: { requestId: "input", questions: [state.question] },
      },
    ] as OrchestrationThreadActivity[];
    const requestId = ApprovalRequestId.make("input");
    useSelectedThreadRequests().onSelectUserInputOption(requestId, state.question, "TypeScript");
    state.grantedEnvironments.add("secondary");
    const requests = useSelectedThreadRequests();
    expect(requests.activePendingUserInputAnswers).toEqual({ language: "TypeScript" });
    state.grantedEnvironments.delete("secondary");
    await requests.onSubmitUserInput();
    expect(state.answer).not.toHaveBeenCalled();
    expect(useSelectedThreadRequests().activePendingUserInputAnswers).toEqual({
      language: "TypeScript",
    });
    state.grantedEnvironments.add("secondary");
    await requests.onSubmitUserInput();
    expect(state.answer).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { threadId: "thread", requestId: "input", answers: { language: "TypeScript" } },
    });
  });
});
