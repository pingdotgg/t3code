import { useEffect } from "react";
import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import type { ComposerContextReference } from "~/lib/composerContextReferences";
import { act, render } from "../../../test/render";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { getPreparingComposerImages } from "./preparingComposerImages";
import { useComposerAttachmentIntake } from "./useComposerAttachmentIntake";

const compression = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../../lib/imageCompression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/imageCompression")>()),
  prepareImageForAttachment: compression.prepare,
}));

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

function PasteHarness(props: {
  readonly prompt: string;
  readonly insertAttachmentReferences: (
    references: ReadonlyArray<ComposerContextReference>,
  ) => boolean;
  readonly onIntake: (intake: Intake) => void;
}) {
  const intake = useComposerAttachmentIntake({
    activeThreadId: ThreadId.make("thread-paste"),
    activePendingProgress: null,
    activePendingIsResponding: false,
    pendingUserInputs: [],
    supportsQuestionAttachments: false,
    isLiteralPendingAnswer: false,
    projectSelectionRequired: false,
    questionAttachmentTarget: null,
    attachmentTargetKey: "thread-paste",
    fileStagingLimit: 1_000_000,
    promptRef: { current: props.prompt },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerEditorRef: { current: null },
    isRevertingCheckpointRef: { current: false },
    setThreadError: () => {},
    countReservedAttachments: () => 0,
    addComposerImage: (image: ComposerImageAttachment) => [image.id],
    addComposerImagesToDraft: (images: ComposerImageAttachment[]) => images.map(({ id }) => id),
    addComposerFilesToDraft: (files: ComposerFileAttachment[]) => files.map(({ id }) => id),
    removeComposerImageFromDraft: () => {},
    insertAttachmentReferences: props.insertAttachmentReferences,
  });
  props.onIntake(intake);
  return null;
}

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

it("pasting an image and a file after text inserts a chip for each", async () => {
  const actual = await vi.importActual<typeof import("../../lib/imageCompression")>(
    "../../lib/imageCompression",
  );
  compression.prepare.mockReset().mockImplementation(actual.prepareImageForAttachment);
  const insertAttachmentReferences = vi.fn(
    (_references: ReadonlyArray<ComposerContextReference>) => true,
  );
  const intakes: Intake[] = [];
  // The hook reads no route.
  await using _screen = await render(
    <PasteHarness
      prompt="Look at this "
      insertAttachmentReferences={insertAttachmentReferences}
      onIntake={(intake) => intakes.push(intake)}
    />,
    { router: false },
  );

  await intakes
    .at(-1)
    ?.addComposerAttachments([
      new File([PNG], "shot.png", { type: "image/png" }),
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    ]);

  expect(
    insertAttachmentReferences.mock.calls.map(([references]) =>
      references.map(({ kind, label }) => `${kind}:${label}`),
    ),
  ).toEqual([["file:notes.txt"], ["image:shot.png"]]);
});
