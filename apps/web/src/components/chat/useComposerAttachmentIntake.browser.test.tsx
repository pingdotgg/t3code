import { useEffect } from "react";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";

import { act, render } from "../../../test/render";
import {
  type ComposerImageAttachment,
  DraftId,
  composerTargetKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { toastManager } from "../ui/toast";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { getPreparingComposerImages } from "./preparingComposerImages";
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
    resolveLocalFileLinker: () => null,
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
      resolveLocalFileLinker: () => null,
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

const MB = 1024 * 1024;
// A file's size is all the intake reads before upload, so a large one needs no real bytes.
const fileOfSize = (name: string, size: number) => {
  const file = new File([new Uint8Array(16)], name, { type: "application/gzip" });
  Object.defineProperty(file, "size", { value: size });
  return file;
};
const tooLarge = (name: string) => `'${name}' exceeds the 50 MB attachment limit.`;

async function renderFileIntake(overrides: Partial<IntakeInput> = {}) {
  const target = DraftId.make(`intake-link-${Math.random()}`);
  const threadErrors: Array<string | null> = [];
  const stored: string[] = [];
  const input = {
    activeThreadId: ThreadId.make("thread"),
    activePendingProgress: null,
    activePendingIsResponding: false,
    pendingUserInputs: [],
    supportsQuestionAttachments: true,
    isLiteralPendingAnswer: false,
    projectSelectionRequired: false,
    questionAttachmentTarget: null,
    attachmentTargetKey: target,
    fileStagingLimit: 50 * MB,
    promptRef: { current: "" },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerEditorRef: { current: null },
    isRevertingCheckpointRef: { current: false },
    setThreadError: (_threadId, error) => {
      threadErrors.push(error);
    },
    countReservedAttachments: () => stored.length,
    addComposerImage: () => [],
    addComposerImagesToDraft: () => [],
    addComposerFilesToDraft: (files) => {
      stored.push(...files.map((file) => file.name));
      return files.map((file) => file.id);
    },
    removeComposerImageFromDraft: () => {},
    insertAttachmentReferences: () => true,
    resolveLocalFileLinker: () => null,
    ...overrides,
  } satisfies IntakeInput;
  let intake!: Intake;
  const screen = await render(
    <Harness
      input={input}
      ready={(value) => {
        intake = value;
      }}
    />,
  );
  return { intake: () => intake, threadErrors, stored, screen };
}

const linkerThatLinks = () => {
  const linked: string[] = [];
  const link = vi.fn(async (files: File[]) => {
    linked.push(...files.map((file) => file.name));
    return { linked: files, missing: [] as File[] };
  });
  return { linked, link, resolve: () => link };
};

it("links a file over the upload limit by path when the server shares this computer", async () => {
  const toast = vi.spyOn(toastManager, "add");
  const linker = linkerThatLinks();
  const { intake, threadErrors, stored, screen } = await renderFileIntake({
    resolveLocalFileLinker: linker.resolve,
  });
  await using _screen = screen;

  const inserted = await act(() =>
    intake().addComposerAttachments([fileOfSize("device-firmware-build.tar.gz", 8192 * MB)]),
  );

  expect(inserted).toBe(true);
  expect(linker.linked).toEqual(["device-firmware-build.tar.gz"]);
  expect(stored).toEqual([]);
  expect(threadErrors.at(-1) ?? null).toBeNull();
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "info",
      title: expect.stringContaining("device-firmware-build.tar.gz"),
    }),
  );
  toast.mockRestore();
});

it("keeps refusing a file over the upload limit when the server is elsewhere", async () => {
  const { intake, threadErrors, stored, screen } = await renderFileIntake();
  await using _screen = screen;

  await act(() => intake().addComposerAttachments([fileOfSize("big.tar.gz", 60 * MB)]));

  expect(stored).toEqual([]);
  expect(threadErrors.at(-1)).toBe(tooLarge("big.tar.gz"));
});

it("attaches small files and links large ones dropped together", async () => {
  const linker = linkerThatLinks();
  const { intake, stored, screen } = await renderFileIntake({
    resolveLocalFileLinker: linker.resolve,
  });
  await using _screen = screen;

  await act(() =>
    intake().addComposerAttachments([
      fileOfSize("server.log", 2048),
      fileOfSize("recording.mov", 60 * MB),
    ]),
  );

  expect(stored).toEqual(["server.log"]);
  expect(linker.linked).toEqual(["recording.mov"]);
});

it.each([
  [
    "a question is waiting",
    { pendingUserInputs: [{} as IntakeInput["pendingUserInputs"][number]] },
  ],
  ["the prompt is a literal question answer", { isLiteralPendingAnswer: true }],
])("does not link a large file while %s", async (_case, overrides) => {
  const linker = linkerThatLinks();
  const { intake, threadErrors, screen } = await renderFileIntake({
    ...overrides,
    resolveLocalFileLinker: linker.resolve,
  });
  await using _screen = screen;

  await act(() => intake().addComposerAttachments([fileOfSize("big.tar.gz", 60 * MB)]));

  expect(linker.link).not.toHaveBeenCalled();
  expect(threadErrors.at(-1)).toBe(tooLarge("big.tar.gz"));
});

it("links a large file even when the draft has no attachment slots left", async () => {
  const linker = linkerThatLinks();
  const { intake, threadErrors, screen } = await renderFileIntake({
    resolveLocalFileLinker: linker.resolve,
    countReservedAttachments: () => 1_000,
  });
  await using _screen = screen;

  await act(() => intake().addComposerAttachments([fileOfSize("big.tar.gz", 60 * MB)]));

  expect(linker.linked).toEqual(["big.tar.gz"]);
  expect(threadErrors.at(-1) ?? null).toBeNull();
});

it("refuses a large file as before when its path cannot be read", async () => {
  const toast = vi.spyOn(toastManager, "add");
  const { intake, threadErrors, screen } = await renderFileIntake({
    resolveLocalFileLinker: () => async (files) => ({ linked: [], missing: files }),
  });
  await using _screen = screen;

  const inserted = await act(() =>
    intake().addComposerAttachments([fileOfSize("big.tar.gz", 60 * MB)]),
  );

  expect(inserted).toBe(false);
  expect(threadErrors.at(-1)).toBe(tooLarge("big.tar.gz"));
  expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "info" }));
  toast.mockRestore();
});
