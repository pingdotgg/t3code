import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ApprovalRequestId,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import { questionAttachmentDraftId } from "../../questionAttachments";
import type { ComposerPromptEditor } from "../ComposerPromptEditor";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";

// Keep composer state and draft storage real; omit the DOM editor and unrelated RPCs.
vi.mock("../ComposerPromptEditor", () => ({
  ComposerPromptEditor: (props: ComponentProps<typeof ComposerPromptEditor>) => {
    editor = props;
    return null;
  },
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("./PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../lib/composerPathSearchState", () => ({
  useComposerPathSearch: () => ({ entries: [], error: null, isPending: false }),
}));
vi.mock("./ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

const threadRef = scopeThreadRef(EnvironmentId.make("test-env"), ThreadId.make("test-thread"));
const pendingInput = {
  requestId: ApprovalRequestId.make("test-request"),
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [{ id: "approach", header: "Approach", question: "Which approach?", options: [] }],
  dismissible: true,
};

let renderer: ReactTestRenderer | undefined;
let props: ChatComposerProps;
let editor: ComponentProps<typeof ComposerPromptEditor>;

function renderComposer() {
  return act(() => {
    if (renderer) renderer.update(<ChatComposer {...props} />);
    else renderer = create(<ChatComposer {...props} />);
  });
}

function toggle(label: string) {
  return renderer!.root.find((node) => node.type === "button" && node.children.includes(label));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Element", EventTarget);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { activeElement: null }));
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      Element,
      performance,
      matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
      setTimeout,
      clearTimeout,
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
    }),
  );
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  props = {
    composerDraftTarget: threadRef,
    environmentId: threadRef.environmentId,
    attachmentUploadsCapabilityKnown: false,
    supportsAttachmentUploads: false,
    supportsQuestionAttachments: true,
    maxFileAttachmentBytes: null,
    routeKind: "server",
    routeThreadRef: threadRef,
    draftId: null,
    activeThreadId: threadRef.threadId,
    activeThreadEnvironmentId: threadRef.environmentId,
    activeThread: undefined,
    activeThreadShell: null,
    promptHistoryMessages: [],
    isServerThread: true,
    isLocalDraftThread: false,
    forceExpandedOnMobile: false,
    projectSelectionRequired: false,
    phase: "ready",
    isConnecting: false,
    isSendBusy: false,
    sendDisabledReason: null,
    isPreparingWorktree: false,
    bannerItems: [],
    environmentUnavailable: null,
    activePendingApproval: null,
    pendingApprovals: [],
    pendingUserInputs: [],
    activePendingProgress: null,
    activePendingResolvedAnswers: null,
    activePendingIsResponding: false,
    activePendingDraftAnswers: {},
    activePendingQuestionIndex: 0,
    respondingRequestIds: [],
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    activeTasksProgress: null,
    activeTaskSteps: null,
    threadSyncPhase: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    lockedProvider: null,
    providerStatuses: [],
    providerCatalogKnown: false,
    activeProjectDefaultModelSelection: null,
    activeThreadModelSelection: null,
    activeContextWindow: null,
    compactThreadUnavailable: true,
    compactDisabled: true,
    compactDisabledReason: null,
    resolvedTheme: "dark",
    settings: DEFAULT_UNIFIED_SETTINGS,
    keybindings: [],
    terminalOpen: false,
    gitCwd: null,
    restingControlsHost: null,
    restingControlsHaveLeadingContext: false,
    onRestingControlsVisibilityChange: () => {},
    getTimelineScrollableNode: () => null,
    isTimelineAtLogicalEnd: () => true,
    timelineOverflows: false,
    onComposerOverlayHeightChange: () => {},
    onRestingChange: () => {},
    promptRef: { current: "" },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerElementContextsRef: { current: [] },
    composerRef: { current: null },
    onPageScrollKeyDown: () => {},
    onPageScrollKeyUp: () => {},
    onPageScrollRelease: () => {},
    onSend: () => {},
    onInterrupt: () => {},
    onImplementPlanInNewThread: () => {},
    onRespondToApproval: async () => {},
    onSelectActivePendingUserInputOption: () => {},
    onAdvanceActivePendingUserInput: () => {},
    onDismissActivePendingUserInput: () => {},
    onPreviousActivePendingUserInputQuestion: () => {},
    onChangeActivePendingUserInputCustomAnswer: (questionId, customAnswer) => {
      props.activePendingDraftAnswers[questionId] = { selectedOptionValues: [], customAnswer };
      props.activePendingProgress = derivePendingUserInputProgress(
        pendingInput.questions,
        props.activePendingDraftAnswers,
        0,
      );
      renderer!.update(<ChatComposer {...props} />);
    },
    onToggleAnsweringPendingUserInput: () => {
      props.activePendingProgress = props.activePendingProgress
        ? null
        : derivePendingUserInputProgress(
            pendingInput.questions,
            props.activePendingDraftAnswers,
            0,
          );
      renderer!.update(<ChatComposer {...props} />);
    },
    onProviderModelSelect: () => {},
    onOpenProviderSetup: () => {},
    getModelDisabledReason: () => null,
    toggleInteractionMode: () => {},
    handleRuntimeModeChange: () => {},
    handleInteractionModeChange: () => {},
    focusComposer: () => {},
    scheduleComposerFocus: () => {},
    setThreadError: () => {},
    onExpandImage: () => {},
    onFileOpen: () => {},
  };
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  vi.unstubAllGlobals();
});

it("keeps typing in the message until answering, and restores each draft and its attachments", async () => {
  const store = useComposerDraftStore.getState();
  store.setPrompt(threadRef, "Use the existing migration and ");
  const file = new File(["notes"], "message.txt", { type: "text/plain" });
  const attachment = {
    type: "file" as const,
    id: "message-file",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
  store.addFiles(threadRef, [attachment]);
  await renderComposer();

  props.pendingUserInputs = [pendingInput];
  await renderComposer();
  expect(editor.value).toBe("Use the existing migration and ");
  expect(props.composerFilesRef.current).toEqual([attachment]);
  props.respondingRequestIds = [pendingInput.requestId];
  await renderComposer();
  expect(toggle("Answer question").props.disabled).toBe(true);
  expect(editor.disabled).toBe(false);
  props.respondingRequestIds = [];
  await renderComposer();

  const message = "Use the existing migration and keep the API unchanged.";
  await act(() => editor.onChange(message, message.length, message.length, false, []));
  expect(props.composerRef.current?.getSendContext()).toMatchObject({
    prompt: message,
    files: [attachment],
  });

  await act(() => toggle("Answer question").props.onClick());
  expect(editor.value).toBe("");
  expect(props.composerFilesRef.current).toEqual([]);
  await act(() => editor.onChange("Incrementally", 13, 13, false, []));
  const answerAttachment = { ...attachment, id: "answer-file", name: "answer.txt" };
  await act(() =>
    store.addFiles(
      questionAttachmentDraftId(
        threadRef.environmentId,
        threadRef.threadId,
        pendingInput.requestId,
        "approach",
      ),
      [answerAttachment],
    ),
  );

  await act(() => toggle("Back to message").props.onClick());
  expect(editor.value).toBe(message);
  expect(props.composerRef.current?.getSendContext()).toMatchObject({
    prompt: message,
    files: [attachment],
  });

  await act(() => toggle("Answer question").props.onClick());
  expect(editor.value).toBe("Incrementally");
  expect(props.composerRef.current?.getSendContext()).toMatchObject({
    prompt: "Incrementally",
    files: [answerAttachment],
  });
  props.activePendingIsResponding = true;
  await renderComposer();
  expect(toggle("Back to message").props.disabled).toBe(true);
  expect(editor.disabled).toBe(true);

  props.pendingUserInputs = [];
  props.activePendingProgress = null;
  props.activePendingIsResponding = false;
  await renderComposer();
  expect(editor.value).toBe(message);
  expect(props.composerRef.current?.getSendContext()).toMatchObject({
    prompt: message,
    files: [attachment],
  });
});
