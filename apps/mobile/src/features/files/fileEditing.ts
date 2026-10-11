import type { ProjectReadFileResult } from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

import { isPdfFile } from "../../lib/filePreview";
import { isAbsolutePath, isAudioPreviewFile, isVideoPreviewFile } from "./filePath";

/**
 * A single native TextInput gets slow with large text on Android, so files past
 * this size stay read-only.
 */
export const MAX_EDITABLE_FILE_BYTES = 256 * 1024;

export type EditorLineEnding = "\r\n" | "\n";

/**
 * Only a complete, workspace-relative text file can be saved back. A host file
 * outside the workspace, a preview format, or a read the server could not
 * complete (no revision, truncated, too large) has no editable draft.
 */
export function canEditWorkspaceFile(input: {
  readonly relativePath: string;
  readonly file: ProjectReadFileResult | null;
}): boolean {
  const { file, relativePath } = input;
  return (
    !isAbsolutePath(relativePath) &&
    file !== null &&
    !file.truncated &&
    // Servers that predate guarded writes send no revision, so there is nothing
    // to detect a concurrent edit with.
    file.revision !== undefined &&
    file.byteLength <= MAX_EDITABLE_FILE_BYTES &&
    !isVideoPreviewFile(relativePath) &&
    !isAudioPreviewFile(relativePath) &&
    !isWorkspaceImagePreviewPath(relativePath) &&
    !isPdfFile({ name: relativePath })
  );
}

/**
 * The editor works in LF text. Remembering the file's line endings here is what
 * lets `fromEditorText` write a CRLF file back byte-identical.
 */
export function toEditorText(contents: string): {
  readonly text: string;
  readonly lineEnding: EditorLineEnding;
  readonly hasUtf8Bom: boolean;
} {
  const hasUtf8Bom = contents.startsWith("\uFEFF");
  const text = hasUtf8Bom ? contents.slice(1) : contents;
  return {
    text: text.replaceAll("\r\n", "\n"),
    lineEnding: text.includes("\r\n") ? "\r\n" : "\n",
    hasUtf8Bom,
  };
}

export function fromEditorText(
  text: string,
  lineEnding: EditorLineEnding,
  hasUtf8Bom = false,
): string {
  // Normalize first: an input method can insert its own CRLF into the LF text.
  const contents =
    lineEnding === "\r\n" ? text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n") : text;
  return (hasUtf8Bom ? "\uFEFF" : "") + contents;
}
