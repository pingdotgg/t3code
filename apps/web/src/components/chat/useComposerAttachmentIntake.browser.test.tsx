import { createRef, useEffect, useLayoutEffect, useRef } from "react";
import {
  EnvironmentId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { makeThreadRequestsResolvedAnnouncer } from "@t3tools/client-runtime/state/thread-requests";
import { undoDepth } from "@tiptap/pm/history";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";

import { act, render } from "../../../test/render";
import {
  type ComposerImageAttachment,
  DraftId,
  composerTargetKey,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import { toRetainedComposerImage } from "../../composer-image-history";
import {
  completeConfirmDialogClose,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "../../confirmDialog";
import { releaseThreadUndoShortcut, showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { imageContextReference } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { questionAttachmentDraftId } from "../../questionAttachments";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { readComposerImageBytes } from "./composerAttachmentFiles";
import {
  getPreparingComposerImages,
  useSubmitAfterPreparingImages,
} from "./preparingComposerImages";
import { useComposerAttachmentIntake } from "./useComposerAttachmentIntake";

const compression = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../../lib/imageCompression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/imageCompression")>()),
  prepareImageForAttachment: compression.prepare,
}));
vi.mock("../../hooks/showThreadUndoNotice", () => ({
  showThreadUndoNotice: vi.fn(),
  releaseThreadUndoShortcut: vi.fn(),
}));

type IntakeInput = Parameters<typeof useComposerAttachmentIntake>[0];
type Intake = ReturnType<typeof useComposerAttachmentIntake>;

function Harness({ input, ready }: { input: IntakeInput; ready: (value: Intake) => void }) {
  const intake = useComposerAttachmentIntake(input);
  useEffect(() => ready(intake));
  return null;
}

function SendProbe(props: {
  target: string;
  ready: (holdSend: ReturnType<typeof useSubmitAfterPreparingImages>) => void;
}) {
  const holdSend = useSubmitAfterPreparingImages(props.target);
  useEffect(() => props.ready(holdSend));
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

// A clipboard image arrives as a new File named image.png on every paste.
const pastedImage = (fill = 0) =>
  new File([new Uint8Array(100).fill(fill)], "image.png", { type: "image/png" });
// Compression shrinks an image, so the draft's copy no longer matches the pasted bytes; images
// with different pixels compress to different sizes.
const compress = async (source: File) => {
  const [firstByte = 0] = new Uint8Array(await source.arrayBuffer());
  return {
    ok: true as const,
    file: new File([new Uint8Array(60 + firstByte)], "image.png", { type: "image/png" }),
    recompressed: true as const,
  };
};
const visiblePreparing = (targetKey: string) =>
  getPreparingComposerImages(targetKey).filter((image) => !image.hidden);

it.each(["available", "full", "duplicate"] as const)(
  "finishes a cancelled question's screenshot and handles a waiting send (%s)",
  async (capacity) => {
    const store = useComposerDraftStore.getState();
    const environmentId = EnvironmentId.make(`intake-recovery-${capacity}`);
    const threadId = ThreadId.make("thread");
    const requestId = RuntimeRequestId.make("question");
    const target = scopeThreadRef(environmentId, threadId);
    const question = questionAttachmentDraftId(environmentId, threadId, requestId, "image");
    using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
    if (capacity !== "available") {
      store.addFiles(
        target,
        Array.from(
          { length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - (capacity === "duplicate" ? 1 : 0) },
          (_, index) => {
            const name = `notes-${index}.txt`;
            return {
              type: "file" as const,
              id: name,
              name,
              mimeType: "text/plain",
              sizeBytes: 1,
              file: new File(["a"], name, { type: "text/plain" }),
            };
          },
        ),
      );
    }
    if (capacity === "duplicate") {
      const { file } = await compress(pastedImage());
      await readComposerImageBytes(file);
      store.addImages(target, [
        {
          type: "image",
          id: "existing-image",
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
          previewUrl: URL.createObjectURL(file),
        },
      ]);
    }
    const resumeCompression = deferred<void>();
    compression.prepare.mockReset().mockImplementation(async (file: File) => {
      await resumeCompression.promise;
      return compress(file);
    });
    const setThreadError = vi.fn();
    let intake!: Intake;
    let holdSend!: ReturnType<typeof useSubmitAfterPreparingImages>;
    const send = vi.fn();
    await using _screen = await render(
      <>
        <Harness
          input={{
            activeThreadId: threadId,
            activePendingProgress: null,
            activePendingIsResponding: false,
            pendingUserInputs: [],
            supportsQuestionAttachments: true,
            isLiteralPendingAnswer: true,
            projectSelectionRequired: false,
            questionAttachmentTarget: question,
            attachmentTargetKey: question,
            fileStagingLimit: null,
            promptRef: { current: "" },
            composerImagesRef: { current: [] },
            composerFilesRef: { current: [] },
            composerEditorRef: { current: null },
            isRevertingCheckpointRef: { current: false },
            setThreadError,
            countReservedAttachments: () => 0,
            addComposerImage: (image) => store.addImages(question, [image]),
            addComposerImagesToDraft: (images) => store.addImages(question, images),
            addComposerFilesToDraft: () => [],
            removeComposerImageFromDraft: () => {},
            insertAttachmentReferences: () => false,
          }}
          ready={(value) => {
            intake = value;
          }}
        />
        {capacity !== "available" && (
          <SendProbe
            target={composerTargetKey(target)}
            ready={(value) => {
              holdSend = value;
            }}
          />
        )}
      </>,
    );
    const attaching = intake.addComposerAttachments([pastedImage()]);
    makeThreadRequestsResolvedAnnouncer(
      environmentId,
      threadId,
    )([{ id: requestId, status: "cancelled" }]);
    if (capacity !== "available") {
      expect(holdSend(send)).toBe(true);
    }
    await act(async () => {
      resumeCompression.resolve();
      await attaching;
    });

    if (capacity === "full") {
      expect(send).not.toHaveBeenCalled();
      expect(store.getComposerDraft(target)?.images).toEqual([]);
      expect(setThreadError).toHaveBeenLastCalledWith(
        threadId,
        expect.stringContaining("image.png could not be restored"),
      );
    } else if (capacity === "duplicate") {
      expect(send).toHaveBeenCalledOnce();
      expect(store.getComposerDraft(target)?.images.map(({ id }) => id)).toEqual([
        "existing-image",
      ]);
      expect(setThreadError).toHaveBeenLastCalledWith(threadId, null);
    } else {
      expect(store.getComposerDraft(target)?.persistedAttachments).toEqual([
        expect.objectContaining({
          name: "image.png",
          dataUrl: expect.stringContaining("data:image/png;base64,"),
        }),
      ]);
      expect(setThreadError).toHaveBeenLastCalledWith(threadId, null);
    }
  },
);

it("saves recovered image records alongside existing records and drops stale results", async () => {
  const target = DraftId.make("intake-recovery-persisted-records");
  const store = useComposerDraftStore.getState();
  using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
  const saved = {
    id: "saved",
    name: "saved.png",
    mimeType: "image/png",
    sizeBytes: 1,
    dataUrl: "data:image/png;base64,AQ==",
  };
  const recovered = { ...saved, id: "recovered", dataUrl: "data:image/png;base64,Ag==" };
  const stale = { ...saved, id: "replaced", dataUrl: "data:image/png;base64,Aw==" };
  const images = hydrateImagesFromPersisted([saved, recovered, stale]);
  store.addImages(target, images);
  await store.syncPersistedAttachments(target, [saved]);
  store.removeImage(target, stale.id);
  const replacement = hydrateImagesFromPersisted([
    { ...stale, dataUrl: "data:image/png;base64,BA==" },
  ]);
  expect(store.addImages(target, replacement)).toEqual([stale.id]);

  await store.appendPersistedAttachments(target, images, [recovered, stale]);

  expect(store.getComposerDraft(target)?.persistedAttachments).toEqual([saved, recovered]);
});

it("prepares a repeated paste without a tile, and still keeps a different image", async () => {
  const target = DraftId.make("intake-repeat-paste");
  const store = useComposerDraftStore.getState();
  using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
  const firstCompression = deferred<void>();
  compression.prepare
    .mockReset()
    .mockImplementationOnce(async (file: File) => {
      await firstCompression.promise;
      return compress(file);
    })
    .mockImplementation(compress);
  const composerImagesRef = { current: [] as ComposerImageAttachment[] };
  const addImages = (images: ComposerImageAttachment[]) => {
    const ids = store.addImages(target, images);
    composerImagesRef.current =
      useComposerDraftStore.getState().getComposerDraft(target)?.images ?? [];
    return ids;
  };
  const input = {
    activeThreadId: ThreadId.make("thread"),
    activePendingProgress: null,
    activePendingIsResponding: false,
    pendingUserInputs: [],
    supportsQuestionAttachments: false,
    isLiteralPendingAnswer: false,
    projectSelectionRequired: false,
    questionAttachmentTarget: null,
    attachmentTargetKey: target,
    fileStagingLimit: null,
    promptRef: { current: "" },
    composerImagesRef,
    composerFilesRef: { current: [] },
    composerEditorRef: { current: null },
    isRevertingCheckpointRef: { current: false },
    setThreadError: () => {},
    countReservedAttachments: () =>
      composerImagesRef.current.length + getPreparingComposerImages(target).length,
    addComposerImage: (image) => addImages([image]),
    addComposerImagesToDraft: addImages,
    addComposerFilesToDraft: () => [],
    removeComposerImageFromDraft: () => {},
    insertAttachmentReferences: () => false,
  } satisfies IntakeInput;
  let intake!: Intake;
  await using _screen = await render(
    <Harness
      input={input}
      ready={(value) => {
        intake = value;
      }}
    />,
  );

  const first = intake.addComposerAttachments([pastedImage()]);
  const whileCompressing = intake.addComposerAttachments([pastedImage()]);
  expect(visiblePreparing(target)).toHaveLength(1);
  await act(async () => {
    firstCompression.resolve();
    await Promise.all([first, whileCompressing]);
  });

  const afterCompression = intake.addComposerAttachments([pastedImage()]);
  expect(visiblePreparing(target)).toHaveLength(0);
  await act(() => afterCompression);
  expect(composerImagesRef.current).toHaveLength(1);

  // Same name, type and size, different pixels: it compresses differently and is kept.
  const different = intake.addComposerAttachments([pastedImage(7)]);
  expect(visiblePreparing(target)).toHaveLength(0);
  await act(() => different);
  expect(composerImagesRef.current).toHaveLength(2);
});

// The thread row's discard runs after the composer left that thread; a draft session's discard
// unmounts its composer afterwards.
it.each(["thread", "session"] as const)(
  "a %s draft discarded while an image compresses stays discarded and can be restored",
  async (kind) => {
    const store = useComposerDraftStore.getState();
    const environmentId = EnvironmentId.make(`intake-discard-${kind}`);
    const threadId = ThreadId.make("thread");
    const target =
      kind === "session" ? DraftId.make("intake-discard") : scopeThreadRef(environmentId, threadId);
    if (typeof target === "string") {
      store.setProjectDraftThreadId(scopeProjectRef(environmentId, ProjectId.make("p")), target);
    }
    store.setPrompt(target, "half-written prompt");
    using _draft = {
      [Symbol.dispose]: () => {
        if (typeof target === "string") store.clearDraftThread(target);
        else store.clearComposerContent(target);
      },
    };
    const targetKey = composerTargetKey(target);

    const compressing = deferred<void>();
    const resumeCompression = deferred<void>();
    compression.prepare.mockReset().mockImplementation(async (file: File) => {
      compressing.resolve();
      await resumeCompression.promise;
      return compress(file);
    });

    const input = {
      activeThreadId: threadId,
      activePendingProgress: null,
      activePendingIsResponding: false,
      pendingUserInputs: [],
      supportsQuestionAttachments: false,
      isLiteralPendingAnswer: false,
      projectSelectionRequired: false,
      questionAttachmentTarget: null,
      attachmentTargetKey: targetKey,
      fileStagingLimit: null,
      promptRef: { current: "half-written prompt" },
      composerImagesRef: { current: [] },
      composerFilesRef: { current: [] },
      composerEditorRef: { current: null },
      isRevertingCheckpointRef: { current: false },
      setThreadError: () => {},
      countReservedAttachments: () => getPreparingComposerImages(targetKey).length,
      addComposerImage: (image) => store.addImages(target, [image]),
      addComposerImagesToDraft: (images) => store.addImages(target, images),
      addComposerFilesToDraft: () => [],
      removeComposerImageFromDraft: (id) => store.removeImage(target, id),
      insertAttachmentReferences: () => false,
    } satisfies IntakeInput;
    let intake!: Intake;
    await using screen = await render(
      <Harness
        input={input}
        ready={(value) => {
          intake = value;
        }}
      />,
    );
    const attaching = intake.addComposerAttachments([pastedImage()]);
    await compressing.promise;

    if (kind === "session") {
      discardComposerDraft(target);
      await screen.unmount();
    } else {
      await screen.unmount();
      discardComposerDraft(target);
    }
    await act(async () => {
      resumeCompression.resolve();
      await attaching;
    });

    expect(getPreparingComposerImages(targetKey)).toHaveLength(0);
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
    const undo = vi.mocked(showThreadUndoNotice).mock.calls.at(-1)![0].undo;
    expect(AsyncResult.isSuccess(await undo())).toBe(true);
    const restored = useComposerDraftStore.getState().getComposerDraft(target);
    expect(restored?.prompt).toBe("half-written prompt");
    expect(restored?.images).toEqual([]);
  },
);

it("releases thread.undo on intake and records snapshotted draft indices for empty-prompt batches", async () => {
  const target = DraftId.make("intake-empty-history");
  const store = useComposerDraftStore.getState();
  using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
  compression.prepare.mockReset().mockImplementation(compress);
  vi.mocked(releaseThreadUndoShortcut).mockClear();

  const existingFile = new File([new Uint8Array(20).fill(9)], "existing.png", {
    type: "image/png",
  });
  await readComposerImageBytes(existingFile);
  store.addImages(target, [
    {
      type: "image",
      id: "existing",
      name: "existing.png",
      mimeType: "image/png",
      sizeBytes: existingFile.size,
      previewUrl: URL.createObjectURL(existingFile),
      file: existingFile,
    },
  ]);

  const recordImageHistory = vi.fn(() => true);
  const composerImagesRef = {
    current: store.getComposerDraft(target)?.images ?? [],
  };
  const addImages = (images: ComposerImageAttachment[]) => {
    const ids = store.addImages(target, images);
    composerImagesRef.current =
      useComposerDraftStore.getState().getComposerDraft(target)?.images ?? [];
    return ids;
  };
  const input = {
    activeThreadId: ThreadId.make("thread"),
    activePendingProgress: null,
    activePendingIsResponding: false,
    pendingUserInputs: [],
    supportsQuestionAttachments: false,
    isLiteralPendingAnswer: false,
    projectSelectionRequired: false,
    questionAttachmentTarget: null,
    attachmentTargetKey: target,
    readDraftImages: () => useComposerDraftStore.getState().getComposerDraft(target)?.images ?? [],
    fileStagingLimit: null,
    promptRef: { current: "" },
    composerImagesRef,
    composerFilesRef: { current: [] },
    composerEditorRef: {
      current: {
        focus: () => {},
        focusAt: () => {},
        focusAtEnd: () => {},
        readSelectionRange: () => ({ start: 0, end: 0 }),
        captureAttachmentInsertion: () => undefined,
        insertAttachmentReferences: () => false,
        recordImageHistory,
        removeImageWithHistory: () => false,
        requestCitationComment: () => {},
        readSnapshot: () => ({ value: "", cursor: 0, expandedCursor: 0, contextIds: [] }),
        isCaretOnVisualEdge: () => true,
      },
    },
    isRevertingCheckpointRef: { current: false },
    setThreadError: () => {},
    countReservedAttachments: () =>
      composerImagesRef.current.length + getPreparingComposerImages(target).length,
    addComposerImage: (image) => addImages([image]),
    addComposerImagesToDraft: addImages,
    addComposerFilesToDraft: () => [],
    removeComposerImageFromDraft: () => {},
    insertAttachmentReferences: () => false,
  } satisfies IntakeInput;

  let intake!: Intake;
  await using _screen = await render(
    <Harness
      input={input}
      ready={(value) => {
        intake = value;
      }}
    />,
  );

  await act(async () => {
    await intake.addComposerAttachments([pastedImage(3), pastedImage(4)]);
  });
  expect(releaseThreadUndoShortcut).toHaveBeenCalledOnce();
  expect(composerImagesRef.current).toHaveLength(3);
  expect(recordImageHistory).toHaveBeenCalledWith("add", target, [
    expect.objectContaining({ id: composerImagesRef.current[1]!.id, index: 1 }),
    expect.objectContaining({ id: composerImagesRef.current[2]!.id, index: 2 }),
  ]);
});

it("strips a confirmed thumbnail removal from the original draft without touching question history after takeover", async () => {
  const unsubscribeHost = subscribeConfirmDialogHost(() => {});
  try {
    const draftTarget = DraftId.make("confirmed-remove-takeover");
    const questionTarget = questionAttachmentDraftId(
      EnvironmentId.make("env-takeover"),
      ThreadId.make("thread-takeover"),
      RuntimeRequestId.make("req-takeover"),
      "q1",
    );
    const file = new File(["img"], "shot.png", { type: "image/png" });
    const imageAttachment: ComposerImageAttachment = {
      type: "image",
      id: "img-shot",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: file.size,
      previewUrl: URL.createObjectURL(file),
      file,
    };
    const store = useComposerDraftStore.getState();
    store.addImages(draftTarget, [imageAttachment]);
    const chip = formatInlineContextReference(imageContextReference(imageAttachment));
    store.setPrompt(draftTarget, `Check ${chip}`);

    const editorRef = createRef<ComposerPromptEditorHandle>();
    let intake!: Intake;

    function TakeoverHarness({ questionActive }: { questionActive: boolean }) {
      const draft = useComposerThreadDraft(draftTarget);
      const attachmentDraftTarget = questionActive ? questionTarget : draftTarget;
      const attachmentDraft = useComposerThreadDraft(attachmentDraftTarget);
      const attachmentTargetKey = composerTargetKey(attachmentDraftTarget);
      const attachmentTargetKeyRef = useRef(attachmentTargetKey);
      const promptValue = questionActive ? "Question answer" : draft.prompt;
      const promptRef = useRef(promptValue);
      const composerImagesRef = useRef(attachmentDraft.images);
      useLayoutEffect(() => {
        attachmentTargetKeyRef.current = attachmentTargetKey;
        promptRef.current = promptValue;
        composerImagesRef.current = attachmentDraft.images;
      });

      const removeComposerImageFromDraft = (
        imageId: string,
        options?: { readonly recordHistory?: boolean; readonly stripReferences?: boolean },
      ) => {
        const editorOwnsTarget = attachmentTargetKeyRef.current === attachmentTargetKey;
        const images =
          useComposerDraftStore.getState().getComposerDraft(attachmentDraftTarget)?.images ?? [];
        const imageIndex = images.findIndex((candidate) => candidate.id === imageId);
        const image = imageIndex >= 0 ? images[imageIndex] : undefined;
        const recordedInEditor =
          editorOwnsTarget && options?.recordHistory === true && image !== undefined
            ? (editorRef.current?.removeImageWithHistory(
                attachmentTargetKey,
                toRetainedComposerImage(image, imageIndex),
                imageContextReference(image).contextId,
              ) ?? false)
            : false;
        useComposerDraftStore.getState().removeImage(attachmentDraftTarget, imageId, {
          stripReferences: options?.stripReferences ?? !recordedInEditor,
        });
      };

      const currentIntake = useComposerAttachmentIntake({
        activeThreadId: ThreadId.make("thread-takeover"),
        activePendingProgress: null,
        activePendingIsResponding: false,
        pendingUserInputs: [],
        supportsQuestionAttachments: true,
        isLiteralPendingAnswer: false,
        projectSelectionRequired: false,
        questionAttachmentTarget: questionActive ? questionTarget : null,
        attachmentTargetKey,
        readDraftImages: () =>
          useComposerDraftStore.getState().getComposerDraft(attachmentDraftTarget)?.images ?? [],
        fileStagingLimit: null,
        promptRef,
        composerImagesRef,
        composerFilesRef: { current: [] },
        composerEditorRef: editorRef,
        isRevertingCheckpointRef: { current: false },
        setThreadError: () => {},
        countReservedAttachments: () => attachmentDraft.images.length,
        addComposerImage: () => [],
        addComposerImagesToDraft: () => [],
        addComposerFilesToDraft: () => [],
        removeComposerImageFromDraft,
        insertAttachmentReferences: () => false,
      });
      useEffect(() => {
        intake = currentIntake;
      });

      return (
        <ComposerPromptEditor
          draftKey={attachmentTargetKey}
          editorRef={editorRef}
          value={promptValue}
          cursor={promptValue.length}
          richTextEnabled
          contextRecords={new Map()}
          skills={[]}
          disabled={false}
          placeholder=""
          onChange={(next) => {
            if (!questionActive) useComposerDraftStore.getState().setPrompt(draftTarget, next);
          }}
          onPaste={() => {}}
        />
      );
    }

    await using screen = await render(<TakeoverHarness questionActive={false} />);
    await act(() => {
      intake.removeComposerImage("img-shot");
    });

    await screen.rerender(<TakeoverHarness questionActive />);
    const questionEditorEl = screen.container.querySelector<
      HTMLElement & { editor?: { state: Parameters<typeof undoDepth>[0] } }
    >(".tiptap");
    expect(questionEditorEl?.editor).toBeDefined();

    await act(async () => {
      respondToConfirmDialog(true);
      await Promise.resolve();
    });

    expect(editorRef.current?.readSnapshot().value).toBe("Question answer");
    expect(undoDepth(questionEditorEl!.editor!.state)).toBe(0);
    expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.images).toHaveLength(0);
    expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt).toBe("Check");

    await screen.rerender(<TakeoverHarness questionActive={false} />);
    expect(editorRef.current?.readSnapshot().value).toBe("Check");
    expect(screen.container.textContent).not.toContain("Unavailable context");
  } finally {
    completeConfirmDialogClose();
    unsubscribeHost();
  }
});
