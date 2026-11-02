import type { AssetResource, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { toolOutputImageBlocks, toolOutputImages } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";

const MAX_TEXT_BLOCK_DEPTH = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSummarizedValue(value: unknown): boolean {
  return isRecord(value) && value.truncated === true && typeof value.summary === "string";
}

function textFromBlocks(
  value: unknown,
  depth: number,
  imageBlocks: ReadonlyArray<unknown>,
): string | null {
  if (depth > MAX_TEXT_BLOCK_DEPTH) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((block) => textFromBlocks(block, depth + 1, imageBlocks));
    return parts.every((part) => part !== null)
      ? parts.filter((part) => part !== "").join("\n")
      : null;
  }
  if (!isRecord(value)) return null;
  if (value.type === "text" && typeof value.text === "string") return value.text;
  if (value.type === "image") return imageBlocks.includes(value) ? "" : "[image]";
  if (value.type === "resource_link" && typeof value.uri === "string") return value.uri;
  if (value.type === "resource" && isRecord(value.resource)) {
    const resource = value.resource;
    if (typeof resource.text === "string") return resource.text;
    if (typeof resource.uri === "string") return resource.uri;
  }
  const keys = Object.keys(value).filter((key) => key !== "isError" && key !== "is_error");
  if (keys.length === 1 && keys[0] === "content")
    return textFromBlocks(value.content, depth + 1, imageBlocks);
  if (keys.length === 2 && keys.includes("content") && keys.includes("structuredContent")) {
    const text = textFromBlocks(value.content, depth + 1, imageBlocks);
    return text?.trim() ? text : null;
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function prettyJsonText(text: string): string {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return text;
  const whole = parseJson(trimmed);
  if (whole !== undefined) return JSON.stringify(whole, null, 2);
  const lines = trimmed.split("\n").filter((line) => line.trim());
  const documents = lines.map((line) => parseJson(line.trim()));
  if (documents.some((document) => document === undefined)) return text;
  return documents.map((document) => JSON.stringify(document, null, 2)).join("\n\n");
}

function formatToolValue(value: unknown, hasImagePreview = false): string | null {
  if (value === undefined || value === null) return null;
  if (hasImagePreview && isRecord(value) && value.type === "image") return null;
  const text = textFromBlocks(value, 0, toolOutputImageBlocks(value));
  if (text !== null) return text.trim() ? prettyJsonText(text) : null;
  let json: string | undefined;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
  if (json === undefined || json === "{}" || json === "[]") return null;
  return json;
}

export function toolCallLines(input: {
  readonly command?: string | undefined;
  readonly args?: unknown;
}): {
  readonly command: string | null;
  readonly args: ReadonlyArray<readonly [string, string]> | null;
  readonly argsText: string | null;
} {
  if (input.command !== undefined) {
    const command = input.command.trim();
    return { command: command || null, args: null, argsText: null };
  }
  const args = input.args;
  if (isRecord(args) && !isSummarizedValue(args)) {
    const entries = Object.entries(args).flatMap(
      ([key, value]): Array<readonly [string, string]> => {
        if (value === undefined) return [];
        // An empty string or null can be the point of a call (a clear or reset), so show it.
        return [
          [
            key,
            typeof value === "string" && value !== ""
              ? value
              : (JSON.stringify(value) ?? String(value)),
          ],
        ];
      },
    );
    return { command: null, args: entries.length > 0 ? entries : null, argsText: null };
  }
  return { command: null, args: null, argsText: formatToolValue(args) };
}

function toolCallHasLines(lines: ReturnType<typeof toolCallLines>): boolean {
  return lines.command !== null || lines.args !== null || lines.argsText !== null;
}

const LIVE_TURN_ITEM_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "idle",
  "pending",
  "running",
  "waiting",
]);

/**
 * A running item keeps one key, so an open row fetches once while it streams and
 * again when it finishes, not on every update.
 */
export function turnItemDetailRevision(item: OrchestrationV2TurnItem): string {
  return LIVE_TURN_ITEM_STATUSES.has(item.status) ? "live" : DateTime.formatIso(item.updatedAt);
}

export function turnItemNeedsDetailFetch(item: OrchestrationV2TurnItem): boolean {
  switch (item.type) {
    case "command_execution":
      return item.outputOmitted === true;
    case "dynamic_tool":
      return item.outputOmitted === true || isSummarizedValue(item.input);
    default:
      return false;
  }
}

function commandOutputText(output: string): string {
  if (!output.trimStart().startsWith('{"stdout"')) return output;
  const parsed = parseJson(output.trim());
  if (
    !isRecord(parsed) ||
    typeof parsed.stdout !== "string" ||
    typeof parsed.stderr !== "string" ||
    typeof parsed.interrupted !== "boolean"
  ) {
    return output;
  }
  return [parsed.stdout, parsed.stderr]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");
}

export function turnItemOutputText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "command_execution":
      return item.output?.trim() ? commandOutputText(item.output) || null : null;
    case "dynamic_tool":
      return item.outputOmitted === true
        ? null
        : formatToolValue(item.output, item.viewedImagePath !== undefined);
    case "file_search":
      return item.results?.length
        ? item.results
            .map((result) =>
              [
                `${result.fileName}${result.line === undefined ? "" : `:${result.line}`}`,
                result.preview?.trim(),
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n")
        : null;
    case "web_search":
      return item.results?.length
        ? item.results
            .map((result) =>
              [
                result.title?.trim() || result.url,
                result.title ? result.url : undefined,
                result.snippet?.trim(),
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n\n")
        : null;
    default:
      return null;
  }
}

export function turnItemOutputImages(
  item: OrchestrationV2TurnItem,
): ReadonlyArray<Extract<AssetResource, { readonly _tag: "tool-output-image" }>> {
  if (item.type !== "dynamic_tool" || item.outputOmitted === true) return [];
  return toolOutputImages(item.output).map((_, index) => ({
    _tag: "tool-output-image",
    threadId: item.threadId,
    itemId: item.id,
    index,
  }));
}

export function turnItemHasDetail(item: OrchestrationV2TurnItem): boolean {
  switch (item.type) {
    case "reasoning":
      return item.text.trim().length > 0;
    case "command_execution":
      return (
        toolCallLines({ command: item.input }).command !== null ||
        item.outputOmitted === true ||
        Boolean(item.output?.trim()) ||
        (item.exitCode !== undefined && item.exitCode !== 0)
      );
    case "file_change":
    case "checkpoint":
    case "fork":
    case "handoff":
      return true;
    case "file_search":
      return (item.results?.length ?? 0) > 0 || Boolean(item.pattern?.trim());
    case "web_search":
      return (item.results?.length ?? 0) > 0 || (item.patterns?.length ?? 0) > 0;
    case "dynamic_tool":
      return item.outputOmitted === true || toolCallHasLines(toolCallLines({ args: item.input }));
    case "approval_request":
      return Boolean(item.prompt?.trim());
    case "user_input_request":
      return item.questions.length > 0;
    case "notification":
      return Boolean(item.detail?.trim());
    case "system_notice":
      return item.message.trim().length > 0;
    case "error":
      return item.failure.message.trim().length > 0;
    case "proposed_plan":
      return item.markdown.trim().length > 0;
    case "todo_list":
      return item.steps.length > 0;
    case "subagent":
      return item.childThreadId !== null;
    default:
      return false;
  }
}
