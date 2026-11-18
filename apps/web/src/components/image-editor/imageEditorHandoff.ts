import { m } from "~/i18n/messages";
import { msg } from "gt-react";
import type { SnapShotSource } from "@t3tools/contracts";
import { editedImageSource } from "./imageEditorSource";
import { buildImageEditorPrompt } from "./imageEditorDocument";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import type { ExpandedImageItem } from "../chat/ExpandedImagePreview";
import type { ImageEditorResult } from "./ImageEditor";
import type { ImageEditorSession } from "./imageEditorSession";

export function buildImageAnimationPrompt(
  context: string,
  result: Pick<ImageEditorResult, "prompt"> &
    Partial<Pick<ImageEditorResult, "document" | "options">>,
): string {
  const instructions =
    result.prompt ||
    (result.document && result.options
      ? buildImageEditorPrompt(result.document, result.options)
      : "");
  return [
    context,
    instructions,
    "Apply the annotations on the frame sheet to the matching frames of the original GIF. Return the edited animation.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createImageEditorHandoff(
  threadKey: string,
  currentThread: { readonly current: string | null },
  composer: { readonly current: Pick<ChatComposerHandle, "stageImageEdit"> | null },
  animation?: { readonly original: File; readonly context: string },
) {
  return async (item: ExpandedImageItem, result: ImageEditorResult) => {
    if (currentThread.current !== threadKey) {
      throw new Error(
        m(msg("The thread changed while preparing the image. Reopen it and try again.")),
      );
    }
    if (!composer.current)
      throw new Error(m(msg("Open the thread composer before adding image edits.")));
    if (animation) {
      await composer.current.stageImageEdit({
        ...result,
        files: [animation.original, ...result.files],
        mode: "edit",
        animation,
        prompt: buildImageAnimationPrompt(animation.context, result),
      });
      return;
    }
    const source = item.editorSession?.originalSource ?? item.source;
    await composer.current.stageImageEdit(
      { ...result, ...(source ? { source } : {}) },
      item.attachmentId,
    );
  };
}

export function imageEditorFileMetadata(
  result: Pick<ImageEditorResult, "files" | "mode"> &
    Partial<Pick<ImageEditorResult, "document" | "originalFile" | "sessionFile" | "options">>,
  file: File,
  originalSource?: SnapShotSource,
): { imageEditor?: ImageEditorSession; source?: SnapShotSource } {
  if (file !== result.sessionFile || !result.document || !result.originalFile) return {};
  const source = editedImageSource(originalSource, result.document);
  return {
    imageEditor: {
      document: result.document,
      originalFile: result.originalFile,
      ...(result.mode === "edit" && result.options ? { options: result.options } : {}),
      ...(originalSource ? { originalSource } : {}),
    },
    ...(source ? { source } : {}),
  };
}
