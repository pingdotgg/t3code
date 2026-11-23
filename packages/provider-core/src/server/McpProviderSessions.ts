// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing keeps page matching bounded without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import type { ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

// Other providers may never consume these references.
const MAX_KEPT_HTML_RENDERS = 64;
const MAX_KEPT_TOOL_RESULTS = 64;

// Antigravity truncates long string arguments to a marked tail of at most 8,000 characters.
const BOUNDED_TEXT_MARKER = "[Earlier output truncated]\n\n";
const KEPT_TEXT_END_LENGTH = 8_000;
const TRUNCATABLE_FIELD_MIN_LENGTH = 256;
const MAX_TRUNCATABLE_FIELDS = 8;

interface KeptHtmlRender {
  readonly path: string | undefined;
  readonly title: string;
  readonly height: number;
  readonly htmlLength: number;
  readonly htmlHash: string;
  readonly htmlEnd: string;
  readonly reference: HtmlRenderReference;
}

interface KeptStringField {
  readonly length: number;
  readonly end: string;
}

interface KeptToolResult {
  readonly toolName: string;
  readonly inputHash: string;
  readonly fieldHashes: ReadonlyMap<string, string> | undefined;
  readonly stringTails: ReadonlyMap<string, KeptStringField> | undefined;
  readonly outputJson: string;
  readonly output: Record<string, unknown>;
}

const hashText = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

const copyStringTail = (text: string) =>
  // Copy the tail so its backing storage cannot retain the entire input string.
  Buffer.from(text.slice(-KEPT_TEXT_END_LENGTH), "utf16le").toString("utf16le");

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
    .join(",")}}`;
};

const normalizeToolInput = (input: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(input) || Array.isArray(input)) {
    return {};
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    // Antigravity adds `toolSummary` to ACP tool call inputs without sending it to T3's MCP server.
    if (key === "toolSummary" || value === undefined) continue;
    normalized[key] = value;
  }
  return normalized;
};

const hashToolInput = (normalized: Record<string, unknown>): string =>
  hashText(canonicalJson(normalized));

const extractTruncatableFields = (
  normalized: Record<string, unknown>,
): {
  readonly fieldHashes: ReadonlyMap<string, string> | undefined;
  readonly stringTails: ReadonlyMap<string, KeptStringField> | undefined;
} => {
  const stringTails = new Map<string, KeptStringField>();
  for (const [key, value] of Object.entries(normalized)) {
    if (typeof value === "string" && value.length > TRUNCATABLE_FIELD_MIN_LENGTH) {
      stringTails.set(key, { length: value.length, end: copyStringTail(value) });
      if (stringTails.size >= MAX_TRUNCATABLE_FIELDS) break;
    }
  }
  if (stringTails.size === 0) {
    return { fieldHashes: undefined, stringTails: undefined };
  }
  const fieldHashes = new Map<string, string>();
  for (const [key, value] of Object.entries(normalized)) {
    fieldHashes.set(key, hashText(canonicalJson(value)));
  }
  return { fieldHashes, stringTails };
};

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    readonly recordHtmlRender: (
      threadId: ThreadId,
      input: {
        readonly html: string;
        readonly path?: string | undefined;
        readonly title: string;
        readonly height: number;
      },
      reference: HtmlRenderReference,
    ) => Effect.Effect<void>;
    // A reported attachment consumes that exact page; otherwise the oldest page for a path, or a
    // unique inline match.
    readonly takeHtmlRender: (
      threadId: ThreadId,
      input: PageInput,
      reported?: HtmlRenderReference,
    ) => Effect.Effect<HtmlRenderReference | undefined>;
    readonly recordToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      output: Record<string, unknown>,
    ) => Effect.Effect<void>;
    readonly takeToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      reported?: Record<string, unknown>,
    ) => Effect.Effect<Record<string, unknown> | undefined>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

interface PageInput {
  readonly html?: unknown;
  readonly path?: unknown;
  readonly title?: unknown;
  readonly height?: unknown;
}

const matchingPageIndex = (kept: ReadonlyArray<KeptHtmlRender>, input: PageInput): number => {
  const height =
    typeof input.height === "string" && input.height.trim() !== ""
      ? Number(input.height)
      : input.height;
  const sameFrame = (page: KeptHtmlRender) => page.title === input.title && page.height === height;
  const path = input.path;
  // The handler refuses a call with both sources, so it published nothing to recover. Its decoder
  // reads null as an omitted source.
  if (path !== undefined && path !== null && input.html !== undefined && input.html !== null) {
    return -1;
  }
  if (typeof path === "string" && path.length > 0) {
    // An edited file is published again under the same path; completions arrive in publish order.
    return kept.findIndex((page) => page.path === path && sameFrame(page));
  }
  const html = input.html;
  if (typeof html !== "string" || html.length === 0) {
    return -1;
  }
  const htmlHash = hashText(html);
  const tail = html.startsWith(BOUNDED_TEXT_MARKER)
    ? html.slice(BOUNDED_TEXT_MARKER.length)
    : undefined;
  const matches = kept.flatMap((page, index) =>
    page.path === undefined &&
    sameFrame(page) &&
    (page.htmlHash === htmlHash ||
      (tail !== undefined &&
        tail.length > 0 &&
        tail.length < page.htmlLength &&
        page.htmlEnd.endsWith(tail)))
      ? [index]
      : [],
  );
  // Identical pages are interchangeable, so repeats are taken in publish order.
  if (matches.length > 1 && matches.every((index) => kept[index]!.htmlHash === htmlHash)) {
    return matches[0]!;
  }
  return matches.length === 1 ? matches[0]! : -1;
};

const matchingToolResultIndex = (
  kept: ReadonlyArray<KeptToolResult>,
  toolName: string,
  input: unknown,
  reported?: Record<string, unknown>,
): number => {
  const normalized = normalizeToolInput(input);
  const inputHash = hashToolInput(normalized);
  if (reported !== undefined) {
    const reportedJson = canonicalJson(reported);
    const exactBoth = kept.findIndex(
      (entry) =>
        entry.toolName === toolName &&
        entry.inputHash === inputHash &&
        entry.outputJson === reportedJson,
    );
    if (exactBoth !== -1) return exactBoth;
    const byOutput = kept.findIndex(
      (entry) => entry.toolName === toolName && entry.outputJson === reportedJson,
    );
    if (byOutput !== -1) return byOutput;
  }
  const exactInput = kept.findIndex(
    (entry) => entry.toolName === toolName && entry.inputHash === inputHash,
  );
  if (exactInput !== -1) {
    return exactInput;
  }
  const keys = Object.keys(normalized);
  const truncatedKeys = new Set(
    keys.filter((key) => {
      const value = normalized[key];
      return typeof value === "string" && value.startsWith(BOUNDED_TEXT_MARKER);
    }),
  );
  if (truncatedKeys.size === 0) {
    return -1;
  }
  const nonTruncatedHashes = new Map<string, string>();
  for (const key of keys) {
    if (!truncatedKeys.has(key)) {
      nonTruncatedHashes.set(key, hashText(canonicalJson(normalized[key])));
    }
  }
  const matches = kept.flatMap((entry, index) => {
    if (
      entry.toolName !== toolName ||
      entry.fieldHashes === undefined ||
      entry.stringTails === undefined ||
      entry.fieldHashes.size !== keys.length
    ) {
      return [];
    }
    for (const [key, fieldHash] of nonTruncatedHashes) {
      if (entry.fieldHashes.get(key) !== fieldHash) return [];
    }
    for (const key of truncatedKeys) {
      const value = normalized[key];
      const recorded = entry.stringTails.get(key);
      if (typeof value !== "string" || recorded === undefined) return [];
      const tail = value.slice(BOUNDED_TEXT_MARKER.length);
      if (tail.length === 0 || tail.length >= recorded.length || !recorded.end.endsWith(tail)) {
        return [];
      }
    }
    return [index];
  });
  if (
    matches.length > 1 &&
    matches.every((index) => kept[index]!.inputHash === kept[matches[0]!]!.inputHash)
  ) {
    return matches[0]!;
  }
  return matches.length === 1 ? matches[0]! : -1;
};

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptHtmlRender>>());
  const toolResults = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptToolResult>>());
  return McpProviderSessions.of({
    set: Effect.fn("McpProviderSessions.set")(function* (config) {
      const current = yield* Ref.get(sessions);
      if (current.get(config.threadId)?.providerSessionId !== config.providerSessionId) {
        yield* Ref.update(htmlRenders, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
        yield* Ref.update(toolResults, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
      }
      yield* Ref.update(sessions, (current) => new Map(current).set(config.threadId, config));
    }),
    read: Effect.fn("McpProviderSessions.read")(function (threadId) {
      return Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId)));
    }),
    clear: Effect.fn("McpProviderSessions.clear")(function (threadId) {
      return Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(htmlRenders, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          }),
        ),
        Effect.andThen(
          Ref.update(toolResults, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          }),
        ),
      );
    }),
    recordHtmlRender: Effect.fn("McpProviderSessions.recordHtmlRender")(
      function (threadId, input, reference) {
        return Ref.update(htmlRenders, (current) =>
          new Map(current).set(
            threadId,
            [
              ...(current.get(threadId) ?? []),
              {
                path: input.path,
                title: input.title,
                height: input.height,
                htmlLength: input.html.length,
                htmlHash: hashText(input.html),
                htmlEnd: copyStringTail(input.html),
                reference,
              },
            ].slice(-MAX_KEPT_HTML_RENDERS),
          ),
        );
      },
    ),
    takeHtmlRender: Effect.fn("McpProviderSessions.takeHtmlRender")(
      function (threadId, input, reported) {
        return Ref.modify(htmlRenders, (current) => {
          const kept = current.get(threadId) ?? [];
          const index =
            reported === undefined
              ? matchingPageIndex(kept, input)
              : kept.findIndex((page) => page.reference.attachmentId === reported.attachmentId);
          if (index === -1) {
            return [undefined, current];
          }
          const rest = kept.filter((_, keptIndex) => keptIndex !== index);
          const next = new Map(current);
          if (rest.length === 0) {
            next.delete(threadId);
          } else {
            next.set(threadId, rest);
          }
          return [kept[index]!.reference, next];
        });
      },
    ),
    recordToolResult: Effect.fn("McpProviderSessions.recordToolResult")(
      function (threadId, toolName, input, output) {
        const canonicalTool = resolveT3McpToolId(toolName) ?? toolName;
        const normalized = normalizeToolInput(input);
        const { fieldHashes, stringTails } = extractTruncatableFields(normalized);
        const entry: KeptToolResult = {
          toolName: canonicalTool,
          inputHash: hashToolInput(normalized),
          fieldHashes,
          stringTails,
          outputJson: canonicalJson(output),
          output,
        };
        return Ref.update(toolResults, (current) =>
          new Map(current).set(
            threadId,
            [...(current.get(threadId) ?? []), entry].slice(-MAX_KEPT_TOOL_RESULTS),
          ),
        );
      },
    ),
    takeToolResult: Effect.fn("McpProviderSessions.takeToolResult")(
      function (threadId, toolName, input, reported) {
        const canonicalTool = resolveT3McpToolId(toolName) ?? toolName;
        return Ref.modify(toolResults, (current) => {
          const kept = current.get(threadId) ?? [];
          const index = matchingToolResultIndex(kept, canonicalTool, input, reported);
          if (index === -1) {
            return [undefined, current];
          }
          const rest = kept.filter((_, keptIndex) => keptIndex !== index);
          const next = new Map(current);
          if (rest.length === 0) {
            next.delete(threadId);
          } else {
            next.set(threadId, rest);
          }
          return [kept[index]!.output, next];
        });
      },
    ),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
