import type { FilePreviewKind } from "@t3tools/shared/filePreview";

/** The available preview and selected body must agree, including source-only draft files. */
export function attachmentDocumentPresentation(input: {
  kind: FilePreviewKind;
  hasTable: boolean;
  hasEnvironment: boolean;
  rendered: boolean;
}) {
  const renderedMode = input.hasTable
    ? "table"
    : input.kind === "markdown" && input.hasEnvironment
      ? "markdown"
      : input.kind === "html"
        ? "html"
        : null;
  return {
    renderedMode,
    activeMode: input.rendered && renderedMode !== null ? renderedMode : "source",
  } as const;
}
