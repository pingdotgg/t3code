import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { act, render } from "../../../test/render";
import { ChatComposer, type ChatComposerHandle, type ChatComposerProps } from "./ChatComposer";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const draftId = DraftId.make("draft");
const noop = () => {};

function composerProps(): ChatComposerProps {
  return {
    composerDraftTarget: draftId,
    environmentId,
    canOperateThread: true,
    attachmentUploadsCapabilityKnown: true,
    supportsAttachmentUploads: true,
    supportsQuestionAttachments: false,
    maxFileAttachmentBytes: 10 * 1024 * 1024,
    routeKind: "draft",
    routeThreadRef: { environmentId, threadId },
    draftId,
    multipleModelSelections: null,
    supportsMultipleModels: false,
    onMultipleModelSelectionsChange: noop,
    activeThreadId: threadId,
    activeThreadEnvironmentId: environmentId,
    activeThread: undefined,
    activeThreadShell: null,
    promptHistoryMessages: [],
    isServerThread: false,
    isLocalDraftThread: true,
    // An existing thread: only a brand-new one keeps the phone composer expanded.
    forceExpandedOnMobile: false,
    projectSelectionRequired: false,
    phase: "ready",
    canInterrupt: false,
    isConnecting: false,
    isSendBusy: false,
    canResume: false,
    sendDisabledReason: null,
    isPreparingWorktree: false,
    isCompacting: false,
    bannerItems: [],
    resumeCompactionTokens: null,
    keepFullHistory: false,
    onToggleKeepFullHistory: noop,
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
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    lockedProvider: null,
    providerStatuses: [],
    providerCatalogKnown: true,
    activeProjectDefaultModelSelection: null,
    activeThreadModelSelection: null,
    activeProjectId: null,
    activeContextWindow: null,
    compactThreadUnavailable: true,
    compactDisabled: true,
    compactDisabledReason: null,
    resolvedTheme: "light",
    settings: DEFAULT_UNIFIED_SETTINGS,
    keybindings: [],
    terminalOpen: false,
    gitCwd: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: undefined,
    restingControlsHost: null,
    restingControlsHaveLeadingContext: false,
    onRestingControlsVisibilityChange: noop,
    getTimelineScrollableNode: () => null,
    isTimelineAtLogicalEnd: () => true,
    timelineOverflows: false,
    onComposerOverlayHeightChange: noop,
    onRestingChange: noop,
    promptRef: { current: "" },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerRef: createRef<ChatComposerHandle>(),
    onPageScrollKeyDown: noop,
    onPageScrollKeyUp: noop,
    onPageScrollRelease: noop,
    editingQueuedAttachments: null,
    onRemoveEditingQueuedAttachment: noop,
    onCompactContext: noop,
    onSend: noop,
    onResume: noop,
    onInterrupt: noop,
    onImplementPlanInNewThread: noop,
    onRespondToApproval: async () => undefined,
    onSelectActivePendingUserInputOption: noop,
    onAdvanceActivePendingUserInput: noop,
    onDismissActivePendingUserInput: noop,
    onPreviousActivePendingUserInputQuestion: noop,
    onChangeActivePendingUserInputCustomAnswer: noop,
    onProviderModelSelect: noop,
    onOpenProviderSetup: noop,
    getModelDisabledReason: () => null,
    toggleInteractionMode: noop,
    handleRuntimeModeChange: noop,
    handleInteractionModeChange: noop,
    focusComposer: noop,
    scheduleComposerFocus: noop,
    setThreadError: noop,
    onExpandImage: noop,
    onFileOpen: noop,
  };
}

it("keeps a file picked on a phone after the picker collapses the composer", async () => {
  await page.viewport(390, 844);
  using _draft = {
    [Symbol.dispose]: () => useComposerDraftStore.getState().clearComposerContent(draftId),
  };
  await using screen = await render(<ChatComposer {...composerProps()} />);

  // Tapping the editor expands the phone composer and shows the attach button.
  await userEvent.click(screen.getByRole("textbox"));
  await expect.element(screen.getByRole("button", { name: "Attach files" })).toBeVisible();
  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("The composer has no file input.");
  // Stubbed so no real picker opens; the paperclip must open this input.
  const openPicker = vi.spyOn(input, "click").mockImplementation(() => {});
  await userEvent.click(screen.getByRole("button", { name: "Attach files" }));
  expect(openPicker).toHaveBeenCalledOnce();

  // Opening the OS picker blurs the editor, so the composer collapses while it is open.
  await act(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect
    .element(screen.getByRole("button", { name: "Attach files" }))
    .not.toBeInTheDocument();

  // When the picker returns, the browser fires change on the input it opened from,
  // whether or not that input is still mounted.
  const picked = new DataTransfer();
  picked.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
  input.files = picked.files;
  await act(() => input.dispatchEvent(new Event("change", { bubbles: true })));

  await vi.waitFor(() => {
    expect(
      useComposerDraftStore
        .getState()
        .getComposerDraft(draftId)
        ?.files.map((file) => file.name),
    ).toEqual(["notes.txt"]);
  });
});
