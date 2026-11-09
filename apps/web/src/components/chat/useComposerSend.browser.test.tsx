import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { useImperativeHandle, type RefObject } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../ui/toast";
import { useComposerSend } from "./useComposerSend";

const mocks = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    move: vi.fn<(value: unknown) => Promise<unknown>>(),
    startTurn: vi.fn(),
    serverConfigs: Atom.make<ReadonlyMap<string, unknown>>(new Map()).pipe(Atom.keepAlive),
  };
});

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.move }));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => mocks.startTurn) as never,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/server"), async (importOriginal) => ({
  ...(await importOriginal()),
  environmentServerConfigsAtom: mocks.serverConfigs as never,
}));

const ENV = EnvironmentId.make("env-1");
const THREAD = ThreadId.make("thread-1");
const ROUTE_KEY = `${ENV}:${THREAD}`;
const DRAFT_TARGET = scopeThreadRef(ENV, THREAD);
type Input = Parameters<typeof useComposerSend>[0];
type Api = ReturnType<typeof useComposerSend>;

function Harness(props: { readonly input: Input; readonly api: RefObject<Api | null> }) {
  const api = useComposerSend(props.input);
  useImperativeHandle(props.api, () => api);
  return null;
}

type Options = Partial<Record<"folderMove" | "editingQueuedMessage" | "pendingQuestion", boolean>>;

async function setup(options: Options) {
  mocks.move.mockReset();
  mocks.startTurn.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const capabilities = { threadWorkingFolderMove: options.folderMove !== false };
  appAtomRegistry.set(mocks.serverConfigs, new Map([[ENV, { environment: { capabilities } }]]));
  const saveEdit = vi.fn();
  const answer = vi.fn();
  const promptRef = { current: "/cd .." };
  useComposerDraftStore.getState().setPrompt(DRAFT_TARGET, promptRef.current);
  const sendContext = {
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
    providerAvailable: true,
    multipleModelSelections: null,
    shownPendingApprovalIds: [],
    selectedProvider: "claude",
    selectedModel: "claude-sonnet-4-5",
    selectedProviderModels: [],
    selectedPromptEffort: null,
    selectedModelSelection: { instanceId: "claude", model: "claude-sonnet-4-5" },
  };
  const noop = () => {};
  const input = {
    environmentId: ENV,
    routeThreadKey: ROUTE_KEY,
    currentRouteThreadKeyRef: { current: ROUTE_KEY },
    activeThread: { id: THREAD, environmentId: ENV, worktreePath: null },
    activeProject: { id: ProjectId.make("project-1"), environmentId: ENV, workspaceRoot: "/repo" },
    isLocalDraftThread: false,
    resumeCompactionTokens: null,
    composerRef: {
      current: {
        getSendContext: () => sendContext,
        resetCursorState: noop,
        focusAtEnd: noop,
        validateProviderInput: () => true,
      },
    },
    composerDraftTarget: DRAFT_TARGET,
    promptRef,
    feedbackUploadsInFlightRef: { current: new Set<string>() },
    queuedRunEdit: { isEditing: options.editingQueuedMessage === true, saveEdit },
    readPendingEnvironmentChange: () => null,
    pendingApprovals: [],
    respondingRequestIds: [],
    activePendingProgress: options.pendingQuestion ? { questionIndex: 0 } : null,
    onAdvanceActivePendingUserInput: answer,
    sideChatDisabledReason: null,
    beginLocalDispatch: noop,
    beginWorktreeSetup: noop,
    anchorNewTurn: noop,
    optimisticBlobPreviews: { track: noop, release: noop },
    setOptimisticUserMessages: noop,
    setThreadError: noop,
    setKeepFullHistory: noop,
    clearUsageLimitsFor: noop,
    acknowledgeActiveThreadWoke: noop,
    setSetupQueueSendThreadKey: noop,
  } as unknown as Input;
  const api: RefObject<Api | null> = { current: null };
  const screen = await render(
    <AppAtomRegistryProvider>
      <Harness input={input} api={api} />
    </AppAtomRegistryProvider>,
  );
  const draftPrompt = () => useComposerDraftStore.getState().getComposerDraft(DRAFT_TARGET)?.prompt;
  return {
    screen,
    send: () => api.current!.onSend(),
    refuse: (reason: string) => api.current!.refuseFolderMove(reason),
    saveEdit,
    answer,
    promptRef,
    draftPrompt,
  };
}

it.each([
  { reason: "Save or cancel the queued message edit first.", editingQueuedMessage: true },
  { reason: "Answer the pending question or approval first.", pendingQuestion: true },
  { reason: "Update this environment's T3 Code server to move threads.", folderMove: false },
])("a typed /cd refused with $reason reaches no other send path", async (scenario) => {
  const { screen, send, saveEdit, answer, promptRef, draftPrompt } = await setup(scenario);
  await using _screen = screen;
  using toast = vi.spyOn(toastManager, "add");

  await act(send);

  const untouched = [saveEdit, answer, mocks.startTurn, mocks.move];
  for (const spy of untouched) expect(spy).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Thread not moved", description: scenario.reason }),
  );
  expect([promptRef.current, draftPrompt()]).toEqual(["/cd ..", "/cd .."]);

  promptRef.current = "hello";
  await act(send);
  expect(mocks.startTurn).toHaveBeenCalledTimes(scenario.folderMove === false ? 1 : 0);
});

it("ignores a second /cd until the first move has reported and cleared the draft", async () => {
  const { screen, send, promptRef } = await setup({});
  await using _screen = screen;
  let finish!: (result: unknown) => void;
  mocks.move.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  mocks.move.mockResolvedValue(AsyncResult.success({ _tag: "refused", reason: "Busy." }));
  using _toast = vi.spyOn(toastManager, "add").mockImplementationOnce(() => {
    void send();
    return "";
  });

  const first = send();
  await act(send);
  expect(mocks.move).toHaveBeenCalledTimes(1);

  finish(AsyncResult.success({ _tag: "moved", folder: "/repo", members: [] }));
  await act(() => first);
  expect(mocks.move).toHaveBeenCalledTimes(1);
  expect(promptRef.current).toBe("");

  promptRef.current = "/cd ..";
  await act(send);
  expect(mocks.move).toHaveBeenCalledTimes(2);
});

it("keeps one move toast on its thread and closes it when the next attempt starts", async () => {
  const { screen, send } = await setup({});
  await using _screen = screen;
  mocks.move.mockResolvedValue(AsyncResult.success({ _tag: "refused", reason: "Busy." }));
  using add = vi.spyOn(toastManager, "add").mockReturnValueOnce("first").mockReturnValue("second");
  using close = vi.spyOn(toastManager, "close");

  await act(send);
  expect(add).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Thread not moved",
      description: "Busy.",
      data: expect.objectContaining({ threadRef: DRAFT_TARGET }),
    }),
  );
  expect(close).not.toHaveBeenCalled();

  mocks.move.mockResolvedValue(
    AsyncResult.success({ _tag: "moved", folder: "/repo", members: [] }),
  );
  await act(send);
  expect(close).toHaveBeenCalledWith("first");
  // A move to the thread's own folder is no refusal, so the toast stays informational.
  const sameFolder = add.mock.lastCall?.[0];
  expect(sameFolder).toMatchObject({ type: "info", title: "Thread not moved" });
  // router: false because the toast description reads no route.
  await using description = await render(<p>{sameFolder?.description}</p>, { router: false });
  expect(description.container.textContent).toBe("Already in /repo.");
  expect(description.container.querySelector("code")?.textContent).toBe("/repo");
});

it("refuses a blocked menu row with the toast a typed /cd gets, and keeps the draft", async () => {
  const { screen, send, refuse, promptRef, draftPrompt } = await setup({});
  await using _screen = screen;
  mocks.move.mockResolvedValue(AsyncResult.success({ _tag: "refused", reason: "Busy." }));
  using add = vi.spyOn(toastManager, "add").mockReturnValueOnce("typed").mockReturnValue("row");
  using close = vi.spyOn(toastManager, "close");

  await act(send);
  await act(() => refuse("This thread is already in No project."));

  // The row's refusal replaces the typed one, on the same thread, and sends nothing.
  expect(close).toHaveBeenCalledWith("typed");
  expect(add).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "warning",
      title: "Thread not moved",
      description: "This thread is already in No project.",
      data: expect.objectContaining({ threadRef: DRAFT_TARGET }),
    }),
  );
  expect(mocks.move).toHaveBeenCalledTimes(1);
  expect(mocks.startTurn).not.toHaveBeenCalled();
  expect([promptRef.current, draftPrompt()]).toEqual(["/cd ..", "/cd .."]);
});
