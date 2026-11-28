import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ChatAttachmentId,
  ComposerContextId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useImperativeHandle, useLayoutEffect, useRef, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { toastManager } from "../ui/toast";

import { act, render } from "../../../test/render";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "../../lib/terminalContext";
import {
  environmentContextRecord,
  environmentContextReference,
  threadContextReference,
} from "../../lib/composerContextRecords";
import { deriveComposerSendState } from "../ChatView.logic";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useQueuedRunEdit } from "./useQueuedRunEdit";
import type { ChatComposerHandle } from "./ChatComposer";
import { readAttachmentUpload, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";

interface RunStatus {
  readonly id: RunId;
  readonly status: string;
  readonly modelSelection?: { readonly instanceId: ProviderInstanceId; readonly model: string };
  readonly activeAttemptId?: string;
}

const mocks = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editQueuedRun: vi.fn<(value: unknown) => Promise<{ readonly _tag: "Success" | "Failure" }>>(),
    promoteQueuedRun: vi.fn<(value: unknown) => Promise<{ readonly _tag: "Success" }>>(),
    promoteCommand: {},
    // The projection's runs per thread, written by each test to stand in for the server.
    threadRuns: Atom.family((_key: string) =>
      Atom.make<ReadonlyArray<RunStatus> | null>(null).pipe(Atom.keepAlive),
    ),
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.promoteCommand ? mocks.promoteQueuedRun : mocks.editQueuedRun,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));

const runsKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const key = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;
  return {
    threadEnvironment: {
      snapshotAtom: () => Atom.make(null),
      editQueuedRun: {},
      promoteQueuedRun: mocks.promoteCommand,
    },
    environmentThreadDetails: {
      statusAtom: () => Atom.make("ready"),
      quietThreadAtom: (ref: ScopedThreadRef) =>
        Atom.make((get) => {
          const runs = get(mocks.threadRuns(key(ref)));
          if (runs === null) return null;
          // A Claude-like session whose running turn takes steering.
          return {
            projection: {
              thread: { id: ref.threadId, activeProviderThreadId: null },
              runs,
              messages: [],
              providerThreads: [],
              providerSessions: [
                {
                  id: "session",
                  status: "running",
                  capabilities: { turns: { supportsActiveSteering: true } },
                },
              ],
              providerTurns: runs.flatMap((run) =>
                run.activeAttemptId
                  ? [{ runAttemptId: run.activeAttemptId, status: "running" }]
                  : [],
              ),
            },
          };
        }),
    },
    environmentThreadShells: {
      threadShellAtom: () => Atom.make(null),
    },
  };
});

const ENV = EnvironmentId.make("env-1");
const THREAD_A: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("thread-a") };
const THREAD_B: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("thread-b") };
const RUN = RunId.make("run-1");

type HookResult = ReturnType<typeof useQueuedRunEdit>;

function projection(runs: ReadonlyArray<RunStatus>, messages: ReadonlyArray<unknown>) {
  return {
    runs,
    messages,
    thread: {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "current-model" },
    },
  } as unknown as ThreadStructure;
}

function setRuns(ref: ScopedThreadRef, status: string) {
  appAtomRegistry.set(mocks.threadRuns(runsKey(ref)), [{ id: RUN, status }]);
}

interface ComposerRefs {
  readonly promptRef: RefObject<string>;
  readonly composerRef: Parameters<typeof useQueuedRunEdit>[0]["composerRef"];
}

function Harness(props: {
  readonly threadRef: ScopedThreadRef;
  readonly runStatus: string;
  readonly hookRef: RefObject<HookResult | null>;
  readonly messages: ReadonlyArray<unknown>;
  readonly composer?: ComposerRefs | undefined;
}) {
  const threadKey = scopedThreadKey(props.threadRef);
  const currentRouteThreadKeyRef = useRef<string | null>(threadKey);
  useLayoutEffect(() => {
    currentRouteThreadKeyRef.current = threadKey;
    return () => {
      currentRouteThreadKeyRef.current = null;
    };
  }, [threadKey]);
  const result = useQueuedRunEdit({
    environmentId: ENV,
    routeThreadRef: props.threadRef,
    currentRouteThreadKeyRef,
    threadDraftTarget: props.threadRef,
    activeThreadId: props.threadRef.threadId,
    serverProjection: projection(
      [{ id: RUN, status: props.runStatus, modelSelection: savedContent("").modelSelection }],
      props.messages,
    ),
    promptRef: props.composer?.promptRef ?? { current: "" },
    composerRef: props.composer?.composerRef ?? { current: null },
  });
  useImperativeHandle(props.hookRef, () => result);
  const draft = useComposerThreadDraft(result.draftTarget);
  const sendState = deriveComposerSendState({
    prompt: draft.prompt,
    imageCount: draft.images.length + draft.files.length,
    existingAttachmentCount: result.editingAttachments?.length ?? 0,
    terminalContexts: draft.terminalContexts,
  });
  return result.isEditing ? (
    <ComposerPrimaryActions
      compact={false}
      canOperateThread
      pendingAction={null}
      isRunning={false}
      canInterrupt={false}
      isSendBusy={result.isSaving}
      sendDisabledReason={null}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent={sendState.hasSendableContent}
      isEditingQueuedMessage
      onSubmitMessage={() => void result.saveEdit(savedContent(draft.prompt), () => {})}
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
    />
  ) : null;
}

function view(
  threadRef: ScopedThreadRef,
  runStatus: string,
  hook: { current: HookResult | null },
  messages: ReadonlyArray<unknown> = [],
  composer?: ComposerRefs,
) {
  return (
    <AppAtomRegistryProvider>
      <Harness
        threadRef={threadRef}
        runStatus={runStatus}
        hookRef={hook}
        messages={messages}
        composer={composer}
      />
    </AppAtomRegistryProvider>
  );
}

function setup() {
  mocks.editQueuedRun.mockReset();
  mocks.promoteQueuedRun.mockReset();
  useAttachmentUploadStore.setState({ uploadsByImageId: {} });
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  setRuns(THREAD_A, "queued");
  setRuns(THREAD_B, "queued");
  return { hook: { current: null as HookResult | null } };
}

function requireHook(hook: { current: HookResult | null }): HookResult {
  if (hook.current === null) throw new Error("hook did not render");
  return hook.current;
}

async function beginChangedEdit(hook: { current: HookResult | null }) {
  await act(() =>
    requireHook(hook).beginEdit({
      runId: RUN,
      messageId: MessageId.make("message-1"),
      text: "original",
      attachments: [],
    }),
  );
  await act(() =>
    useComposerDraftStore.getState().setPrompt(requireHook(hook).draftTarget, "changed"),
  );
}

const savedContent = (prompt: string) => ({
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  prompt,
  images: [],
  files: [],
  terminalContexts: [],
  reviewComments: [],
  previewAnnotations: [],
  threadContexts: [],
  environmentContexts: [],
});

const promptOf = (ref: ScopedThreadRef) =>
  useComposerDraftStore.getState().getComposerDraft(ref)?.prompt ?? "";

describe("useQueuedRunEdit", () => {
  it.each([
    { navigation: "switches before the reply", resets: false, focuses: false },
    { navigation: "switches before the frame", resets: true, focuses: false },
    { navigation: "stays on thread", resets: true, focuses: true },
  ])("finishes a successful queued edit when the user $navigation", async (scenario) => {
    const { hook } = setup();
    const requested = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<{ readonly _tag: "Success" }>();
    mocks.editQueuedRun.mockImplementation(() => {
      requested.resolve();
      return reply.promise;
    });
    const focusAtEnd = vi.fn();
    const resetCursorState = vi.fn();
    const composer: ComposerRefs = {
      promptRef: { current: "changed" },
      composerRef: { current: null },
    };
    await using screen = await render(view(THREAD_A, "queued", hook, [], composer));
    const frames: FrameRequestCallback[] = [];
    using _frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return 0;
    });
    await beginChangedEdit(hook);
    await act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    composer.composerRef.current = {
      focusAtEnd,
      resetCursorState,
    } as unknown as ChatComposerHandle;

    const setThreadError = vi.fn();
    const saved = requireHook(hook).saveEdit(savedContent("changed"), setThreadError);
    await requested.promise;
    const openOtherThread = async () => {
      await screen.rerender(view(THREAD_B, "queued", hook, [], composer));
      composer.promptRef.current = "other thread draft";
    };
    if (scenario.navigation === "switches before the reply") await openOtherThread();
    reply.resolve({ _tag: "Success" });
    await act(() => saved);
    expect(setThreadError).toHaveBeenCalledExactlyOnceWith(THREAD_A.threadId, null);
    expect(resetCursorState).toHaveBeenCalledTimes(Number(scenario.resets));

    if (scenario.navigation === "switches before the frame") await openOtherThread();
    await act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(focusAtEnd).toHaveBeenCalledTimes(Number(scenario.focuses));
    expect(composer.promptRef.current).toBe(
      scenario.navigation === "stays on thread" ? "" : "other thread draft",
    );
  });

  it.each(["", "Ultrathink:\n"])(
    "opens attachment-only edits without the placeholder and preserves effort on save (%j)",
    async (prefix) => {
      const { hook } = setup();
      mocks.editQueuedRun.mockResolvedValue({ _tag: "Success" });
      await using screen = await render(view(THREAD_A, "queued", hook));
      using toast = vi.spyOn(toastManager, "add");
      const attachments = [
        {
          type: "image" as const,
          id: ChatAttachmentId.make("kept"),
          name: "kept.png",
          mimeType: "image/png",
          sizeBytes: 10,
        },
      ];
      const request = {
        runId: RUN,
        messageId: MessageId.make("message-1"),
        text: prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        attachments,
      };
      await act(() => requireHook(hook).beginEdit(request));
      expect(
        useComposerDraftStore.getState().getComposerDraft(requireHook(hook).draftTarget)?.prompt ??
          "",
      ).toBe(prefix.trimEnd());
      expect(requireHook(hook).editingAttachments?.map(({ attachment }) => attachment)).toEqual(
        attachments,
      );
      await act(() =>
        useComposerDraftStore
          .getState()
          .setRuntimeMode(requireHook(hook).draftTarget, "full-access"),
      );
      await act(() => setRuns(THREAD_A, "running"));
      expect(toast).not.toHaveBeenCalled();
      expect(requireHook(hook).isEditing).toBe(false);
      await act(() => setRuns(THREAD_A, "queued"));
      await act(() => requireHook(hook).beginEdit(request));
      const update = screen.getByRole("button", { name: "Update queued message" });
      await expect.element(update).toBeEnabled();
      await update.click();
      await vi.waitFor(() => expect(mocks.editQueuedRun).toHaveBeenCalledOnce());
      expect(mocks.editQueuedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            text: prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
            edit: expect.objectContaining({ attachments }),
          }),
        }),
      );
    },
  );

  it.each([
    // Cmd+Enter or Cmd-click with Queue as the default: save, then steer.
    { dispatchMode: "steer", submissionIntent: "alternate", steers: true },
    // Enter or the Update button with Steer as the default: save in place only.
    { dispatchMode: "steer", submissionIntent: "foreground", steers: false },
    // Cmd+Enter with Steer as the default queues, so the message stays queued.
    { dispatchMode: "queue", submissionIntent: "alternate", steers: false },
  ] as const)(
    "a saved edit sent as $submissionIntent/$dispatchMode steers: $steers",
    async (submission) => {
      const { hook } = setup();
      mocks.editQueuedRun.mockResolvedValue({ _tag: "Success" });
      mocks.promoteQueuedRun.mockResolvedValue({ _tag: "Success" });
      const activeRun = RunId.make("run-active");
      appAtomRegistry.set(mocks.threadRuns(runsKey(THREAD_A)), [
        { id: activeRun, status: "running", activeAttemptId: "attempt-1" },
        { id: RUN, status: "queued" },
      ]);
      await using _screen = await render(view(THREAD_A, "queued", hook));
      await beginChangedEdit(hook);
      await act(() => requireHook(hook).saveEdit(savedContent("changed"), () => {}, submission));
      expect(mocks.editQueuedRun).toHaveBeenCalledOnce();
      if (!submission.steers) {
        expect(mocks.promoteQueuedRun).not.toHaveBeenCalled();
        return;
      }
      expect(mocks.promoteQueuedRun).toHaveBeenCalledExactlyOnceWith({
        environmentId: ENV,
        input: { threadId: THREAD_A.threadId, queuedRunId: RUN, targetRunId: activeRun },
      });
      expect(mocks.editQueuedRun.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.promoteQueuedRun.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("saves an effort-only prompt without claiming removed attachments remain", async () => {
    const { hook } = setup();
    mocks.editQueuedRun.mockResolvedValue({ _tag: "Success" });
    await using screen = await render(view(THREAD_A, "queued", hook));
    await act(() =>
      requireHook(hook).beginEdit({
        runId: RUN,
        messageId: MessageId.make("message-1"),
        text: `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
        attachments: [
          {
            type: "image",
            id: ChatAttachmentId.make("removed"),
            name: "removed.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ],
      }),
    );
    await act(() => requireHook(hook).removeEditingAttachment("removed"));
    await screen.getByRole("button", { name: "Update queued message" }).click();
    await vi.waitFor(() => expect(mocks.editQueuedRun).toHaveBeenCalledOnce());
    expect(mocks.editQueuedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          text: "Ultrathink:",
          edit: expect.objectContaining({ attachments: [] }),
        }),
      }),
    );
  });

  it("opens an edit with only the thread and machine records its text still mentions", async () => {
    const { hook } = setup();
    const thread = threadContextRecord(THREAD_B, "Support Any File Uploads");
    const machine = environmentContextRecord(ENV, "Build box");
    const unreferenced = threadContextRecord(THREAD_A, "Removed earlier");
    const messageId = MessageId.make("message-1");
    const text = `wait for ${formatInlineContextReference(threadContextReference(thread))} on ${formatInlineContextReference(environmentContextReference(machine))}`;
    const messages = [
      { id: messageId, text, context: { version: 1, records: [thread, machine, unreferenced] } },
    ];
    await using _screen = await render(view(THREAD_A, "queued", hook, messages));

    await act(() => requireHook(hook).beginEdit({ runId: RUN, messageId, text, attachments: [] }));

    const draft = useComposerDraftStore.getState().getComposerDraft(requireHook(hook).draftTarget);
    expect(draft?.prompt).toBe(text);
    expect(draft?.threadContexts).toEqual([thread]);
    expect(draft?.environmentContexts).toEqual([machine]);
  });

  it("saves only the thread mentions and attachments still in the edited message", async () => {
    const { hook } = setup();
    mocks.editQueuedRun.mockResolvedValue({ _tag: "Success" });
    const kept = threadContextRecord(THREAD_B, "Kept");
    const removed = threadContextRecord(THREAD_A, "Removed");
    const removedImageId = ChatAttachmentId.make("server-image-removed");
    const keptFileId = ChatAttachmentId.make("server-file-kept");
    const removedImageContextId = ComposerContextId.make("image_local-removed");
    const keptFileContextId = ComposerContextId.make("file_local-kept");
    const removedImage = {
      type: "image" as const,
      id: removedImageId,
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 67,
    };
    const keptFile = {
      type: "file" as const,
      id: keptFileId,
      name: "legacy.pdf",
      mimeType: "application/pdf",
      sizeBytes: 40,
    };
    const removedImageRecord = {
      version: 1 as const,
      kind: "image" as const,
      contextId: removedImageContextId,
      label: "image.png",
      attachmentId: removedImageId,
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 67,
    };
    const keptFileRecord = {
      version: 1 as const,
      kind: "file" as const,
      contextId: keptFileContextId,
      label: "legacy.pdf",
      attachmentId: keptFileId,
      name: "legacy.pdf",
      mimeType: "application/pdf",
      sizeBytes: 40,
    };
    const messageId = MessageId.make("message-1");
    const text = [
      formatInlineContextReference(threadContextReference(kept)),
      formatInlineContextReference(threadContextReference(removed)),
      formatInlineContextReference({
        kind: "image",
        contextId: removedImageContextId,
        label: "image.png",
      }),
    ].join(" and ");
    const messages = [
      {
        id: messageId,
        text,
        context: { version: 1, records: [kept, removed, removedImageRecord, keptFileRecord] },
      },
    ];
    await using _screen = await render(view(THREAD_A, "queued", hook, messages));
    await act(() =>
      requireHook(hook).beginEdit({
        runId: RUN,
        messageId,
        text,
        attachments: [removedImage, keptFile],
      }),
    );
    const target = requireHook(hook).draftTarget;
    await act(() => {
      useComposerDraftStore.getState().setThreadContexts(target, [kept]);
      requireHook(hook).removeEditingAttachment(removedImageId);
    });

    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    expect(draft?.prompt).not.toContain(removedImageContextId);
    await requireHook(hook).saveEdit(
      { ...savedContent(draft?.prompt ?? ""), threadContexts: draft?.threadContexts ?? [] },
      () => {},
    );

    expect(mocks.editQueuedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          text: draft?.prompt,
          edit: expect.objectContaining({
            attachments: [keptFile],
            context: { version: 1, records: [keptFileRecord, kept] },
          }),
        }),
      }),
    );
  });

  it("adds terminal context to the queued message being edited", async () => {
    const { hook } = setup();
    await using _screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);
    const target = requireHook(hook).draftTarget;
    const inserted = useComposerDraftStore.getState().insertTerminalContext(
      target,
      `changed${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}`,
      {
        id: "terminal-context-1",
        threadId: THREAD_A.threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 3,
        lineEnd: 3,
        text: "hello",
      },
      0,
    );
    expect(inserted).toBe(true);
    expect(
      useComposerDraftStore.getState().getComposerDraft(target)?.terminalContexts,
    ).toHaveLength(1);
  });

  it("keeps an open edit when the user leaves the thread and comes back", async () => {
    const { hook } = setup();
    await using screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);

    await screen.rerender(view(THREAD_B, "queued", hook));
    expect(requireHook(hook).isEditing).toBe(false);
    await screen.rerender(view(THREAD_A, "queued", hook));

    expect(requireHook(hook).editingRunId).toBe(RUN);
    expect(
      useComposerDraftStore.getState().getComposerDraft(requireHook(hook).draftTarget)?.prompt,
    ).toBe("changed");
  });

  it("moves a changed edit into the thread draft when its run starts while the user is away", async () => {
    const { hook } = setup();
    await using screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);

    await screen.rerender(view(THREAD_B, "queued", hook));
    expect(promptOf(THREAD_A)).toBe("");
    await act(() => setRuns(THREAD_A, "running"));

    expect(promptOf(THREAD_A)).toBe("changed");
  });

  it("does not copy a saved edit into the thread draft when the run starts mid-save", async () => {
    const { hook } = setup();
    let finishSave: (result: { readonly _tag: "Success" }) => void = () => {};
    mocks.editQueuedRun.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    await using screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);

    // Not inside act(): act would hold the projection update until the save settles.
    const saved = requireHook(hook).saveEdit(savedContent("changed"), () => {});
    await vi.waitFor(() => expect(mocks.editQueuedRun).toHaveBeenCalledOnce());
    // The server applied the edit and then started the run; the projection
    // reports the start before the edit's acknowledgement arrives.
    await act(() => setRuns(THREAD_A, "running"));
    await screen.rerender(view(THREAD_A, "running", hook));
    finishSave({ _tag: "Success" });
    await act(() => saved);

    expect(requireHook(hook).isEditing).toBe(false);
    expect(promptOf(THREAD_A)).toBe("");
  });

  it.each([
    { transition: "cancel", result: "Success" },
    { transition: "recover", result: "Failure" },
    { transition: "replace", result: "Success" },
  ] as const)(
    "settles saved attachments after $transition and $result",
    async ({ transition, result }) => {
      const { hook } = setup();
      let finishSave!: (result: { readonly _tag: "Success" | "Failure" }) => void;
      let started!: () => void;
      const saving = new Promise<{ readonly _tag: "Success" | "Failure" }>((resolve) => {
        finishSave = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      mocks.editQueuedRun.mockImplementation(() => {
        started();
        return saving;
      });
      await using _screen = await render(view(THREAD_A, "queued", hook));
      await beginChangedEdit(hook);
      const image = {
        type: "image" as const,
        id: "saved-image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 5,
        file: new File(["image"], "image.png", { type: "image/png" }),
        previewUrl: "blob:saved-image",
      };
      using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      await act(() =>
        useComposerDraftStore.getState().addImage(requireHook(hook).draftTarget, image),
      );
      useAttachmentUploadStore.setState({
        uploadsByImageId: {
          [image.id]: { status: "ready", environmentId: ENV, attachmentId: "saved-upload" },
        },
      });
      const target = requireHook(hook).draftTarget;
      const saved = requireHook(hook).saveEdit(
        { ...savedContent("changed"), images: [image] },
        () => {},
      );
      await act(() => requested);
      expect(requireHook(hook).isSaving).toBe(true);
      if (transition === "cancel") await act(() => requireHook(hook).cancelEdit());
      if (transition === "recover") await act(() => setRuns(THREAD_A, "running"));
      if (transition === "replace") {
        await beginChangedEdit(hook);
        await act(() =>
          useComposerDraftStore.getState().addImage(requireHook(hook).draftTarget, image),
        );
      }
      expect(readAttachmentUpload(image.id)).toBeDefined();
      expect(revoke).not.toHaveBeenCalled();
      finishSave({ _tag: result });
      await act(() => saved);
      if (transition === "cancel") {
        expect(readAttachmentUpload(image.id)).toBeUndefined();
        expect(revoke).toHaveBeenCalledWith(image.previewUrl);
        expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
      } else {
        expect(readAttachmentUpload(image.id)).toBeDefined();
        expect(revoke).not.toHaveBeenCalled();
        const owner = transition === "recover" ? THREAD_A : target;
        expect(useComposerDraftStore.getState().getComposerDraft(owner)?.images).toEqual([image]);
      }
    },
  );

  it("leaves a newer edit alone when a save from before navigation finishes", async () => {
    const { hook } = setup();
    let finishSave: (result: { readonly _tag: "Success" }) => void = () => {};
    mocks.editQueuedRun.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    await using screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);
    // Not inside act(): act would hold the rerenders until the save settles.
    const saved = requireHook(hook).saveEdit(savedContent("changed"), () => {});
    await vi.waitFor(() => expect(mocks.editQueuedRun).toHaveBeenCalledOnce());

    // Leaving the thread unmounts the chat view; coming back mounts a new one.
    await screen.rerender(<AppAtomRegistryProvider>{null}</AppAtomRegistryProvider>);
    await screen.rerender(view(THREAD_A, "queued", hook));
    expect(requireHook(hook).isSaving).toBe(true);
    await beginChangedEdit(hook);
    await act(() =>
      useComposerDraftStore.getState().setPrompt(requireHook(hook).draftTarget, "newer"),
    );

    finishSave({ _tag: "Success" });
    await act(() => saved);

    expect(requireHook(hook).editingRunId).toBe(RUN);
    expect(requireHook(hook).isSaving).toBe(false);
    expect(
      useComposerDraftStore.getState().getComposerDraft(requireHook(hook).draftTarget)?.prompt,
    ).toBe("newer");
  });
});

it.each([false, true])(
  "pins a following queued message only after a model pick: %s",
  async (pick) => {
    const { hook } = setup();
    mocks.editQueuedRun.mockResolvedValue({ _tag: "Success" });
    await using _screen = await render(
      view(THREAD_A, "queued", hook, [
        { id: MessageId.make("message-1"), followsThreadSelection: true },
      ]),
    );
    await beginChangedEdit(hook);
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "chosen-model" };
    const target = requireHook(hook).draftTarget;
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.activeProvider).toBeNull();
    if (pick)
      await act(() =>
        useComposerDraftStore.getState().setModelSelection(target, selection, { explicit: true }),
      );
    await requireHook(hook).saveEdit(
      { ...savedContent("changed"), modelSelection: selection },
      () => {},
    );
    expect(mocks.editQueuedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining(
          pick ? { modelSelection: selection } : { threadId: THREAD_A.threadId },
        ),
      }),
    );
    if (!pick)
      expect(mocks.editQueuedRun.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          input: expect.not.objectContaining({ modelSelection: expect.anything() }),
        }),
      );
  },
);
