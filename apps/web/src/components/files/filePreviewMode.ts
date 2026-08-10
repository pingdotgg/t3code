import type { ProjectFileFailure } from "@t3tools/contracts";

export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

/**
 * `failure` the server reports when a workspace file's bytes are not UTF-8
 * text, so the text preview has nothing to render. Typed against the contract
 * so a renamed literal fails the build instead of silently never matching.
 */
const BINARY_FILE_PREVIEW_FAILURE: ProjectFileFailure = "binary_file";

export const isBinaryFilePreviewError = (errorFailure: string | null): boolean =>
  errorFailure === BINARY_FILE_PREVIEW_FAILURE;

/**
 * The raw server error repeats the workspace root and the internal reason,
 * which is noise in a panel whose header already shows the path. Name just the
 * file the user clicked.
 */
export function binaryFilePreviewDescription(relativePath: string): string {
  const trimmed = relativePath.replace(/\/+$/, "");
  const basename = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return `${basename || relativePath} is a binary file, so it can't be shown as text.`;
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
