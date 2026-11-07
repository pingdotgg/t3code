import { isWindowsAbsolutePath } from "@t3tools/shared/path";

// The file host can use a different path style from the client.
export function formatFilePathForClipboard(path: string, hostPath = path): string {
  return isWindowsAbsolutePath(hostPath) ? path.replaceAll("/", "\\") : path;
}

export type MediaActionId =
  | "copy-full-path"
  | "copy-relative-path"
  | "copy-url"
  | "open-file"
  | "save"
  | "copy-image";
