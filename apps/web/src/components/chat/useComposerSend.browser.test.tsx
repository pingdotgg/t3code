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

type Options = Partial<
  Record<"folderMove" | "editingQueuedMessage" | "pendingQuestion", boolean>
> & {
  /** What the composer holds besides the text. */
  readonly context?: "image" | "reply" | undefined;
  readonly prompt?: string | undefined;
};

async function setup(options: Options) {
  mocks.move.mockReset();
  mocks.startTurn.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const capabilities = { threadWorkingFolderMove: options.folderMove !== false };
  appAtomRegistry.set(mocks.serverConfigs, new Map([[ENV, { environment: { capabilities } }]]));
  const saveEdit = vi.fn();
  const answer = vi.fn();
  const promptRef = { current: options.prompt ?? "/cd .." };
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(DRAFT_TARGET, promptRef.current);
  // The send reads only whether a reply target is set.
  drafts.setReplyTo(DRAFT_TARGET, options.context === "reply" ? ({} as never) : null);
  const sendContext = {
    images: options.context === "image" ? [{ id: "image-1" }] : [],
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
    refreshBeforeSend: () => null,
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

const TEXT_ONLY = "Remove the attachments and context, then send it again.";

it.each([
  {
    when: "a queued message edit is open",
    reason: "Save or cancel the queued message edit first.",
    editingQueuedMessage: true,
  },
  {
    when: "a question is pending",
    reason: "Answer the pending question or approval first.",
    pendingQuestion: true,
  },
  {
    when: "the server cannot move threads",
    reason: "Update this environment's T3 Code server to move threads.",
    folderMove: false,
  },
  { when: "an image is attached", reason: TEXT_ONLY, context: "image" as const },
  { when: "a reply target is set", reason: TEXT_ONLY, context: "reply" as const, prompt: "/no" },
])("a typed move refused while $when reaches no other send path", async (scenario) => {
  const { screen, send, saveEdit, answer, promptRef, draftPrompt } = await setup(scenario);
  await using _screen = screen;
  using toast = vi.spyOn(toastManager, "add");
  const typed = promptRef.current;

  await act(send);

  const untouched = [saveEdit, answer, mocks.startTurn, mocks.move];
  for (const spy of untouched) expect(spy).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Thread not moved", description: scenario.reason }),
  );
  expect([promptRef.current, draftPrompt()]).toEqual([typed, typed]);
  // With an attachment or a reply target, other text takes the ordinary send path.
  if (scenario.context !== undefined) return;

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

it("keeps one move toast on its thread, for a typed command and for a blocked menu row", async () => {
  const { screen, send, refuse, promptRef, draftPrompt } = await setup({});
  await using _screen = screen;
  mocks.move.mockResolvedValue(AsyncResult.success({ _tag: "refused", reason: "Busy." }));
  using add = vi
    .spyOn(toastManager, "add")
    .mockReturnValueOnce("typed")
    .mockReturnValueOnce("row")
    .mockReturnValue("same-folder");
  using close = vi.spyOn(toastManager, "close");
  const refusal = (description: string) =>
    expect.objectContaining({
      type: "warning",
      title: "Thread not moved",
      description,
      data: expect.objectContaining({ threadRef: DRAFT_TARGET }),
    });

  await act(send);
  expect(add).toHaveBeenLastCalledWith(refusal("Busy."));
  expect(close).not.toHaveBeenCalled();

  // A blocked menu row replaces the typed refusal with its own, sends nothing, and keeps the draft.
  await act(() => refuse("This thread is already in No project."));
  expect(close).toHaveBeenLastCalledWith("typed");
  expect(add).toHaveBeenLastCalledWith(refusal("This thread is already in No project."));
  expect(mocks.move).toHaveBeenCalledTimes(1);
  expect(mocks.startTurn).not.toHaveBeenCalled();
  expect([promptRef.current, draftPrompt()]).toEqual(["/cd ..", "/cd .."]);

  // The next attempt closes it. A move to the thread's own folder is no refusal.
  mocks.move.mockResolvedValue(
    AsyncResult.success({ _tag: "moved", folder: "/repo", members: [] }),
  );
  await act(send);
  expect(close).toHaveBeenLastCalledWith("row");
  expect(add.mock.lastCall?.[0]).toMatchObject({ type: "info", title: "Thread not moved" });
});
