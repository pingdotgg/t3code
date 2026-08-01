import { appendPreviewAnnotationPrompt } from "@t3tools/client-runtime/annotations";
import type { PreviewAnnotationPayload } from "@t3tools/contracts";

interface ComposerImageWithOptionalMarkup {
  readonly markup?: {
    readonly annotation: PreviewAnnotationPayload;
  };
}

export function appendComposerImageAnnotationPrompts(
  prompt: string,
  attachments: ReadonlyArray<ComposerImageWithOptionalMarkup>,
): string {
  return attachments.reduce(
    (current, attachment) =>
      attachment.markup
        ? appendPreviewAnnotationPrompt(current, attachment.markup.annotation)
        : current,
    prompt,
  );
}
