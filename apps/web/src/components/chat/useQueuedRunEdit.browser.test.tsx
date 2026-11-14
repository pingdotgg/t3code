import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ChatAttachmentId,
  MessageId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useImperativeHandle, type RefObject } from "react";
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
import { readAttachmentUpload, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";

interface RunStatus {
  readonly id: RunId;
  readonly status: string;
}

const mocks = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editQueuedRun: vi.fn<(value: unknown) => Promise<{ readonly _tag: "Success" | "Failure" }>>(),
    // The projection's runs per thread, written by each test to stand in for the server.
    threadRuns: Atom.family((_key: string) =>
      Atom.make<ReadonlyArray<RunStatus> | null>(null).pipe(Atom.keepAlive),
    ),
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.editQueuedRun,
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

function projection(runs: ReadonlyArray<RunStatus>, messages: ReadonlyArray<unknown>) {
  return { runs, messages } as unknown as ThreadStructure;
}

function setRuns(ref: ScopedThreadRef, status: string) {
  appAtomRegistry.set(mocks.threadRuns(runsKey(ref)), [{ id: RUN, status }]);
}

function Harness(props: {
  readonly threadRef: ScopedThreadRef;
  readonly runStatus: string;
  readonly hookRef: RefObject<HookResult | null>;
  readonly messages: ReadonlyArray<unknown>;
}) {
  const result = useQueuedRunEdit({
    environmentId: ENV,
    routeThreadRef: props.threadRef,
    threadDraftTarget: props.threadRef,
    activeThreadId: props.threadRef.threadId,
    serverProjection: projection([{ id: RUN, status: props.runStatus }], props.messages),
    promptRef: { current: "" },
    composerRef: { current: null },
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
) {
  return (
    <AppAtomRegistryProvider>
      <Harness threadRef={threadRef} runStatus={runStatus} hookRef={hook} messages={messages} />
    </AppAtomRegistryProvider>
  );
}

function setup() {
  mocks.editQueuedRun.mockReset();
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

  it("saves only the thread mentions still in the edited message", async () => {
    const { hook } = setup();
    mocks.editQueuedRun.mockResolvedValue({ _tag: "Success" });
    const kept = threadContextRecord(THREAD_B, "Kept");
    const removed = threadContextRecord(THREAD_A, "Removed");
    const messageId = MessageId.make("message-1");
    const text = [kept, removed]
      .map((record) => formatInlineContextReference(threadContextReference(record)))
      .join(" and ");
    const messages = [{ id: messageId, text, context: { version: 1, records: [kept, removed] } }];
    await using _screen = await render(view(THREAD_A, "queued", hook, messages));
    await act(() => requireHook(hook).beginEdit({ runId: RUN, messageId, text, attachments: [] }));
    const target = requireHook(hook).draftTarget;
    await act(() => useComposerDraftStore.getState().setThreadContexts(target, [kept]));

    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    await requireHook(hook).saveEdit(
      { ...savedContent(draft?.prompt ?? ""), threadContexts: draft?.threadContexts ?? [] },
      () => {},
    );

    expect(mocks.editQueuedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          edit: expect.objectContaining({ context: { version: 1, records: [kept] } }),
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
