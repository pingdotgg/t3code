import { isWorkspaceImagePreviewPath } from "@t3tools/shared/mediaPreview";
import type { ReactNode } from "react";

import { ImageBody } from "./ImageBody";
import { PathOnly } from "./PathOnly";
import { PdfBody } from "./PdfBody";
import { TextBody } from "./TextBody";
import type { FileTarget } from "./target";

/**
 * A file shown as its kind needs: code in C2's colors, markdown rendered, an image or a PDF from
 * the engine's signed URL, a TSV or CSV as a table, and a placeholder for any other binary.
 * Each has Copy, Download, and the menu that opens it in an editor.
 */
export function FilePreview({
  target,
  textBody,
}: {
  target: FileTarget;
  /** A body the caller draws for a file's text instead of the default, or undefined to keep the default. */
  textBody?: (text: string) => ReactNode | undefined;
}) {
  if (isWorkspaceImagePreviewPath(target.path)) {
    return (
      <PathOnly target={target}>
        <ImageBody target={target} />
      </PathOnly>
    );
  }
  if (/\.pdf$/i.test(target.path)) {
    return (
      <PathOnly target={target}>
        <PdfBody target={target} />
      </PathOnly>
    );
  }
  return <TextBody target={target} textBody={textBody} />;
}
