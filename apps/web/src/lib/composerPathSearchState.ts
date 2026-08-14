import type { ComposerPathSearchEntry } from "@t3tools/client-runtime/state/threads";

export { useComposerPathSearch } from "../state/queries";

export function composerPathSearchEntryDescription(
  entry: ComposerPathSearchEntry,
  rootLabel?: string,
): string {
  const parentPath =
    entry.parentPath ?? entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/")));
  if (!entry.root) return parentPath;
  return `${rootLabel ?? entry.root}/${parentPath}`.replace(/\/$/, "");
}
