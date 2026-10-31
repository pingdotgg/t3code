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
import { MCP_APP_OUTPUT_KEY, readMcpAppReference, type McpAppReference } from "./mcpApp.ts";
import { resolveT3McpToolId } from "./t3McpToolPresentation.ts";

const MAX_PARSED_BYTES = 16_384;
const MAX_METADATA_BYTES = 8_192;
const MAX_ID_LENGTH = 256;
const MAX_THREADS = 100;
const MAX_CONTENT_BLOCKS = 32;
const MAX_ENVELOPE_DEPTH = 4;
const MAX_ENVELOPE_NODES = 128;
const encoder = new TextEncoder();

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
  const content = value.structuredContent ?? value.content;
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
  }
  const app = output[MCP_APP_OUTPUT_KEY];
  if (app?.csp !== undefined && oversized()) {
    const { csp: _csp, ...rest } = app;
    output[MCP_APP_OUTPUT_KEY] = rest;
  }
  if (oversized()) delete output[MCP_APP_OUTPUT_KEY];
  return Object.keys(output).length === 0 ? undefined : output;
}

export function htmlRenderFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): HtmlRenderReference | undefined {
  if (resolveT3McpToolId(item.toolName) !== HTML_RENDER_TOOL_NAME) return undefined;
  const output = compactDynamicToolOutput(item.output);
  return output?.isError ? undefined : output?.htmlRender;
}

/** Accept app references only when server and tool match the item, so tools cannot impersonate another app source. */
export function mcpAppFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): McpAppReference | undefined {
  const app = compactDynamicToolOutput(item.output)?.[MCP_APP_OUTPUT_KEY];
  return app !== undefined && item.toolName === `${app.server}.${app.tool}` ? app : undefined;
}

/** Some providers report completion even when command output describes a failure. */
export function toolOutputIndicatesFailure(text: string): boolean {
  return (
    /file not found|no files found|enoent|no such file|commandnotfoundexception|command not found|is not recognized as the name of a cmdlet|a parameter cannot be found that matches parameter name/i.test(
      text,
    ) ||
    (/cannot find path/i.test(text) && /because it does not exist/i.test(text)) ||
    (/is not recognized/i.test(text) && /the term '/i.test(text)) ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
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
