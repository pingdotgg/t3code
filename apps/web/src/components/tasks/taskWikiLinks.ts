import type { EnvironmentId, TaskDocumentId, TaskDocumentSummary } from "@t3tools/contracts";
import type { Root } from "mdast";
import type { Plugin } from "unified";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  position?: {
    start?: { line?: number; column?: number; offset?: number };
    end?: { line?: number; column?: number; offset?: number };
  };
  data?: { hProperties?: Record<string, string> };
  children?: MarkdownNode[];
};

type TaskWikiTarget = Pick<TaskDocumentSummary, "canonicalPath" | "taskDocumentId" | "title">;
type SourceRange = { start: number; end: number };

function isWindowsPath(path: string) {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

function normalizedPath(path: string, caseInsensitive: boolean) {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function withoutMarkdownExtension(path: string) {
  return path.replace(/\.md$/i, "");
}

function taskDocumentHref(environmentId: EnvironmentId, taskDocumentId: TaskDocumentId) {
  return `/task/${encodeURIComponent(environmentId)}/${encodeURIComponent(taskDocumentId)}`;
}

function resolveTask(target: string, tasks: ReadonlyArray<TaskWikiTarget>): TaskWikiTarget | null {
  const trimmedTarget = target.trim();
  if (!trimmedTarget) return null;

  const matches = tasks.filter((task) => {
    const caseInsensitive = isWindowsPath(task.canonicalPath);
    const normalizedTarget = withoutMarkdownExtension(
      normalizedPath(trimmedTarget, caseInsensitive),
    );
    const path = withoutMarkdownExtension(normalizedPath(task.canonicalPath, caseInsensitive));
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (normalizedTarget.includes("/")) {
      return path.endsWith(`/${normalizedTarget}`) || path === normalizedTarget;
    }
    return (
      task.title.trim() === withoutMarkdownExtension(trimmedTarget) || basename === normalizedTarget
    );
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function nodeSourceRange(node: MarkdownNode): SourceRange | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return start === undefined || end === undefined ? null : { start, end };
}

function findUnescapedSourceMatch(source: string, range: SourceRange, match: string, from: number) {
  const nodeSource = source.slice(range.start, range.end);
  for (
    let index = nodeSource.indexOf(match, from);
    index >= 0;
    index = nodeSource.indexOf(match, index + match.length)
  ) {
    let backslashes = 0;
    for (let cursor = index - 1; nodeSource[cursor] === "\\"; cursor -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return range.start + index;
  }
  return null;
}

function markdownLineStarts(markdown: string) {
  const starts = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function pointAt(markdown: string, lineStarts: ReadonlyArray<number>, offset: number) {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((lineStarts[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  const lineIndex = Math.max(0, low - 1);
  const lineStart = lineStarts[lineIndex] ?? 0;
  return { line: lineIndex + 1, column: offset - lineStart + 1, offset };
}

export function taskWikiLinkIdFromNode(
  node: { properties?: Record<string, unknown>; position?: MarkdownNode["position"] } | undefined,
  markdown: string,
) {
  const taskDocumentId = node?.properties?.dataTaskDocumentId;
  const start = node?.position?.start?.offset;
  const end = node?.position?.end?.offset;
  if (
    typeof taskDocumentId !== "string" ||
    start === undefined ||
    end === undefined ||
    !/^\[\[[^\]|]+(?:\|[^\]]*)?\]\]$/.test(markdown.slice(start, end))
  ) {
    return null;
  }
  return taskDocumentId;
}

function replaceWikiLinks(
  node: MarkdownNode,
  tasks: ReadonlyArray<TaskWikiTarget>,
  environmentId: EnvironmentId,
  markdownSource: string,
  lineStarts: ReadonlyArray<number>,
  sourceRange?: SourceRange,
): MarkdownNode[] {
  if (node.type === "text" && typeof node.value === "string") {
    const ownRange = nodeSourceRange(node);
    const useOwnRange =
      ownRange !== null &&
      (sourceRange === undefined ||
        (ownRange.start >= sourceRange.start && ownRange.end <= sourceRange.end));
    const searchRange = useOwnRange ? ownRange : (sourceRange ?? ownRange);
    if (searchRange === null || searchRange === undefined) return [node];

    const output: MarkdownNode[] = [];
    const pattern = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
    let cursor = 0;
    let sourceCursor = 0;
    let replaced = false;

    for (const match of node.value.matchAll(pattern)) {
      const index = match.index;
      const sourceIndex = findUnescapedSourceMatch(
        markdownSource,
        searchRange,
        match[0],
        sourceCursor,
      );
      if (sourceIndex === null) continue;
      sourceCursor = sourceIndex - searchRange.start + match[0].length;
      if (node.value[index - 1] === "!") continue;
      const task = resolveTask(match[1] ?? "", tasks);
      if (task === null) continue;

      if (index > cursor) output.push({ type: "text", value: node.value.slice(cursor, index) });
      output.push({
        type: "link",
        url: taskDocumentHref(environmentId, task.taskDocumentId),
        position: {
          start: pointAt(markdownSource, lineStarts, sourceIndex),
          end: pointAt(markdownSource, lineStarts, sourceIndex + match[0].length),
        },
        data: { hProperties: { "data-task-document-id": task.taskDocumentId } },
        children: [{ type: "text", value: match[2]?.trim() || task.title }],
      });
      cursor = index + match[0].length;
      replaced = true;
    }

    if (!replaced) return [node];
    if (cursor < node.value.length) output.push({ type: "text", value: node.value.slice(cursor) });
    return output;
  }

  if (node.type === "link" || node.type === "linkReference") return [node];
  if (node.children) {
    const ownRange = nodeSourceRange(node);
    const childSourceRange =
      node.type === "listItem"
        ? (ownRange ?? sourceRange)
        : node.type === "paragraph" &&
            ownRange !== null &&
            (sourceRange === undefined ||
              (ownRange.start >= sourceRange.start && ownRange.end <= sourceRange.end))
          ? ownRange
          : sourceRange;
    node.children = node.children.flatMap((child) =>
      replaceWikiLinks(child, tasks, environmentId, markdownSource, lineStarts, childSourceRange),
    );
  }
  return [node];
}

export function remarkTaskWikiLinks(
  tasks: ReadonlyArray<TaskWikiTarget>,
  environmentId: EnvironmentId,
  markdownSource: string,
): Plugin<[], Root> {
  return () => (tree) => {
    const root = tree as unknown as MarkdownNode;
    const lineStarts = markdownLineStarts(markdownSource);
    if (root.children) {
      root.children = root.children.flatMap((child) =>
        replaceWikiLinks(child, tasks, environmentId, markdownSource, lineStarts),
      );
    }
  };
}
