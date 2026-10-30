import remarkParse from "remark-parse";
import { unified } from "unified";

import { markdownDestinationHostPath } from "./markdownLinks.ts";
import { chatMarkdownImageSources } from "./markdownPipeline.ts";
import { isUncPath, isWindowsDrivePath, normalizeProjectPathForComparison } from "./path.ts";

const parser = unified().use(remarkParse);

function imageEmbed(path: string): string {
  // Forward slashes read the same in every client parser; UNC paths also need file: to
  // distinguish them from protocol-relative web URLs.
  const destination = isWindowsDrivePath(path)
    ? path.replaceAll("\\", "/")
    : isUncPath(path)
      ? `file:${path.replaceAll("\\", "/")}`
      : path;
  // Clients split `?`/`#`, decode `%` and `&` entities, and read POSIX backslashes as escapes;
  // line breaks end an angle destination.
  const escaped = destination.replace(/[%?#&\\\r\n]/g, encodeURIComponent).replace(/[<>]/g, "\\$&");
  return `![](<${escaped}>)`;
}

// Only a root-level fence can swallow appended blocks; nested fences end with their container.
function closingFence(text: string): string {
  const last = parser.parse(text).children.at(-1);
  if (last?.type !== "code") return "";
  const source = text.slice(last.position?.start.offset, last.position?.end.offset);
  const fence = /^(`{3,}|~{3,})/.exec(source)?.[0];
  if (fence === undefined) return "";
  const lines = source.split(/\r\n|\r|\n/);
  const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(lines.at(-1) ?? "")?.[1];
  const closed =
    lines.length > 1 &&
    closing !== undefined &&
    closing[0] === fence[0] &&
    closing.length >= fence.length;
  return closed ? "" : `${/[\r\n]$/.test(text) ? "" : "\n"}${fence}`;
}

/** Appends an embed for each saved image the reply does not already show. */
export function appendGeneratedImageEmbeds(text: string, savedPaths: Iterable<string>): string {
  const shown = new Set(
    chatMarkdownImageSources(text).flatMap((source) => {
      const path = markdownDestinationHostPath(source);
      return path === null ? [] : [normalizeProjectPathForComparison(path)];
    }),
  );
  const missing = new Map<string, string>();
  for (const path of savedPaths) {
    const key = normalizeProjectPathForComparison(path);
    if (!shown.has(key) && !missing.has(key)) missing.set(key, path);
  }
  if (missing.size === 0) return text;
  let result = text + closingFence(text);
  for (const path of missing.values()) {
    result += `${result.length > 0 ? "\n\n" : ""}${imageEmbed(path)}`;
  }
  return result;
}
