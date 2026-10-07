// @vitest-environment jsdom

import {
  EnvironmentId,
  PluginActionId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type PluginAction,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import type { Editor } from "@tiptap/core";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { buildLocalDraftThread } from "../ChatView.logic";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { ChatComposer, type ChatComposerHandle, type ChatComposerProps } from "./ChatComposer";

const environmentId = EnvironmentId.make("environment-plugins");
const threadId = ThreadId.make("thread-plugins");
const projectId = ProjectId.make("project-plugins");
const instanceId = ProviderInstanceId.make("codex");

const deploy: PluginAction = {
  id: PluginActionId.make("plugin-deploy:deploy"),
  pluginId: "plugin-deploy",
  pluginName: "Deploy",
  name: "deploy",
  title: "Deploy this thread",
  target: "thread",
  placements: ["composer-slash"],
};
const openDashboard: PluginAction = {
  id: PluginActionId.make("plugin-dashboard:open-dashboard"),
  pluginId: "plugin-dashboard",
  pluginName: "Dashboard",
  name: "open-dashboard",
  title: "Open the project dashboard",
  target: "project",
  placements: ["composer-slash"],
};

const pluginActionsMock = vi.hoisted(() => ({
  runPluginAction: vi.fn<(input: unknown) => Promise<void>>(async () => undefined),
}));

// The environment's action list and the RPC that runs one are the boundaries.
vi.mock("../../state/pluginActions", () => ({
  usePluginActions: () => [deploy, openDashboard],
}));
vi.mock("../../pluginActions", () => ({
  runPluginAction: pluginActionsMock.runPluginAction,
}));

const modelSelection = createModelSelection(instanceId, "gpt-5.4");
const thread = buildLocalDraftThread(
  threadId,
  {
    threadId,
    environmentId,
    projectId,
    logicalProjectKey: "project-plugins",
    createdAt: "2026-10-04T00:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
  },
  modelSelection,
);
const threadRef: ScopedThreadRef = { environmentId, threadId };
const draftId = DraftId.make("draft-plugins");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // A desktop viewport: no media query matches (jsdom has no matchMedia).
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
  // jsdom has no FontFaceSet; the resting controls re-measure on its events.
  if (!("fonts" in document)) {
    Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
  }
  // jsdom does no layout, so scrolling an element into view has nothing to do.
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.getAnimations ??= () => [];
  // ProseMirror measures the caret to keep it in view after each edit.
  Range.prototype.getClientRects ??= () => document.createElement("div").getClientRects();
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  pluginActionsMock.runPluginAction.mockClear();
  // Both server-thread tests type into the same thread's draft.
  useComposerDraftStore.getState().setPrompt(threadRef, "");
  useComposerDraftStore.getState().setPrompt(draftId, "");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const noop = () => undefined;

function composerProps(
  route: "server" | "draft",
  onSend: ChatComposerProps["onSend"],
  promptRef: React.RefObject<string>,
  canOperateThread: boolean,
): ChatComposerProps {
  const isServer = route === "server";
  return {
    composerDraftTarget: isServer ? threadRef : draftId,
    environmentId,
    canOperateThread,
    attachmentUploadsCapabilityKnown: true,
    supportsAttachmentUploads: false,
    supportsQuestionAttachments: false,
    maxFileAttachmentBytes: null,
    routeKind: route,
    routeThreadRef: threadRef,
    draftId: isServer ? null : draftId,
    multipleModelSelections: null,
    supportsMultipleModels: false,
    onMultipleModelSelectionsChange: noop,
    activeThreadId: isServer ? threadId : null,
    activeThreadEnvironmentId: environmentId,
    activeThread: thread,
    activeThreadShell: isServer ? thread : null,
    promptHistoryMessages: [],
    isServerThread: isServer,
    isLocalDraftThread: !isServer,
    forceExpandedOnMobile: false,
    projectSelectionRequired: false,
    phase: "ready",
    canInterrupt: false,
    isConnecting: false,
    isSendBusy: false,
    canResume: false,
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
    providerCatalogKnown: true,
    activeProjectDefaultModelSelection: null,
    activeThreadModelSelection: modelSelection,
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
    restingControlsHost: null,
    restingControlsHaveLeadingContext: false,
    onRestingControlsVisibilityChange: noop,
    getTimelineScrollableNode: () => null,
    isTimelineAtLogicalEnd: () => true,
    timelineOverflows: false,
    onComposerOverlayHeightChange: noop,
    onRestingChange: noop,
    promptRef,
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
    onSend,
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

async function renderComposer(route: "server" | "draft", canOperateThread = true) {
  const onSend = vi.fn<ChatComposerProps["onSend"]>();
  const promptRef: React.RefObject<string> = { current: "" };
  await act(async () =>
    root.render(<ChatComposer {...composerProps(route, onSend, promptRef, canOperateThread)} />),
  );
  return { onSend, promptRef };
}

function promptEditor(): HTMLElement & { editor?: Editor } {
  const element = container.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!element) throw new Error("The composer editor did not render");
  return element;
}

// Types `beforeCaret` then `afterCaret` into the real editor ("\n" starts a
// new line), leaving the caret between them as if the user moved it back.
async function typePrompt(beforeCaret: string, afterCaret = "") {
  const editor = promptEditor().editor;
  if (!editor) throw new Error("The composer editor has no Tiptap instance");
  const type = (text: string) =>
    text.split("\n").forEach((line, index) => {
      if (index > 0) editor.commands.splitBlock();
      if (line) editor.commands.insertContent(line);
    });
  let caret = 0;
  await act(async () => {
    editor.commands.focus();
    type(beforeCaret);
    caret = editor.state.selection.from;
    type(afterCaret);
  });
  await act(async () => {
    editor.commands.setTextSelection(caret);
  });
}

function editorLines(): string[] {
  return [...promptEditor().querySelectorAll("p")].map((line) => line.textContent ?? "");
}

function menuOptions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-composer-item-id]")];
}

function menuOption(label: string): HTMLElement {
  const option = menuOptions().find((element) => element.textContent?.includes(label));
  if (!option) throw new Error(`No composer menu option ${label}`);
  return option;
}

async function pressEnter() {
  await act(async () => {
    promptEditor().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ChatComposer plugin actions in the slash menu", () => {
  it("runs a thread action picked with Enter and removes the typed command", async () => {
    const { onSend, promptRef } = await renderComposer("server");
    await typePrompt("please\n/depl", " now");
    expect(menuOption("/deploy").textContent).toContain("Deploy this thread");

    await pressEnter();

    expect(pluginActionsMock.runPluginAction).toHaveBeenCalledTimes(1);
    expect(pluginActionsMock.runPluginAction).toHaveBeenCalledWith({
      environmentId,
      action: deploy,
      target: { _tag: "thread", threadId },
    });
    expect(promptRef.current).toBe("please\n now");
    expect(editorLines()).toEqual(["please", " now"]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("runs a thread action picked with the pointer and removes the typed command", async () => {
    const { onSend, promptRef } = await renderComposer("server");
    await typePrompt("please\n/depl", " now");

    await click(menuOption("/deploy"));

    expect(pluginActionsMock.runPluginAction).toHaveBeenCalledTimes(1);
    expect(pluginActionsMock.runPluginAction).toHaveBeenCalledWith({
      environmentId,
      action: deploy,
      target: { _tag: "thread", threadId },
    });
    expect(promptRef.current).toBe("please\n now");
    expect(editorLines()).toEqual(["please", " now"]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("offers only project actions on a draft and runs them on the project", async () => {
    const { onSend, promptRef } = await renderComposer("draft");
    await typePrompt("/");
    const labels = menuOptions().map((element) => element.textContent ?? "");
    expect(labels.some((label) => label.includes("/open-dashboard"))).toBe(true);
    expect(labels.some((label) => label.includes("/deploy"))).toBe(false);

    await click(menuOption("/open-dashboard"));

    expect(pluginActionsMock.runPluginAction).toHaveBeenCalledTimes(1);
    expect(pluginActionsMock.runPluginAction).toHaveBeenCalledWith({
      environmentId,
      action: openDashboard,
      target: { _tag: "project", projectId },
    });
    expect(promptRef.current).toBe("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("offers no plugin actions to a read-only connection and keeps the typed command", async () => {
    const { promptRef } = await renderComposer("server", false);
    await typePrompt("please\n/depl", " now");
    expect(menuOptions().some((element) => element.textContent?.includes("/deploy"))).toBe(false);

    await pressEnter();

    expect(pluginActionsMock.runPluginAction).not.toHaveBeenCalled();
    expect(promptRef.current).toBe("please\n/depl now");
    expect(editorLines()).toEqual(["please", "/depl now"]);
  });
});
