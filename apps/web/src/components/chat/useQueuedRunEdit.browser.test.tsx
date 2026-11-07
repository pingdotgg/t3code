import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ChatAttachmentId,
  MessageId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
  type ChatAttachment,
} from "@t3tools/contracts";
import { useImperativeHandle, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { toastManager } from "../ui/toast";

import { act, render } from "../../../test/render";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { deriveComposerSendState } from "../ChatView.logic";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useQueuedRunEdit } from "./useQueuedRunEdit";

interface RunStatus {
  readonly id: RunId;
  readonly status: string;
}

const mocks = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    acquireEdit: vi.fn(async () => ({ _tag: "Success", value: { editId: null, sequence: 0 } })),
    releaseEdit: vi.fn(async () => ({ _tag: "Success" })),
    setThreadError: vi.fn(),
    editQueuedRun: vi.fn<(value: unknown) => Promise<{ readonly _tag: "Success" | "Failure" }>>(),
    // The projection's runs per thread, written by each test to stand in for the server.
    threadRuns: Atom.family((_key: string) =>
      Atom.make<ReadonlyArray<RunStatus> | null>(null).pipe(Atom.keepAlive),
    ),
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "begin"
      ? mocks.acquireEdit
      : command === "cancel"
        ? mocks.releaseEdit
        : mocks.editQueuedRun,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));

vi.mock("./composerAttachmentFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./composerAttachmentFiles")>()),
  fileAttachmentCapabilityBlockReason: () => null,
}));

vi.mock("../../lib/attachmentUploadQueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/attachmentUploadQueue")>()),
  startAttachmentUpload: () => {},
  awaitAttachmentUploads: async () => {},
  getUploadedAttachments: ({ images }: { images: ReadonlyArray<ChatAttachment> }) =>
    images.map(({ type, id, name, mimeType, sizeBytes }) => ({
      type,
      id,
      name,
      mimeType,
      sizeBytes,
    })),
}));

const runsKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const { useAtomValue } = await import("@effect/atom-react");
  const Option = await import("effect/Option");
  const key = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;
  return {
    useEnvironmentThread: (environmentId: string, threadId: string) => {
      const runs = useAtomValue(mocks.threadRuns(`${environmentId}:${threadId}`));
      return {
        status: "live",
        sequence: 0,
        data: runs === null ? Option.none() : Option.some({ runs }),
      };
    },
    threadEnvironment: {
      snapshotAtom: () => Atom.make(null),
      editQueuedRun: {},
      beginQueuedRunEdit: "begin",
      cancelQueuedRunEdit: "cancel",
    },
    environmentThreadDetails: {
      statusAtom: () => Atom.make("ready"),
      quietThreadAtom: (ref: ScopedThreadRef) =>
        Atom.make((get) => {
          const runs = get(mocks.threadRuns(key(ref)));
          return runs === null ? null : { projection: { runs } };
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

function projection(runs: ReadonlyArray<RunStatus>) {
  return { runs, messages: [] } as unknown as ThreadStructure;
}

function setRuns(ref: ScopedThreadRef, status: string) {
  appAtomRegistry.set(mocks.threadRuns(runsKey(ref)), [{ id: RUN, status }]);
}

function Harness(props: {
  readonly threadRef: ScopedThreadRef;
  readonly runStatus: string;
  readonly hookRef: RefObject<HookResult | null>;
}) {
  const result = useQueuedRunEdit({
    environmentId: ENV,
    routeThreadRef: props.threadRef,
    threadDraftTarget: props.threadRef,
    activeThreadId: props.threadRef.threadId,
    serverProjection: projection([{ id: RUN, status: props.runStatus }]),
    promptRef: { current: "" },
    composerRef: { current: null },
  });
  useImperativeHandle(props.hookRef, () => result);
  const draft = useComposerThreadDraft(result.draftTarget);
  const sendState = deriveComposerSendState({
    prompt: draft.prompt,
    imageCount: draft.images.length + draft.files.length,
    terminalContexts: draft.terminalContexts,
  });
  return result.isEditing ? (
    <ComposerPrimaryActions
      compact={false}
      canOperateThread
      pendingAction={null}
      isRunning={false}
      canInterrupt={false}
      showPlanFollowUpPrompt={false}
      promptHasText={draft.prompt.trim().length > 0}
      isSendBusy={result.isSaving}
      sendDisabledReason={null}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent={sendState.hasSendableContent}
      isEditingQueuedMessage
      onSubmitMessage={() =>
        void result.saveEdit(
          { ...savedContent(draft.prompt), images: draft.images, files: draft.files },
          mocks.setThreadError,
        )
      }
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
      onImplementPlanInNewThread={() => {}}
    />
  ) : null;
}

function view(threadRef: ScopedThreadRef, runStatus: string, hook: { current: HookResult | null }) {
  return (
    <AppAtomRegistryProvider>
      <Harness threadRef={threadRef} runStatus={runStatus} hookRef={hook} />
    </AppAtomRegistryProvider>
  );
}

function setup() {
  mocks.editQueuedRun.mockReset();
  mocks.setThreadError.mockReset();
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
  it.each(["", "Ultrathink:\n"])(
    "opens attachment-only edits without the placeholder and preserves effort on save (%j)",
    async (prefix) => {
      const { hook } = setup();
      mocks.editQueuedRun.mockResolvedValue({ _tag: "Success" });
      await using screen = await render(view(THREAD_A, "queued", hook));
      using toast = vi.spyOn(toastManager, "add");
      const attachments = [
        {
          type: "file" as const,
          id: ChatAttachmentId.make("kept"),
          name: "kept.pdf",
          mimeType: "application/pdf",
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
      expect(
        useComposerDraftStore.getState().getComposerDraft(requireHook(hook).draftTarget)?.files,
      ).toEqual([expect.objectContaining(attachments[0])]);
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
      await vi.waitFor(() =>
        expect(mocks.setThreadError).toHaveBeenCalledWith(THREAD_A.threadId, null),
      );
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
            type: "file",
            id: ChatAttachmentId.make("removed"),
            name: "removed.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
          },
        ],
      }),
    );
    await act(() =>
      useComposerDraftStore.getState().removeFile(requireHook(hook).draftTarget, "removed"),
    );
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
