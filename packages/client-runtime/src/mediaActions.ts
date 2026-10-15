import { isWindowsAbsolutePath } from "@t3tools/shared/path";

/** Format clipboard text using the file's host path, which can differ from the client's OS. */
export function formatFilePathForClipboard(path: string, hostPath = path): string {
  return isWindowsAbsolutePath(hostPath) ? path.replaceAll("/", "\\") : path;
}

/** Menu action ids shared by every client so labels and handlers line up across surfaces. */
export type MediaActionId =
  | "copy-full-path"
  | "copy-relative-path"
  | "copy-url"
  | "open-file"
  | "save"
  | "copy-image";
