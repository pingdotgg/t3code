import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import {
  HTML_RENDER_TOOL_NAME,
  readHtmlRenderReference,
  type HtmlRenderReference,
} from "./htmlRender.ts";
import {
  claudeMcpToolName,
  MCP_APP_OUTPUT_KEY,
  readMcpAppReference,
  type McpAppReference,
} from "./mcpApp.ts";
import { resolveT3McpToolId } from "./t3McpToolPresentation.ts";

export const SEND_TO_USER_TOOL_NAME = "send_to_user";
// 4,000 UTF-16 units stay inside MAX_PARSED_BYTES even as 3-byte characters.
export const SEND_TO_USER_MAX_LENGTH = 4_000;

const MAX_PARSED_BYTES = 16_384;
const MAX_METADATA_BYTES = 8_192;
const MAX_ID_LENGTH = 256;
const MAX_THREADS = 100;
const MAX_PULL_REQUEST_ITEMS = 100;
const MAX_CONTENT_BLOCKS = 32;
const MAX_ENVELOPE_DEPTH = 4;
const MAX_ENVELOPE_NODES = 128;
export const PREVIEW_SNAPSHOT_TOOL_NAME = "preview_snapshot";
const DEVICE_SCREENSHOT_TOOL_NAME = "device_screenshot";
export const HTML_PREVIEW_TOOL_NAME = "html_preview";
const MAX_SCREENSHOT_PATH_LENGTH = 4_096;
const MAX_VISUAL_SUMMARY_TEXT_LENGTH = 4_096;
const MAX_VISUAL_TOOL_METADATA_BYTES = 32_768;
const RASTER_IMAGE_PATH_PATTERN = /\.(?:png|jpe?g|gif|webp)$/i;
const BASE64_IMAGE_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const encoder = new TextEncoder();
// Antigravity's terminal tool prefixes an `acp-mcp-call` result's stdout with timestamps and exit status.
const TERMINAL_OUTPUT_MARKER = "\nCommand output:\n";

interface ResultReadBudget {
  remainingBytes: number;
  remainingNodes: number;
  exceeded: boolean;
}

interface ResultEnvelope {
  data?: Record<PropertyKey, unknown>;
  failed: boolean;
}

interface CompactToolOutput {
  isError?: true;
  threadId?: string;
  messageId?: string;
  taskId?: string;
  scheduledTaskId?: string;
  status?: "rolled_back";
  htmlRender?: HtmlRenderReference;
  [MCP_APP_OUTPUT_KEY]?: McpAppReference;
  thread?: { threadId: string };
  threads?: Array<{ threadId?: string; status?: "rolled_back" }>;
  linkedCount?: number;
  unlinkedCount?: number;
  created?: boolean;
  state?: "open" | "closed" | "merged";
  guides?: Array<{ outcome: "started" | "running" | "failed" }>;
  checks?: Array<{ rerun: boolean }>;
  sentMessage?: string;
}

function readResult(value: unknown, budget: ResultReadBudget, depth = 0): ResultEnvelope {
  if (depth > MAX_ENVELOPE_DEPTH || budget.remainingNodes-- <= 0) {
    budget.exceeded = true;
    return { failed: false };
  }
  if (typeof value === "string") {
    if (value.length > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    const bytes = encoder.encode(value).byteLength;
    if (bytes > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    budget.remainingBytes -= bytes;
    try {
      return readResult(JSON.parse(value), budget, depth + 1);
    } catch {
      return { failed: false };
    }
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTENT_BLOCKS) {
      budget.exceeded = true;
      return { failed: false };
    }
    let data: ResultEnvelope["data"];
    let failed = false;
    for (const block of value) {
      const text = Predicate.isObject(block) ? block.text : undefined;
      const result = readResult(
        Predicate.isObject(text) ? (text.text ?? text) : text,
        budget,
        depth + 1,
      );
      data ??= result.data;
      failed ||= result.failed;
      if (budget.exceeded) break;
    }
    return { ...(data === undefined ? {} : { data }), failed };
  }
  if (!Predicate.isObject(value)) return { failed: false };
  const failed =
    value.isError === true ||
    value.is_error === true ||
    value._tag === "OrchestratorMcpFailure" ||
    value.error != null;
  const terminal = typeof value.output === "string" ? value.output : "";
  const marker = terminal.indexOf(TERMINAL_OUTPUT_MARKER);
  const content =
    value.structuredContent ??
    value.content ??
    (marker === -1 ? undefined : terminal.slice(marker + TERMINAL_OUTPUT_MARKER.length));
  if (content !== undefined) {
    const nested = readResult(content, budget, depth + 1);
    return { ...nested, failed: failed || nested.failed };
  }
  return { data: value, failed };
}

function boundedId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || value.trim() === "") {
    return undefined;
  }
  return Array.from(value).join("");
}

// All or nothing: a partial list would make the summary report wrong counts.
function readEntries<T>(
  value: unknown,
  read: (entry: { readonly [key: string]: unknown }) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PULL_REQUEST_ITEMS) return undefined;
  const entries: T[] = [];
  for (const entry of value) {
    const compact = Predicate.isObject(entry) ? read(entry) : undefined;
    if (compact === undefined) return undefined;
    entries.push(compact);
  }
  return entries;
}

export function compactDynamicToolOutput(value: unknown): CompactToolOutput | undefined {
  const budget: ResultReadBudget = {
    remainingBytes: MAX_PARSED_BYTES,
    remainingNodes: MAX_ENVELOPE_NODES,
    exceeded: false,
  };
  const result = readResult(value, budget);
  const output: CompactToolOutput = result.failed ? { isError: true } : {};
  const data = budget.exceeded ? undefined : result.data;
  if (data !== undefined) {
    for (const key of ["threadId", "messageId", "taskId", "scheduledTaskId"] as const) {
      const id = boundedId(data[key]);
      if (id !== undefined) output[key] = id;
    }
    if (data.status === "rolled_back") output.status = "rolled_back";
    for (const key of ["linkedCount", "unlinkedCount"] as const) {
      const count = data[key];
      if (typeof count === "number" && Number.isSafeInteger(count)) output[key] = count;
    }
    if (typeof data.created === "boolean") output.created = data.created;
    if (data.state === "open" || data.state === "closed" || data.state === "merged") {
      output.state = data.state;
    }
    const guides = readEntries(data.guides, (entry) =>
      entry.outcome === "started" || entry.outcome === "running" || entry.outcome === "failed"
        ? ({ outcome: entry.outcome } as const)
        : undefined,
    );
    if (guides !== undefined) output.guides = guides;
    const checks = readEntries(data.checks, (entry) =>
      typeof entry.rerun === "boolean" ? { rerun: entry.rerun } : undefined,
    );
    if (checks !== undefined) output.checks = checks;
    if (
      typeof data.sentMessage === "string" &&
      data.sentMessage.trim() !== "" &&
      data.sentMessage.length <= SEND_TO_USER_MAX_LENGTH
    ) {
      output.sentMessage = data.sentMessage;
    }
    const htmlRender = readHtmlRenderReference(data.htmlRender);
    if (htmlRender !== undefined) output.htmlRender = htmlRender;
    const mcpApp = readMcpAppReference(data[MCP_APP_OUTPUT_KEY]);
    if (mcpApp !== undefined) output[MCP_APP_OUTPUT_KEY] = mcpApp;
    const nestedThreadId = Predicate.isObject(data.thread)
      ? boundedId(data.thread.threadId)
      : undefined;
    if (nestedThreadId !== undefined) output.thread = { threadId: nestedThreadId };

    if (Array.isArray(data.threads)) {
      let complete = data.threads.length <= MAX_THREADS;
      const threads: NonNullable<CompactToolOutput["threads"]> = [];
      if (complete) {
        for (const entry of data.threads) {
          if (!Predicate.isObject(entry)) {
            complete = false;
            break;
          }
          const threadId = boundedId(entry.threadId);
          const rolledBack = entry.status === "rolled_back";
          if (threadId === undefined && !rolledBack) {
            complete = false;
            break;
          }
          threads.push({
            ...(threadId === undefined ? {} : { threadId }),
            ...(rolledBack ? { status: "rolled_back" as const } : {}),
          });
        }
      }
      if (complete) output.threads = threads;
      else {
        // Partial batches or top-level ids make the summary parser report a false creation count.
        delete output.threadId;
        delete output.status;
      }
    }
  }
  const oversized = () => encoder.encode(JSON.stringify(output)).byteLength > MAX_METADATA_BYTES;
  if (oversized()) {
    delete output.threads;
    delete output.threadId;
    delete output.status;
    delete output.guides;
    delete output.checks;
  }
  const app = output[MCP_APP_OUTPUT_KEY];
  if (app?.csp !== undefined && oversized()) {
    const { csp: _csp, ...rest } = app;
    output[MCP_APP_OUTPUT_KEY] = rest;
  }
  if (oversized()) delete output[MCP_APP_OUTPUT_KEY];
  return Object.keys(output).length === 0 ? undefined : output;
}

// OpenCode 2 Code Mode reports a script's nested T3 tool calls as one item with the script's result.
const OPENCODE_CODE_MODE_TOOL_NAME = "execute";

export function htmlRenderFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): HtmlRenderReference | undefined {
  if (
    item.toolName !== OPENCODE_CODE_MODE_TOOL_NAME &&
    resolveT3McpToolId(item.toolName) !== HTML_RENDER_TOOL_NAME
  ) {
    return undefined;
  }
  const output = compactDynamicToolOutput(item.output);
  return output?.isError ? undefined : output?.htmlRender;
}

/** The text `send_to_user` showed the user, which clients render as the agent's own words. */
export function sentMessageFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): string | undefined {
  if (
    item.toolName !== OPENCODE_CODE_MODE_TOOL_NAME &&
    resolveT3McpToolId(item.toolName) !== SEND_TO_USER_TOOL_NAME
  ) {
    return undefined;
  }
  const output = compactDynamicToolOutput(item.output);
  return output?.isError ? undefined : output?.sentMessage;
}

/** The thread-owned file `preview_recording_stop` stored for the agent. */
export function previewRecordingIdFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): string | undefined {
  if (resolveT3McpToolId(item.toolName) !== "preview_recording_stop") return undefined;
  const budget: ResultReadBudget = {
    remainingBytes: MAX_PARSED_BYTES,
    remainingNodes: MAX_ENVELOPE_NODES,
    exceeded: false,
  };
  const result = readResult(item.output, budget);
  return result.failed || budget.exceeded ? undefined : boundedId(result.data?.id);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Predicate.isObject(value) && !Array.isArray(value);
}

function recordIndicatesFailure(record: Record<string, unknown>): boolean {
  return (
    record.isError === true ||
    record.is_error === true ||
    record._tag === "OrchestratorMcpFailure" ||
    record.error != null
  );
}

function isRasterScreenshotPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_SCREENSHOT_PATH_LENGTH &&
    !/[\r\n\0]/.test(trimmed) &&
    RASTER_IMAGE_PATH_PATTERN.test(trimmed)
  );
}

function parseBoundedJsonRecord(text: string): Record<string, unknown> | undefined {
  if (text.length > MAX_VISUAL_TOOL_METADATA_BYTES) return undefined;
  if (encoder.encode(text).byteLength > MAX_VISUAL_TOOL_METADATA_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readVisualMetadataRecord(value: unknown): {
  readonly record?: Record<string, unknown>;
  readonly failed: boolean;
} {
  if (typeof value === "string") {
    const parsed = parseBoundedJsonRecord(value);
    return parsed === undefined
      ? { failed: false }
      : { record: parsed, failed: recordIndicatesFailure(parsed) };
  }
  if (Array.isArray(value)) {
    let record: Record<string, unknown> | undefined;
    let failed = false;
    const limit = Math.min(value.length, MAX_CONTENT_BLOCKS);
    for (let index = 0; index < limit; index += 1) {
      const block = value[index];
      if (!isPlainRecord(block)) continue;
      if (recordIndicatesFailure(block)) failed = true;
      const text = isPlainRecord(block.text) ? block.text.text : block.text;
      if (typeof text !== "string") continue;
      const parsed = parseBoundedJsonRecord(text);
      if (parsed !== undefined) {
        if (recordIndicatesFailure(parsed)) failed = true;
        if (Object.keys(parsed).length > 0) record = parsed;
      }
    }
    return { ...(record === undefined ? {} : { record }), failed };
  }
  if (!isPlainRecord(value)) return { failed: false };
  const failed = recordIndicatesFailure(value);
  if (isPlainRecord(value.structuredContent) && Object.keys(value.structuredContent).length > 0) {
    return {
      record: value.structuredContent,
      failed: failed || recordIndicatesFailure(value.structuredContent),
    };
  }
  if (Array.isArray(value.content)) {
    const nested = readVisualMetadataRecord(value.content);
    return { ...nested, failed: failed || nested.failed };
  }
  if (
    value.type === "image" ||
    value.type === "text" ||
    value.type === "resource" ||
    value.type === "resource_link"
  ) {
    return { failed };
  }
  return Object.keys(value).length > 0 ? { record: value, failed } : { failed };
}

function cleanScreenshotMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "data" || key === "blob" || key === "base64") continue;
    next[key] = entry;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function sanitizeVisualToolMetadata(
  record: Record<string, unknown>,
  tool: string,
  hasImages: boolean,
): Record<string, unknown> | undefined {
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    // Drop server-only fields (`fullScreenshot`, `omitted`) so structuredContent and content-only
    // bounded snapshots normalize identically across ACP runtimes.
    if (key === "fullScreenshot" || key === "omitted") continue;
    if (key === "screenshot") {
      const meta = cleanScreenshotMetadata(entry);
      if (meta !== undefined) cleaned.screenshot = meta;
      continue;
    }
    cleaned[key] = entry;
  }
  const recognized =
    tool === PREVIEW_SNAPSHOT_TOOL_NAME
      ? typeof cleaned.url === "string" ||
        isRasterScreenshotPath(cleaned.screenshotPath) ||
        isPlainRecord(cleaned.screenshot)
      : isPlainRecord(cleaned.screenshot) || (hasImages && Object.keys(cleaned).length > 0);
  if (!recognized) return undefined;
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(cleaned);
  } catch {
    return undefined;
  }
  if (
    encoded !== undefined &&
    encoder.encode(encoded).byteLength <= MAX_VISUAL_TOOL_METADATA_BYTES
  ) {
    return cleaned;
  }
  const summary: Record<string, unknown> = {};
  if (typeof cleaned.url === "string")
    summary.url = cleaned.url.slice(0, MAX_VISUAL_SUMMARY_TEXT_LENGTH);
  if (typeof cleaned.title === "string")
    summary.title = cleaned.title.slice(0, MAX_VISUAL_SUMMARY_TEXT_LENGTH);
  if (isRasterScreenshotPath(cleaned.screenshotPath)) {
    summary.screenshotPath = cleaned.screenshotPath.trim();
  }
  if (isPlainRecord(cleaned.screenshot)) summary.screenshot = cleaned.screenshot;
  if (Object.keys(summary).length === 0) return undefined;
  try {
    return encoder.encode(JSON.stringify(summary)).byteLength <= MAX_VISUAL_TOOL_METADATA_BYTES
      ? summary
      : undefined;
  } catch {
    return undefined;
  }
}

export function isVisualT3McpTool(toolName: string | null | undefined): boolean {
  const resolved = resolveT3McpToolId(toolName);
  return (
    resolved === PREVIEW_SNAPSHOT_TOOL_NAME ||
    resolved === DEVICE_SCREENSHOT_TOOL_NAME ||
    resolved === HTML_PREVIEW_TOOL_NAME
  );
}

function hasValidImageBase64Data(data: string | undefined): data is string {
  return (
    data !== undefined &&
    data.length > 0 &&
    data.length <= MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH &&
    data.length % 4 === 0 &&
    BASE64_IMAGE_DATA_PATTERN.test(data)
  );
}

/** True when a tool output carries at least one inline image with valid bounded base64 bytes. */
export function hasUsableToolOutputImages(value: unknown): boolean {
  return toolOutputImages(value).some((image) => hasValidImageBase64Data(image.data));
}

/** The saved screenshot path reported by `preview_snapshot({ save: true })`. */
export function previewSnapshotScreenshotPath(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): string | undefined {
  if (resolveT3McpToolId(item.toolName) !== PREVIEW_SNAPSHOT_TOOL_NAME) return undefined;
  const visual = readVisualMetadataRecord(item.output);
  if (visual.failed || visual.record === undefined) return undefined;
  return isRasterScreenshotPath(visual.record.screenshotPath)
    ? visual.record.screenshotPath.trim()
    : undefined;
}

/**
 * Compact structured result a T3 MCP tool carries on its turn item.
 * Preserves every metadata field clients, summaries, and attachment retention read; when
 * `includeVisual` is enabled for ACP recovery, also keeps bounded screenshot/snapshot outputs.
 */
export function compactT3McpToolOutput(
  toolName: string | null | undefined,
  value: unknown,
  options?: { readonly includeVisual?: boolean },
): Record<string, unknown> | undefined {
  const resolved = resolveT3McpToolId(toolName);
  if (resolved === null) return undefined;
  const compact = compactDynamicToolOutput(value);
  if (compact?.isError) return { ...compact };
  if (resolved === "preview_recording_stop") {
    const recordingId = previewRecordingIdFromToolItem({ toolName: resolved, output: value });
    if (recordingId !== undefined) {
      return { ...compact, id: recordingId };
    }
  }
  if (options?.includeVisual === true && isVisualT3McpTool(resolved)) {
    const visual = readVisualMetadataRecord(value);
    if (visual.failed) {
      return { ...compact, isError: true };
    }
    const images = toolOutputImages(value).flatMap((image) =>
      hasValidImageBase64Data(image.data)
        ? [{ type: "image" as const, mimeType: image.mimeType, data: image.data }]
        : [],
    );
    const metadata =
      visual.record === undefined
        ? undefined
        : sanitizeVisualToolMetadata(visual.record, resolved, images.length > 0);
    if (resolved === DEVICE_SCREENSHOT_TOOL_NAME || resolved === HTML_PREVIEW_TOOL_NAME) {
      if (images.length === 0) return compact === undefined ? undefined : { ...compact };
      return {
        ...compact,
        content: images,
        ...(metadata === undefined ? {} : { structuredContent: metadata }),
      };
    }
    if (images.length > 0) {
      return {
        ...compact,
        content: images,
        ...(metadata === undefined ? {} : { structuredContent: metadata }),
      };
    }
    if (metadata !== undefined) {
      return compact === undefined ? metadata : { ...metadata, ...compact };
    }
  }
  return compact === undefined ? undefined : { ...compact };
}

/** Accept app references only when server and tool match the item, so tools cannot impersonate another app source. */
export function mcpAppFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): McpAppReference | undefined {
  const app = compactDynamicToolOutput(item.output)?.[MCP_APP_OUTPUT_KEY];
  return app !== undefined &&
    (item.toolName === `${app.server}.${app.tool}` ||
      item.toolName === claudeMcpToolName(app.server, app.tool))
    ? app
    : undefined;
}

// A superset of every needle below, so most outputs are rejected by this single scan.
const FAILURE_HINT =
  /enoent|no such|no files found|not found|commandnotfound|not recognized|cannot (?:find path|be found)|exit/i;

/** Some providers report completion even when command output describes a failure. */
export function toolOutputIndicatesFailure(text: string): boolean {
  return (
    FAILURE_HINT.test(text) &&
    (/file not found|no files found|enoent|no such file|commandnotfoundexception|command not found|is not recognized as the name of a cmdlet|a parameter cannot be found that matches parameter name/i.test(
      text,
    ) ||
      (/cannot find path/i.test(text) && /because it does not exist/i.test(text)) ||
      (/is not recognized/i.test(text) && /the term '/i.test(text)) ||
      /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
      /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text))
  );
}

/** Whether a command failed. A reported exit code outranks text in its output. */
export function commandIndicatesFailure(command: {
  readonly exitCode?: number | undefined;
  readonly outputIndicatesFailure?: boolean | undefined;
  readonly output?: string | undefined;
}): boolean {
  if (command.exitCode !== undefined) return command.exitCode !== 0;
  return (
    command.outputIndicatesFailure === true ||
    (command.output !== undefined && toolOutputIndicatesFailure(command.output.slice(0, 32_768)))
  );
}

export interface ToolOutputImage {
  readonly mimeType: string;
  readonly data?: string;
}

/** Raster types only, so agent SVG/HTML cannot be served inline. */
export function readToolOutputImage(block: unknown): ToolOutputImage | null {
  if (!Predicate.isObject(block) || block.type !== "image") return null;
  const source = Predicate.isObject(block.source) ? block.source : undefined;
  if (source !== undefined && source.type !== "base64") return null;
  const mimeType = source === undefined ? block.mimeType : source.media_type;
  const data = source === undefined ? block.data : source.data;
  if (typeof mimeType !== "string" || !isProviderSendTurnSupportedImageMimeType(mimeType)) {
    return null;
  }
  const image = { mimeType: mimeType.toLowerCase() };
  return typeof data === "string" ? { ...image, data } : image;
}

function outputBlocks(value: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(value)) return value;
  if (Predicate.isObject(value) && Array.isArray(value.content)) return value.content;
  return [value];
}

export const MAX_TOOL_OUTPUT_IMAGES = 8;

export const MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH =
  Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 3) * 4;

export function toolOutputImageBlocks(value: unknown): ReadonlyArray<unknown> {
  const blocks: unknown[] = [];
  for (const block of outputBlocks(value)) {
    if (readToolOutputImage(block) === null) continue;
    blocks.push(block);
    if (blocks.length === MAX_TOOL_OUTPUT_IMAGES) break;
  }
  return blocks;
}

/** Order defines the shared tool-output-image asset index. */
export function toolOutputImages(value: unknown): ReadonlyArray<ToolOutputImage> {
  return toolOutputImageBlocks(value).flatMap((block) => readToolOutputImage(block) ?? []);
}

export function mcpToolResultOutput(result: {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
}): unknown {
  const structuredContent =
    (Array.isArray(result.structuredContent) || Predicate.isObject(result.structuredContent)) &&
    Object.keys(result.structuredContent).length === 0
      ? undefined
      : result.structuredContent;
  if (structuredContent != null && toolOutputImages(result.content).length > 0) {
    return { content: result.content, structuredContent };
  }
  return structuredContent ?? result.content;
}

export function omitToolOutputImageData(value: unknown): unknown {
  const omit = (block: unknown) => {
    const image = readToolOutputImage(block);
    return image?.data === undefined ? block : { type: "image", mimeType: image.mimeType };
  };
  if (Array.isArray(value)) return value.map(omit);
  if (Predicate.isObject(value) && Array.isArray(value.content)) {
    return { ...value, content: value.content.map(omit) };
  }
  return omit(value);
}
