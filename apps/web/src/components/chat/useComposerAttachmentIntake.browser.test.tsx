import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import type { ComposerContextReference } from "~/lib/composerContextReferences";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { imageContextReference } from "~/lib/composerContextRecords";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import {
  readConfirmDialogState,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "~/confirmDialog";
import { render } from "../../../test/render";
import { useComposerAttachmentIntake } from "./useComposerAttachmentIntake";

type Intake = ReturnType<typeof useComposerAttachmentIntake>;

function Harness(props: {
  readonly prompt: string;
  readonly images?: ComposerImageAttachment[];
  readonly onRemove?: (id: string) => void;
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
    questionAttachmentTarget: null,
    attachmentTargetKey: "thread-paste",
    fileStagingLimit: 1_000_000,
    promptRef: { current: props.prompt },
    composerImagesRef: { current: props.images ?? [] },
    composerFilesRef: { current: [] },
    composerEditorRef: { current: null },
    isRevertingCheckpointRef: { current: false },
    setThreadError: () => {},
    countReservedAttachments: () => 0,
    addComposerImage: (image: ComposerImageAttachment) => [image.id],
    addComposerImagesToDraft: (images: ComposerImageAttachment[]) => images.map(({ id }) => id),
    addComposerFilesToDraft: (files: ComposerFileAttachment[]) => files.map(({ id }) => id),
    removeComposerImageFromDraft: props.onRemove ?? (() => {}),
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

it("pasting after text keeps images in the strip and inserts file references", async () => {
  const insertAttachmentReferences = vi.fn(
    (_references: ReadonlyArray<ComposerContextReference>) => true,
  );
  const intakes: Intake[] = [];
  // The hook reads no route.
  await using _screen = await render(
    <Harness
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
  ).toEqual([["file:notes.txt"]]);
});

it.each([false, true])(
  "removing an image confirms only an explicit reference (%s)",
  async (referenced) => {
    const image: ComposerImageAttachment = {
      type: "image",
      id: "image",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: PNG.length,
      file: new File([PNG], "shot.png", { type: "image/png" }),
      previewUrl: "blob:shot",
    };
    const onRemove = vi.fn();
    const intakes: Intake[] = [];
    await using _screen = await render(
      <Harness
        prompt={
          referenced ? formatInlineContextReference(imageContextReference(image)) : "Look at this"
        }
        images={[image]}
        onRemove={onRemove}
        insertAttachmentReferences={() => true}
        onIntake={(intake) => intakes.push(intake)}
      />,
    );
    using _host = { [Symbol.dispose]: subscribeConfirmDialogHost(() => {}) };
    intakes.at(-1)?.removeComposerImage(image.id);
    if (referenced) {
      expect(onRemove).not.toHaveBeenCalled();
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        confirmLabel: "Remove",
      });
      respondToConfirmDialog(true);
      await Promise.resolve();
    }
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(image.id);
  },
);
