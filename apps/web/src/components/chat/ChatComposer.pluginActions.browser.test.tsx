import { act, render as renderScreen, stubGlobal, type Screen } from "../../../test/render";
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
import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
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
  runPluginAction: vi.fn<(input: unknown) => Promise<boolean>>(async () => true),
  // The live operate grant, which can change after the menu was offered.
  canRunNow: true,
}));
// The environment's action list and the RPC that runs one are the boundaries.
vi.mock("../../state/pluginActions", () => ({
  usePluginActions: () => [deploy, openDashboard],
}));
vi.mock("../../pluginActions", () => ({
  runPluginAction: pluginActionsMock.runPluginAction,
  canRunPluginActionsNow: () => pluginActionsMock.canRunNow,
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
    activeThread: thread,
    activeThreadShell: isServer ? thread : null,
    promptHistoryMessages: [],
    forceExpandedOnMobile: false,
    projectSelectionRequired: false,
    phase: "ready",
    canInterrupt: false,
    isSendBusy: false,
    isCompacting: false,
    canResume: false,
    sendDisabledReason: null,
    isPreparingWorktree: false,
    bannerItems: [],
    resumeCompactionTokens: null,
    keepFullHistory: false,
    onToggleKeepFullHistory: noop,
    environmentUnavailable: null,
    activePendingApproval: null,
    pendingApprovals: [],
    onHeldRequestIdsChange: noop,
    pendingUserInputs: [],
    activePendingProgress: null,
    activePendingResolvedAnswers: null,
    activePendingIsResponding: false,
    activePendingDraftAnswers: {},
    activePendingQuestionIndex: 0,
    respondingRequestIds: [],
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    threadSyncPhase: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    lockedProvider: null,
    providerStatuses: [],
    providerCatalogKnown: true,
    activeProjectDefaultModelSelection: null,
    activeThreadModelSelection: modelSelection,
    activeProjectId: projectId,
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
    threadPullRequests: [],
    onComposerOverlayHeightChange: noop,
    permissionsShownInStrip: false,
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
async function renderComposer(screen: Screen, route: "server" | "draft", canOperateThread = true) {
  const onSend = vi.fn<ChatComposerProps["onSend"]>();
  const promptRef: React.RefObject<string> = { current: "" };
  const render = (canOperate: boolean) =>
    act(
      async () =>
        await screen.rerender(
          <ChatComposer {...composerProps(route, onSend, promptRef, canOperate)} />,
        ),
    );
  await render(canOperateThread);
  return { onSend, promptRef, render };
}
function promptEditor(screen: Screen): HTMLElement & {
  editor?: Editor;
} {
  const element = screen.container.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!element) throw new Error("The composer editor did not render");
  return element;
}
// Types `beforeCaret` then `afterCaret` into the real editor ("\n" starts a
// new line), leaving the caret between them as if the user moved it back.
async function typePrompt(screen: Screen, beforeCaret: string, afterCaret = "") {
  const editor = promptEditor(screen).editor;
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
function editorLines(screen: Screen): string[] {
  return [...promptEditor(screen).querySelectorAll("p")].map((line) => line.textContent ?? "");
}
function menuOptions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-composer-item-id]")];
}
function menuOption(label: string): HTMLElement {
  const option = menuOptions().find((element) => element.textContent?.includes(label));
  if (!option) throw new Error(`No composer menu option ${label}`);
  return option;
}
async function pressEnter(screen: Screen) {
  await act(async () => {
    promptEditor(screen).dispatchEvent(
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
    using _setup = await setup();
    // The composer uses explicit test layers; these action tests do not navigate.
    await using screen = await renderScreen(null, { router: false });
    const { onSend, promptRef } = await renderComposer(screen, "server");
    await typePrompt(screen, "please\n/depl", " now");
    expect(menuOption("/deploy").textContent).toContain("Deploy this thread");
    await pressEnter(screen);
    expect(pluginActionsMock.runPluginAction).toHaveBeenCalledTimes(1);
    expect(pluginActionsMock.runPluginAction).toHaveBeenCalledWith({
      environmentId,
      action: deploy,
      target: { _tag: "thread", threadId },
    });
    expect(promptRef.current).toBe("please\n now");
    expect(editorLines(screen)).toEqual(["please", " now"]);
    expect(onSend).not.toHaveBeenCalled();
  });
  it("runs a thread action picked with the pointer and removes the typed command", async () => {
    using _setup = await setup();
    // The composer uses explicit test layers; these action tests do not navigate.
    await using screen = await renderScreen(null, { router: false });
    const { onSend, promptRef } = await renderComposer(screen, "server");
    await typePrompt(screen, "please\n/depl", " now");
    await click(menuOption("/deploy"));
    expect(pluginActionsMock.runPluginAction).toHaveBeenCalledTimes(1);
    expect(pluginActionsMock.runPluginAction).toHaveBeenCalledWith({
      environmentId,
      action: deploy,
      target: { _tag: "thread", threadId },
    });
    expect(promptRef.current).toBe("please\n now");
    expect(editorLines(screen)).toEqual(["please", " now"]);
    expect(onSend).not.toHaveBeenCalled();
  });
  it("offers only project actions on a draft and runs them on the project", async () => {
    using _setup = await setup();
    // The composer uses explicit test layers; these action tests do not navigate.
    await using screen = await renderScreen(null, { router: false });
    const { onSend, promptRef } = await renderComposer(screen, "draft");
    await typePrompt(screen, "/");
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
    using _setup = await setup();
    // The composer uses explicit test layers; these action tests do not navigate.
    await using screen = await renderScreen(null, { router: false });
    const { promptRef } = await renderComposer(screen, "server", false);
    await typePrompt(screen, "please\n/depl", " now");
    expect(menuOptions().some((element) => element.textContent?.includes("/deploy"))).toBe(false);
    await pressEnter(screen);
    expect(pluginActionsMock.runPluginAction).not.toHaveBeenCalled();
    expect(promptRef.current).toBe("please\n/depl now");
    expect(editorLines(screen)).toEqual(["please", "/depl now"]);
  });
  it("keeps the typed command when the grant is lost while the menu is open", async () => {
    using _setup = await setup();
    // The composer uses explicit test layers; these action tests do not navigate.
    await using screen = await renderScreen(null, { router: false });
    const { promptRef, render } = await renderComposer(screen, "server");
    await typePrompt(screen, "please\n/depl", " now");
    expect(menuOption("/deploy").textContent).toContain("Deploy this thread");
    await render(false);
    await pressEnter(screen);
    expect(pluginActionsMock.runPluginAction).not.toHaveBeenCalled();
    expect(promptRef.current).toBe("please\n/depl now");
  });
  it("reads the live grant when the action is picked and keeps the draft if it is gone", async () => {
    using _setup = await setup();
    // The composer uses explicit test layers; these action tests do not navigate.
    await using screen = await renderScreen(null, { router: false });
    const { promptRef } = await renderComposer(screen, "server");
    await typePrompt(screen, "please\n/depl", " now");
    expect(menuOption("/deploy").textContent).toContain("Deploy this thread");
    // The cached grant still offers the action, but the connection lost it.
    pluginActionsMock.canRunNow = false;
    await pressEnter(screen);
    expect(pluginActionsMock.runPluginAction).not.toHaveBeenCalled();
    expect(promptRef.current).toBe("please\n/depl now");
    expect(editorLines(screen)).toEqual(["please", "/depl now"]);
  });
  it("removes the command when it is picked, before the action settles, and runs it once", async () => {
    using _setup = await setup();
    // The composer uses explicit test layers; these action tests do not navigate.
    await using screen = await renderScreen(null, { router: false });
    let finish: (ran: boolean) => void = () => {};
    pluginActionsMock.runPluginAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { promptRef } = await renderComposer(screen, "server");
    await typePrompt(screen, "please\n/depl", " now");
    await pressEnter(screen);
    expect(promptRef.current).toBe("please\n now");
    // The command is gone, so picking again has nothing to run.
    await pressEnter(screen);
    await act(async () => finish(true));
    expect(pluginActionsMock.runPluginAction).toHaveBeenCalledTimes(1);
  });
  it("leaves the draft alone when the action settles after the composer is gone", async () => {
    using _setup = await setup();
    // The composer uses explicit test layers; these action tests do not navigate.
    await using screen = await renderScreen(null, { router: false });
    let finish: (ran: boolean) => void = () => {};
    pluginActionsMock.runPluginAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await renderComposer(screen, "server");
    await typePrompt(screen, "please\n/depl", " now");
    await pressEnter(screen);
    await act(async () => await screen.unmount());
    useComposerDraftStore.getState().setPrompt(threadRef, "/depl newer draft");
    await act(async () => finish(true));
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "/depl newer draft",
    );
  });
});

async function setup() {
  const global0 = stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const global1 = stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
  if (!("fonts" in document)) {
    Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
  }
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.getAnimations ??= () => [];
  Range.prototype.getClientRects ??= () => document.createElement("div").getClientRects();
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  pluginActionsMock.runPluginAction.mockReset().mockResolvedValue(true);
  pluginActionsMock.canRunNow = true;
  useComposerDraftStore.getState().setPrompt(threadRef, "");
  useComposerDraftStore.getState().setPrompt(draftId, "");
  return {
    [Symbol.dispose]() {
      global1[Symbol.dispose]();
      global0[Symbol.dispose]();
    },
  };
}
