import remarkParse from "remark-parse";
import { unified } from "unified";

import { remarkKeepWindowsPaths } from "./markdownWindowsPaths.ts";
import { parseFileUrlHref } from "./fileLinks.ts";
import { safeDecodeURIComponent } from "./markdownLinks.ts";
import {
  isUncPath,
  isWindowsDrivePath,
  normalizeProjectPathForComparison,
  stripSlashPrefixedWindowsDrive,
} from "./path.ts";

const parser = unified().use(remarkParse).use(remarkKeepWindowsPaths);
interface MarkdownNode {
  readonly type: string;
  readonly url?: string | undefined;
  readonly identifier?: string | undefined;
  readonly label?: string | null | undefined;
  readonly alt?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly children?: ReadonlyArray<MarkdownNode> | undefined;
}

// Mobile Markdown parsers consume Windows backslashes; UNC paths also need file: to
// distinguish them from protocol-relative web URLs.
function imageDestination(path: string): string {
  return isWindowsDrivePath(path)
    ? path.replaceAll("\\", "/")
    : isUncPath(path)
      ? `file:${path.replaceAll("\\", "/")}`
      : path;
}

function angleDestination(path: string): string {
  return `<${path.replace(/[%?#&]/g, encodeURIComponent).replace(/[<>]/g, "\\$&")}>`;
}

export function appendGeneratedImageEmbeds(text: string, savedPaths: Iterable<string>): string {
  const destinations = new Map(
    Array.from(savedPaths, (path) => [normalizeProjectPathForComparison(path), path]),
  );
  const missing = new Map(destinations);
  const definitions = new Map<string, MarkdownNode>();
  const images: Array<MarkdownNode> = [];
  const visit = (node: MarkdownNode) => {
    if (
      node.type === "definition" &&
      node.identifier !== undefined &&
      !definitions.has(node.identifier)
    ) {
      definitions.set(node.identifier, node);
    } else if (node.type === "image" || node.type === "imageReference") {
      images.push(node);
    }
    node.children?.forEach(visit);
  };
  const nodes = parser.parse(text).children;
  nodes.forEach(visit);
  const edits = new Map<number, { readonly end: number; readonly text: string }>();
  for (const image of images) {
    const target = image.type === "image" ? image : definitions.get(image.identifier ?? "");
    if (target?.url === undefined) continue;
    // Literal percent sequences may be file names, so raw paths take precedence over decoding.
    // Protect file URL delimiters so parsing does not discard literal query/hash characters.
    const file = /^file:/i.test(target.url)
      ? parseFileUrlHref(target.url.replace(/[%?#]/g, encodeURIComponent))
      : null;
    const rawPath = stripSlashPrefixedWindowsDrive(
      file === null ? target.url : safeDecodeURIComponent(file.path),
    );
    const path = [rawPath, safeDecodeURIComponent(rawPath)].find((candidate) =>
      destinations.has(normalizeProjectPathForComparison(candidate)),
    );
    if (path === undefined) continue;
    missing.delete(normalizeProjectPathForComparison(path));
    const destination = angleDestination(imageDestination(path));
    const start = target.position?.start.offset;
    const end = target.position?.end.offset;
    if (
      (imageDestination(target.url) !== target.url ||
        /[?#]/.test(target.url) ||
        (path === rawPath && path.includes("%"))) &&
      start !== undefined &&
      end !== undefined
    ) {
      const label =
        target.type === "image" ? (target.alt ?? "") : (target.label ?? target.identifier ?? "");
      const escapedLabel = label.replace(/[\\[\]]/g, "\\$&");
      const title = target.title == null ? "" : ` "${target.title.replace(/["\\]/g, "\\$&")}"`;
      edits.set(start, {
        end,
        text:
          target.type === "image"
            ? `![${escapedLabel}](${destination}${title})`
            : `[${escapedLabel}]: ${destination}${title}`,
      });
    }
  }
  let result = text;
  for (const [start, edit] of Array.from(edits).sort(([left], [right]) => right - left)) {
    result = result.slice(0, start) + edit.text + result.slice(edit.end);
  }
  if (missing.size > 0) {
    // Only a root-level fence can swallow appended blocks; nested fences end with their container.
    const last = nodes.at(-1);
    const start = last?.position?.start.offset;
    const source =
      last?.type === "code" && start !== undefined
        ? text.slice(start, last.position?.end.offset)
        : "";
    const fence = /^(`{3,}|~{3,})/.exec(source)?.[0];
    if (fence !== undefined) {
      const lines = source.split(/\r\n|\r|\n/);
      const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(lines.at(-1) ?? "")?.[1];
      if (
        lines.length === 1 ||
        closing === undefined ||
        closing[0] !== fence[0] ||
        closing.length < fence.length
      ) {
        result += `${/[\r\n]$/.test(result) ? "" : "\n"}${fence}`;
      }
    }
  }
  for (const path of missing.values()) {
    result += `${result.length > 0 ? "\n\n" : ""}![](${angleDestination(imageDestination(path))})`;
  }
  return result;
}
