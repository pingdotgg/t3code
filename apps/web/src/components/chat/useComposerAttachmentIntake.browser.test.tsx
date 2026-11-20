import { useEffect } from "react";
import {
  EnvironmentId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { makeThreadRequestsResolvedAnnouncer } from "@t3tools/client-runtime/state/thread-requests";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";

import { act, render } from "../../../test/render";
import {
  type ComposerImageAttachment,
  DraftId,
  composerTargetKey,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { questionAttachmentDraftId } from "../../questionAttachments";
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
vi.mock("../../hooks/showThreadUndoNotice", () => ({ showThreadUndoNotice: vi.fn() }));

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
