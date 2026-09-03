import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import { safeDecodeURIComponent } from "./markdownLinks.ts";

/** The authored media location, never the temporary URL used to load its bytes. */
export type MediaReference =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly relativePath?: string;
    }
  | { readonly kind: "url"; readonly url: string };

function absolutePathParts(path: string) {
  const windows = isWindowsAbsolutePath(path) || path.startsWith("//");
  const normalized = windows ? path.replaceAll("\\", "/") : path;
  const prefix = windows
    ? /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$))/i.exec(normalized)?.[0]
    : normalized.startsWith("/")
      ? "/"
      : undefined;
  if (!prefix) return undefined;

  const segments: string[] = [];
  for (const segment of normalized.slice(prefix.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const root = prefix.replace(/\/$/, "");
  return { root: windows ? root.toLowerCase() : root, segments, windows };
}

/** Compares paths lexically for the copy menu; it does not resolve filesystem symlinks. */
export function mediaFileReference(
  path: string,
  workspaceRoot?: string | null,
): Extract<MediaReference, { kind: "file" }> {
  const target = absolutePathParts(path);
  const workspace = workspaceRoot ? absolutePathParts(workspaceRoot) : undefined;
  if (
    !target ||
    !workspace ||
    target.windows !== workspace.windows ||
    target.root !== workspace.root ||
    target.segments.length <= workspace.segments.length ||
    !workspace.segments.every((segment, index) =>
      workspace.windows
        ? segment.toLowerCase() === target.segments[index]?.toLowerCase()
        : segment === target.segments[index],
    )
  ) {
    return { kind: "file", path };
  }
  return {
    kind: "file",
    path,
    relativePath: target.segments.slice(workspace.segments.length).join("/"),
  };
}

/** Pass the authored source, not a generated URL used by the media player. */
export function mediaUrlReference(
  url: string,
): Extract<MediaReference, { kind: "url" }> | undefined {
  if (!/^(?:https?:\/\/|\/\/)/i.test(url)) return undefined;
  try {
    const parsed = new URL(url.startsWith("//") ? `https:${url}` : url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? { kind: "url", url }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Local paths are already decoded; URL filename escapes are decoded exactly once. */
export function mediaReferenceFileName(reference: MediaReference): string | undefined {
  if (reference.kind === "file") {
    const windows = isWindowsAbsolutePath(reference.path) || reference.path.startsWith("//");
    return reference.path.split(windows ? /[\\/]/ : "/").at(-1) || undefined;
  }

  let basename: string | undefined;
  try {
    const url = reference.url;
    basename = new URL(url.startsWith("//") ? `https:${url}` : url).pathname.split("/").at(-1);
  } catch {
    return undefined;
  }
  return basename ? safeDecodeURIComponent(basename) : undefined;
}
