import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import type { ComposerContextReference } from "~/lib/composerContextReferences";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { render } from "../../../test/render";
import { useComposerAttachmentIntake } from "./useComposerAttachmentIntake";

type Intake = ReturnType<typeof useComposerAttachmentIntake>;

function Harness(props: {
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
  ).toEqual([["file:notes.txt"], ["image:shot.png"]]);
});
