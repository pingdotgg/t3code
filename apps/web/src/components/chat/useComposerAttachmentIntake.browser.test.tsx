import { useEffect } from "react";
import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { ComposerImageAttachment } from "../../composerDraftStore";
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
const pastedImage = () => new File([new Uint8Array(100)], "image.png", { type: "image/png" });

it("skips pasting an image the draft already has, while it compresses and after", async () => {
  const targetKey = "intake-duplicate-paste";
  const compressed = deferred<{ ok: true; file: File; recompressed: true }>();
  compression.prepare.mockReset().mockReturnValueOnce(compressed.promise);
  const composerImagesRef = { current: [] as ComposerImageAttachment[] };
  const addImages = (images: ComposerImageAttachment[]) => {
    composerImagesRef.current = [...composerImagesRef.current, ...images];
    return images.map((image) => image.id);
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
    attachmentTargetKey: targetKey,
    fileStagingLimit: null,
    promptRef: { current: "" },
    composerImagesRef,
    composerFilesRef: { current: [] },
    composerEditorRef: { current: null },
    isRevertingCheckpointRef: { current: false },
    setThreadError: () => {},
    countReservedAttachments: () =>
      composerImagesRef.current.length + getPreparingComposerImages(targetKey).length,
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
  void intake.addComposerAttachments([pastedImage()]);
  expect(getPreparingComposerImages(targetKey)).toHaveLength(1);

  // Compression shrinks the image, so the draft's copy no longer matches the pasted bytes.
  await act(async () => {
    compressed.resolve({
      ok: true,
      file: new File([new Uint8Array(60)], "image.png", { type: "image/png" }),
      recompressed: true,
    });
    await first;
  });
  expect(composerImagesRef.current).toHaveLength(1);

  void intake.addComposerAttachments([pastedImage()]);
  expect(getPreparingComposerImages(targetKey)).toHaveLength(0);
  expect(compression.prepare).toHaveBeenCalledTimes(1);
});
