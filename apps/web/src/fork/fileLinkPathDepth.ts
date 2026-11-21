import type { FileLinkPathDepth } from "@t3tools/contracts";
import { isWindowsAbsolutePath, stripSlashPrefixedWindowsDrive } from "@t3tools/shared/path";

import type { MarkdownFileLinkMeta } from "../markdown-links";

export type FileLinkPathMeta = Pick<MarkdownFileLinkMeta, "filePath" | "workspaceRelativePath">;

/** The last `depth - 1` folders of a file link as `a/b/`, or undefined when there are none to show. */
export function fileLinkPathPrefix(
  meta: FileLinkPathMeta,
  parentSuffixByPath: ReadonlyMap<string, string>,
  depth: FileLinkPathDepth,
): string | undefined {
  if (depth === 1 || parentSuffixByPath.has(meta.filePath.replaceAll("\\", "/"))) return undefined;
  // Workspace-relative paths already use `/`; a POSIX name may contain `\`.
  const path = meta.workspaceRelativePath ?? stripSlashPrefixedWindowsDrive(meta.filePath);
  const windows = meta.workspaceRelativePath === null && isWindowsAbsolutePath(path);
  const segments = path
    .split(windows ? /[\\/]/ : "/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (windows && /^[A-Za-z]:$/.test(segments[0] ?? "")) segments.shift();
  // The label names such a file by its last `\` part, so folders before it would misname the path.
  if (!windows && segments.at(-1)?.includes("\\")) return undefined;
  const folders = segments.slice(segments.lastIndexOf("..") + 1, -1).slice(1 - depth);
  return folders.length === 0 ? undefined : `${folders.join("/")}/`;
}
