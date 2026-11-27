// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing keeps page matching bounded without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import type { ProviderApprovalPushHooks, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import {
  HTML_PREVIEW_TOOL_NAME,
  isVisualT3McpTool,
  PREVIEW_SNAPSHOT_TOOL_NAME,
} from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";
import { randomUuidV4 } from "./randomUuid.ts";

// Other providers may never consume these references.
const MAX_KEPT_HTML_RENDERS = 64;
const MAX_KEPT_TOOL_RESULTS = 64;
const MAX_KEPT_TOOL_RESULT_BYTES_PER_THREAD = 16 * 1024 * 1024;
const MAX_KEPT_TOOL_RESULT_BYTES_TOTAL = 32 * 1024 * 1024;
// Image/snapshot recoveries exceed this; small metadata entries stay exempt from byte eviction.
const HEAVY_TOOL_RESULT_BYTES = 16 * 1024;
// Bound per-thread eviction guards so pathological turns stay O(1) while preserving safety.
const MAX_EVICTED_VISUAL_KEYS_PER_THREAD = 64;
const MAX_EVICTED_HTML_PREVIEW_TAILS_PER_THREAD = 8;
// A request whose call never comes back for its answer stays until the session ends.
const MAX_KEPT_APPROVAL_REQUESTS = 8;

// Antigravity truncates long HTML arguments to a marked tail of at most 8,000 characters.
const BOUNDED_TEXT_MARKER = "[Earlier output truncated]\n\n";
const KEPT_HTML_END_LENGTH = 8_000;
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

interface KeptHtmlRender {
  readonly path: string | undefined;
  readonly title: string;
  readonly height: number;
  readonly htmlLength: number;
  readonly htmlHash: string;
  readonly htmlEnd: string;
  readonly reference: HtmlRenderReference;
}

interface KeptHtmlPreviewTail {
  readonly restInputHash: string;
  readonly htmlLength: number;
  readonly htmlEnd: string;
}

interface KeptToolResult {
  readonly seq: number;
  readonly toolName: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly approxBytes: number;
  readonly htmlTailMatch?: KeptHtmlPreviewTail;
  readonly output: Record<string, unknown>;
}

interface ThreadEvictedVisualKeys {
  readonly keys: ReadonlySet<string>;
  readonly allKeys: boolean;
  readonly htmlPreviewTails: ReadonlyArray<KeptHtmlPreviewTail>;
  readonly allHtmlPreviewTails: boolean;
}

/** What one of T3's own MCP tools is asking the person behind a thread to approve. */
export interface T3ApprovalRequest {
  /** The whole question, as the provider's client hands it on. */
  readonly message: string;
  readonly pushHooks?: ProviderApprovalPushHooks | undefined;
  /** What an answer is given for; an answer to another state does not count for this request. */
  readonly state?: string | undefined;
}

/** A request T3 is waiting on, and what the person answered once an adapter has shown it. */
export interface KeptApprovalRequest extends T3ApprovalRequest {
  readonly id: string;
  readonly approved?: boolean | undefined;
}

interface ToolResultState {
  readonly entries: ReadonlyMap<ThreadId, ReadonlyArray<KeptToolResult>>;
  readonly evictedVisualByThread: ReadonlyMap<ThreadId, ThreadEvictedVisualKeys>;
  readonly epochs: ReadonlyMap<ThreadId, number>;
  readonly totalBytes: number;
  readonly nextSeq: number;
}

const hashText = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

export const hashToolInput = (input: unknown): string => {
  const normalized = Predicate.isObject(input) && !Array.isArray(input) ? input : {};
  return hashText(stableStringify(normalized));
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
    readonly toolResultEpoch: (threadId: ThreadId) => Effect.Effect<number>;
    readonly recordToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      output: Record<string, unknown>,
      options?: {
        readonly providerSessionId?: string | undefined;
        readonly epoch?: number | undefined;
      },
    ) => Effect.Effect<void>;
    readonly recordSkippedToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      options?: {
        readonly providerSessionId?: string | undefined;
        readonly epoch?: number | undefined;
      },
    ) => Effect.Effect<void>;
    // A reported output consumes an exact (tool, input, output) match, or for preview_snapshot a
    // unique compatible untruncated capture; input-only recovery consumes a match only when all
    // matching candidates carry the same output and no matching visual entry was evicted/skipped.
    readonly takeToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      reported?: Record<string, unknown>,
    ) => Effect.Effect<Record<string, unknown> | undefined>;
    readonly clearToolResults: (threadId: ThreadId) => Effect.Effect<void>;
    // Adapters that recover dropped visual/snapshot MCP outputs opt their provider instances in so
    // non-recovering providers skip screenshot encoding and caching altogether.
    readonly recoversVisualToolResults: (
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<void>;
    readonly doesRecoverVisualToolResults: (
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<boolean>;
    // The provider's client hands an adapter a server name and the message. This is how the
    // adapter learns a request is T3's own, and what it names, from T3 itself: kept from when
    // T3 asks until it has the answer. Recording returns the request's own id, and only that id
    // forgets it: two calls may ask the same thing at once, and one may outlive its session.
    readonly recordApprovalRequest: (
      threadId: ThreadId,
      request: T3ApprovalRequest,
    ) => Effect.Effect<string>;
    readonly findApprovalRequest: (
      threadId: ThreadId,
      message: string,
    ) => Effect.Effect<KeptApprovalRequest | undefined>;
    readonly forgetApprovalRequest: (threadId: ThreadId, id: string) => Effect.Effect<void>;
    // An adapter that shows T3's own requests says so for its provider instance and passes on
    // each answer the person gave in the app. It is handed the message and no id, so the answer
    // counts for every request of the thread asking `message` that has none yet. For those
    // instances that answer, not the client's reply, is what T3 goes by.
    readonly showsApprovalRequests: (providerInstanceId: ProviderInstanceId) => Effect.Effect<void>;
    readonly areApprovalRequestsShown: (
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<boolean>;
    readonly answerApprovalRequests: (
      threadId: ThreadId,
      message: string,
      approved: boolean,
    ) => Effect.Effect<void>;
    // Ends the request and returns it as it was, with the person's answer if one was given.
    readonly takeApprovalRequest: (
      threadId: ThreadId,
      id: string,
    ) => Effect.Effect<KeptApprovalRequest | undefined>;
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

const htmlPreviewTailForRecord = (
  toolName: string,
  input: unknown,
): KeptHtmlPreviewTail | undefined => {
  if (toolName !== HTML_PREVIEW_TOOL_NAME || !Predicate.isObject(input) || Array.isArray(input)) {
    return undefined;
  }
  const html = input.html;
  if (typeof html !== "string" || html.length <= KEPT_HTML_END_LENGTH) {
    return undefined;
  }
  const { html: _html, ...rest } = input as Record<string, unknown>;
  return {
    restInputHash: hashToolInput(rest),
    htmlLength: html.length,
    // Copy the tail so its backing storage cannot retain the entire HTML string.
    htmlEnd: Buffer.from(html.slice(-KEPT_HTML_END_LENGTH), "utf16le").toString("utf16le"),
  };
};

const htmlPreviewTruncatedQuery = (
  toolName: string,
  input: unknown,
): { readonly restInputHash: string; readonly tail: string } | undefined => {
  if (toolName !== HTML_PREVIEW_TOOL_NAME || !Predicate.isObject(input) || Array.isArray(input)) {
    return undefined;
  }
  const html = input.html;
  if (typeof html !== "string" || !html.startsWith(BOUNDED_TEXT_MARKER)) {
    return undefined;
  }
  const tail = html.slice(BOUNDED_TEXT_MARKER.length);
  if (tail.length === 0) return undefined;
  const { html: _html, ...rest } = input as Record<string, unknown>;
  return { restInputHash: hashToolInput(rest), tail };
};

const evictionKeyFor = (toolName: string, inputHash: string) => `${toolName}\0${inputHash}`;

const markEvictedVisualKey = (
  evictedVisualByThread: Map<ThreadId, ThreadEvictedVisualKeys>,
  threadId: ThreadId,
  toolName: string,
  inputHash: string,
  htmlTailMatch: KeptHtmlPreviewTail | undefined,
): void => {
  // Only visual T3 MCP tools (recorded for opted-in ACP instances) need eviction ambiguity guards;
  // non-visual tools on other providers stay untouched and keep zero extra state.
  if (!isVisualT3McpTool(toolName)) return;
  const current = evictedVisualByThread.get(threadId);
  const key = evictionKeyFor(toolName, inputHash);

  let keys = current?.keys ?? EMPTY_STRING_SET;
  let allKeys = current?.allKeys ?? false;
  let changed = false;
  if (!allKeys && !keys.has(key)) {
    changed = true;
    if (keys.size >= MAX_EVICTED_VISUAL_KEYS_PER_THREAD) {
      allKeys = true;
      keys = EMPTY_STRING_SET;
    } else {
      const nextKeys = new Set(keys);
      nextKeys.add(key);
      keys = nextKeys;
    }
  }

  let htmlPreviewTails = current?.htmlPreviewTails ?? [];
  let allHtmlPreviewTails = current?.allHtmlPreviewTails ?? false;
  if (htmlTailMatch !== undefined && !allHtmlPreviewTails) {
    const alreadyTracked = htmlPreviewTails.some(
      (existing) =>
        existing.restInputHash === htmlTailMatch.restInputHash &&
        existing.htmlLength === htmlTailMatch.htmlLength &&
        existing.htmlEnd === htmlTailMatch.htmlEnd,
    );
    if (!alreadyTracked) {
      changed = true;
      if (htmlPreviewTails.length >= MAX_EVICTED_HTML_PREVIEW_TAILS_PER_THREAD) {
        allHtmlPreviewTails = true;
        htmlPreviewTails = [];
      } else {
        htmlPreviewTails = [...htmlPreviewTails, htmlTailMatch];
      }
    }
  }

  if (changed) {
    evictedVisualByThread.set(threadId, {
      keys,
      allKeys,
      htmlPreviewTails,
      allHtmlPreviewTails,
    });
  }
};

const isEvictedExactVisualKey = (
  evicted: ThreadEvictedVisualKeys | undefined,
  toolName: string,
  inputHash: string,
): boolean =>
  isVisualT3McpTool(toolName) &&
  evicted !== undefined &&
  (evicted.allKeys || evicted.keys.has(evictionKeyFor(toolName, inputHash)));

const isEvictedHtmlPreviewTail = (
  evicted: ThreadEvictedVisualKeys | undefined,
  truncatedHtml: { readonly restInputHash: string; readonly tail: string },
): boolean =>
  evicted !== undefined &&
  (evicted.allHtmlPreviewTails ||
    evicted.htmlPreviewTails.some(
      (tail) =>
        tail.restInputHash === truncatedHtml.restInputHash &&
        truncatedHtml.tail.length < tail.htmlLength &&
        tail.htmlEnd.endsWith(truncatedHtml.tail),
    ));

const previewSnapshotMetaRecord = (
  value: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (value.isError === true) return undefined;
  const nested = value.structuredContent;
  if (Predicate.isObject(nested) && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return value;
};

const isUntruncatedString = (value: unknown): value is string =>
  typeof value === "string" && !value.includes(BOUNDED_TEXT_MARKER);

const isCompatiblePreviewSnapshotReport = (
  reported: Record<string, unknown>,
  captured: Record<string, unknown>,
): boolean => {
  const reportedMeta = previewSnapshotMetaRecord(reported);
  const capturedMeta = previewSnapshotMetaRecord(captured);
  if (reportedMeta === undefined || capturedMeta === undefined) return false;
  if (Array.isArray(reported.content)) {
    if (
      !Array.isArray(captured.content) ||
      stableStringify(reported.content) !== stableStringify(captured.content)
    ) {
      return false;
    }
  }
  const hasUrl = isUntruncatedString(reportedMeta.url);
  const hasPath = isUntruncatedString(reportedMeta.screenshotPath);
  if (!hasUrl && !hasPath) return false;
  if (hasUrl && capturedMeta.url !== reportedMeta.url) return false;
  if (hasPath && capturedMeta.screenshotPath !== reportedMeta.screenshotPath) return false;
  for (const field of ["title", "visibleText", "accessibilityTree"] as const) {
    if (isUntruncatedString(reportedMeta[field]) && capturedMeta[field] !== reportedMeta[field]) {
      return false;
    }
  }
  if (Predicate.isObject(reportedMeta.screenshot) && !Array.isArray(reportedMeta.screenshot)) {
    if (!Predicate.isObject(capturedMeta.screenshot) || Array.isArray(capturedMeta.screenshot)) {
      return false;
    }
    const reportedShot = reportedMeta.screenshot as Record<string, unknown>;
    const capturedShot = capturedMeta.screenshot as Record<string, unknown>;
    for (const field of ["mimeType", "width", "height"] as const) {
      if (reportedShot[field] !== undefined && capturedShot[field] !== reportedShot[field]) {
        return false;
      }
    }
  }
  return true;
};

const matchingToolResultIndex = (
  kept: ReadonlyArray<KeptToolResult>,
  toolName: string,
  input: unknown,
  reported: Record<string, unknown> | undefined,
  evicted: ThreadEvictedVisualKeys | undefined,
): number => {
  const inputHash = hashToolInput(input);
  const truncatedHtml = htmlPreviewTruncatedQuery(toolName, input);
  const matchesTruncatedHtml = (entry: KeptToolResult) =>
    truncatedHtml !== undefined &&
    entry.toolName === toolName &&
    entry.htmlTailMatch !== undefined &&
    entry.htmlTailMatch.restInputHash === truncatedHtml.restInputHash &&
    truncatedHtml.tail.length < entry.htmlTailMatch.htmlLength &&
    entry.htmlTailMatch.htmlEnd.endsWith(truncatedHtml.tail);

  const pickUniqueOrIdentical = (matches: ReadonlyArray<number>): number => {
    if (matches.length === 0) return -1;
    if (matches.length === 1) return matches[0]!;
    // Identical outputs (e.g. repeated send_to_user calls) are interchangeable; differing outputs
    // (e.g. parallel identical-input delegate_task calls) stay unclaimed to avoid misattribution.
    const firstOutput = kept[matches[0]!]!.outputHash;
    return matches.every((index) => kept[index]!.outputHash === firstOutput) ? matches[0]! : -1;
  };

  if (reported !== undefined) {
    const reportedHash = hashText(stableStringify(reported));
    const exact = kept.findIndex(
      (entry) =>
        entry.toolName === toolName &&
        entry.inputHash === inputHash &&
        entry.outputHash === reportedHash,
    );
    if (exact !== -1) return exact;
    if (truncatedHtml !== undefined) {
      const exactTail = kept.findIndex(
        (entry) => matchesTruncatedHtml(entry) && entry.outputHash === reportedHash,
      );
      if (exactTail !== -1) return exactTail;
    }
    if (
      toolName === PREVIEW_SNAPSHOT_TOOL_NAME &&
      !isEvictedExactVisualKey(evicted, toolName, inputHash)
    ) {
      const compatible = kept.flatMap((entry, index) =>
        entry.toolName === toolName &&
        entry.inputHash === inputHash &&
        isCompatiblePreviewSnapshotReport(reported, entry.output)
          ? [index]
          : [],
      );
      return pickUniqueOrIdentical(compatible);
    }
    return -1;
  }

  if (!isEvictedExactVisualKey(evicted, toolName, inputHash)) {
    const exactMatches = kept.flatMap((entry, index) =>
      entry.toolName === toolName && entry.inputHash === inputHash ? [index] : [],
    );
    if (exactMatches.length > 0) {
      return pickUniqueOrIdentical(exactMatches);
    }
  }
  if (truncatedHtml !== undefined && !isEvictedHtmlPreviewTail(evicted, truncatedHtml)) {
    const tailMatches = kept.flatMap((entry, index) =>
      matchesTruncatedHtml(entry) ? [index] : [],
    );
    return pickUniqueOrIdentical(tailMatches);
  }
  return -1;
};

const sumEntryBytes = (entries: ReadonlyArray<KeptToolResult>): number =>
  entries.reduce((total, entry) => total + entry.approxBytes, 0);

const clearThreadToolResults = (state: ToolResultState, threadId: ThreadId): ToolResultState => {
  const removedBytes = sumEntryBytes(state.entries.get(threadId) ?? []);
  const entries = new Map(state.entries);
  entries.delete(threadId);
  const evictedVisualByThread = new Map(state.evictedVisualByThread);
  evictedVisualByThread.delete(threadId);
  const epochs = new Map(state.epochs);
  epochs.set(threadId, (state.epochs.get(threadId) ?? 0) + 1);
  return {
    ...state,
    entries,
    evictedVisualByThread,
    epochs,
    totalBytes: Math.max(0, state.totalBytes - removedBytes),
  };
};

const enforceToolResultBudgets = (
  entries: Map<ThreadId, ReadonlyArray<KeptToolResult>>,
  evictedVisualByThread: Map<ThreadId, ThreadEvictedVisualKeys>,
  threadId: ThreadId,
  insertedSeq: number,
  initialTotalBytes: number,
): number => {
  let totalBytes = initialTotalBytes;
  const threadList = [...(entries.get(threadId) ?? [])];
  let threadBytes = sumEntryBytes(threadList);
  while (threadList.length > 1 && threadBytes > MAX_KEPT_TOOL_RESULT_BYTES_PER_THREAD) {
    const heavyIndex = threadList.findIndex(
      (candidate) =>
        candidate.seq !== insertedSeq && candidate.approxBytes > HEAVY_TOOL_RESULT_BYTES,
    );
    if (heavyIndex === -1) break;
    const [removed] = threadList.splice(heavyIndex, 1);
    if (removed !== undefined) {
      threadBytes -= removed.approxBytes;
      totalBytes -= removed.approxBytes;
      markEvictedVisualKey(
        evictedVisualByThread,
        threadId,
        removed.toolName,
        removed.inputHash,
        removed.htmlTailMatch,
      );
    }
  }
  entries.set(threadId, threadList);

  const dropOldestGlobal = (heavyOnly: boolean): number | undefined => {
    let oldestThread: ThreadId | undefined;
    let oldestIndex = -1;
    let oldestSeq = Number.POSITIVE_INFINITY;
    for (const [candidateThread, list] of entries) {
      for (let index = 0; index < list.length; index += 1) {
        const candidate = list[index]!;
        if (
          candidate.seq !== insertedSeq &&
          (!heavyOnly || candidate.approxBytes > HEAVY_TOOL_RESULT_BYTES) &&
          candidate.seq < oldestSeq
        ) {
          oldestSeq = candidate.seq;
          oldestThread = candidateThread;
          oldestIndex = index;
        }
      }
    }
    if (oldestThread === undefined || oldestIndex === -1) return undefined;
    const targetList = entries.get(oldestThread)!;
    const removed = targetList[oldestIndex]!;
    markEvictedVisualKey(
      evictedVisualByThread,
      oldestThread,
      removed.toolName,
      removed.inputHash,
      removed.htmlTailMatch,
    );
    const nextList = targetList.filter((_, index) => index !== oldestIndex);
    if (nextList.length === 0) {
      entries.delete(oldestThread);
    } else {
      entries.set(oldestThread, nextList);
    }
    return removed.approxBytes;
  };
  while (totalBytes > MAX_KEPT_TOOL_RESULT_BYTES_TOTAL) {
    const evictedBytes = dropOldestGlobal(true) ?? dropOldestGlobal(false);
    if (evictedBytes === undefined) break;
    totalBytes -= evictedBytes;
  }
  return Math.max(0, totalBytes);
};

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptHtmlRender>>());
  const toolResultState = yield* Ref.make<ToolResultState>({
    entries: new Map(),
    evictedVisualByThread: new Map(),
    epochs: new Map(),
    totalBytes: 0,
    nextSeq: 0,
  });
  const approvalRequests = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptApprovalRequest>>());
  const approvalRequestsShownBy = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());
  const visualToolResultsRecoveredBy = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());
  const withoutThread = <A>(kept: ReadonlyMap<ThreadId, A>, threadId: ThreadId) => {
    const next = new Map(kept);
    next.delete(threadId);
    return next;
  };
  const takeApprovalRequest = (threadId: ThreadId, id: string) =>
    Ref.modify(approvalRequests, (current) => {
      const kept = current.get(threadId);
      const taken = kept?.find((candidate) => candidate.id === id);
      if (kept === undefined || taken === undefined) return [undefined, current];
      const rest = kept.filter((candidate) => candidate !== taken);
      return [
        taken,
        rest.length === 0 ? withoutThread(current, threadId) : new Map(current).set(threadId, rest),
      ];
    });
  return McpProviderSessions.of({
    set: Effect.fn("McpProviderSessions.set")(function* (config) {
      const current = yield* Ref.get(sessions);
      if (current.get(config.threadId)?.providerSessionId !== config.providerSessionId) {
        yield* Ref.update(htmlRenders, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
        yield* Ref.update(toolResultState, (state) =>
          clearThreadToolResults(state, config.threadId),
        );
        yield* Ref.update(approvalRequests, (kept) => withoutThread(kept, config.threadId));
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
          Ref.update(toolResultState, (state) => clearThreadToolResults(state, threadId)),
        ),
        Effect.andThen(Ref.update(approvalRequests, (kept) => withoutThread(kept, threadId))),
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
                // Copy the tail so its backing storage cannot retain the entire HTML string.
                htmlEnd: Buffer.from(input.html.slice(-KEPT_HTML_END_LENGTH), "utf16le").toString(
                  "utf16le",
                ),
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
    toolResultEpoch: Effect.fn("McpProviderSessions.toolResultEpoch")(function (threadId) {
      return Ref.get(toolResultState).pipe(Effect.map((state) => state.epochs.get(threadId) ?? 0));
    }),
    recordToolResult: Effect.fn("McpProviderSessions.recordToolResult")(
      function* (threadId, toolName, input, output, options) {
        const providerSessionId = options?.providerSessionId;
        if (providerSessionId !== undefined) {
          const activeSession = (yield* Ref.get(sessions)).get(threadId);
          // A handler finishing after session replacement must not populate the new session.
          if (
            activeSession !== undefined &&
            activeSession.providerSessionId !== providerSessionId
          ) {
            return;
          }
        }
        const canonicalTool = resolveT3McpToolId(toolName) ?? toolName;
        const outputJson = stableStringify(output);
        const inputHash = hashToolInput(input);
        const htmlTailMatch = htmlPreviewTailForRecord(canonicalTool, input);
        const approxBytes =
          Buffer.byteLength(outputJson, "utf8") +
          (htmlTailMatch === undefined ? 0 : htmlTailMatch.htmlEnd.length * 2);
        const expectedEpoch = options?.epoch;
        if (approxBytes > MAX_KEPT_TOOL_RESULT_BYTES_PER_THREAD) {
          yield* Ref.update(toolResultState, (state) => {
            if (
              expectedEpoch !== undefined &&
              (state.epochs.get(threadId) ?? 0) !== expectedEpoch
            ) {
              return state;
            }
            const evictedVisualByThread = new Map(state.evictedVisualByThread);
            markEvictedVisualKey(
              evictedVisualByThread,
              threadId,
              canonicalTool,
              inputHash,
              htmlTailMatch,
            );
            return { ...state, evictedVisualByThread };
          });
          return;
        }
        const outputHash = hashText(outputJson);
        yield* Ref.update(toolResultState, (state) => {
          // A handler finishing after its turn closed must not populate the next turn.
          if (expectedEpoch !== undefined && (state.epochs.get(threadId) ?? 0) !== expectedEpoch) {
            return state;
          }
          const seq = state.nextSeq + 1;
          const entry: KeptToolResult = {
            seq,
            toolName: canonicalTool,
            inputHash,
            outputHash,
            approxBytes,
            ...(htmlTailMatch === undefined ? {} : { htmlTailMatch }),
            output,
          };
          const entries = new Map(state.entries);
          const evictedVisualByThread = new Map(state.evictedVisualByThread);
          const combined = [...(entries.get(threadId) ?? []), entry];
          let totalBytes = state.totalBytes + approxBytes;
          if (combined.length > MAX_KEPT_TOOL_RESULTS) {
            for (const dropped of combined.slice(0, combined.length - MAX_KEPT_TOOL_RESULTS)) {
              totalBytes -= dropped.approxBytes;
              markEvictedVisualKey(
                evictedVisualByThread,
                threadId,
                dropped.toolName,
                dropped.inputHash,
                dropped.htmlTailMatch,
              );
            }
          }
          entries.set(threadId, combined.slice(-MAX_KEPT_TOOL_RESULTS));
          totalBytes = enforceToolResultBudgets(
            entries,
            evictedVisualByThread,
            threadId,
            seq,
            totalBytes,
          );
          return { ...state, entries, evictedVisualByThread, totalBytes, nextSeq: seq };
        });
      },
    ),
    recordSkippedToolResult: Effect.fn("McpProviderSessions.recordSkippedToolResult")(
      function* (threadId, toolName, input, options) {
        const canonicalTool = resolveT3McpToolId(toolName) ?? toolName;
        if (!isVisualT3McpTool(canonicalTool)) return;
        const providerSessionId = options?.providerSessionId;
        if (providerSessionId !== undefined) {
          const activeSession = (yield* Ref.get(sessions)).get(threadId);
          if (
            activeSession !== undefined &&
            activeSession.providerSessionId !== providerSessionId
          ) {
            return;
          }
        }
        const inputHash = hashToolInput(input);
        const htmlTailMatch = htmlPreviewTailForRecord(canonicalTool, input);
        const expectedEpoch = options?.epoch;
        yield* Ref.update(toolResultState, (state) => {
          if (expectedEpoch !== undefined && (state.epochs.get(threadId) ?? 0) !== expectedEpoch) {
            return state;
          }
          const evictedVisualByThread = new Map(state.evictedVisualByThread);
          markEvictedVisualKey(
            evictedVisualByThread,
            threadId,
            canonicalTool,
            inputHash,
            htmlTailMatch,
          );
          return { ...state, evictedVisualByThread };
        });
      },
    ),
    takeToolResult: Effect.fn("McpProviderSessions.takeToolResult")(
      function (threadId, toolName, input, reported) {
        const canonicalTool = resolveT3McpToolId(toolName) ?? toolName;
        return Ref.modify(toolResultState, (state) => {
          const kept = state.entries.get(threadId) ?? [];
          const index = matchingToolResultIndex(
            kept,
            canonicalTool,
            input,
            reported,
            state.evictedVisualByThread.get(threadId),
          );
          if (index === -1) {
            return [undefined, state];
          }
          const removed = kept[index]!;
          const rest = kept.filter((_, keptIndex) => keptIndex !== index);
          const entries = new Map(state.entries);
          if (rest.length === 0) {
            entries.delete(threadId);
          } else {
            entries.set(threadId, rest);
          }
          return [
            removed.output,
            { ...state, entries, totalBytes: Math.max(0, state.totalBytes - removed.approxBytes) },
          ];
        });
      },
    ),
    clearToolResults: Effect.fn("McpProviderSessions.clearToolResults")(function (threadId) {
      return Ref.update(toolResultState, (state) => clearThreadToolResults(state, threadId));
    }),
    recoversVisualToolResults: Effect.fn("McpProviderSessions.recoversVisualToolResults")(
      function (providerInstanceId) {
        return Ref.update(visualToolResultsRecoveredBy, (current) =>
          new Set(current).add(providerInstanceId),
        );
      },
    ),
    doesRecoverVisualToolResults: Effect.fn("McpProviderSessions.doesRecoverVisualToolResults")(
      function (providerInstanceId) {
        return Ref.get(visualToolResultsRecoveredBy).pipe(
          Effect.map((current) => current.has(providerInstanceId)),
        );
      },
    ),
    recordApprovalRequest: Effect.fn("McpProviderSessions.recordApprovalRequest")(
      function (threadId, request) {
        return randomUuidV4.pipe(
          Effect.tap((id) =>
            Ref.update(approvalRequests, (current) =>
              new Map(current).set(
                threadId,
                [...(current.get(threadId) ?? []), { ...request, id }].slice(
                  -MAX_KEPT_APPROVAL_REQUESTS,
                ),
              ),
            ),
          ),
        );
      },
    ),
    findApprovalRequest: Effect.fn("McpProviderSessions.findApprovalRequest")(
      function (threadId, message) {
        return Ref.get(approvalRequests).pipe(
          Effect.map((current) => current.get(threadId)?.find((kept) => kept.message === message)),
        );
      },
    ),
    forgetApprovalRequest: Effect.fn("McpProviderSessions.forgetApprovalRequest")(
      function (threadId, id) {
        return Effect.asVoid(takeApprovalRequest(threadId, id));
      },
    ),
    showsApprovalRequests: Effect.fn("McpProviderSessions.showsApprovalRequests")(
      function (providerInstanceId) {
        return Ref.update(approvalRequestsShownBy, (current) =>
          new Set(current).add(providerInstanceId),
        );
      },
    ),
    areApprovalRequestsShown: Effect.fn("McpProviderSessions.areApprovalRequestsShown")(
      function (providerInstanceId) {
        return Ref.get(approvalRequestsShownBy).pipe(
          Effect.map((current) => current.has(providerInstanceId)),
        );
      },
    ),
    answerApprovalRequests: Effect.fn("McpProviderSessions.answerApprovalRequests")(
      function (threadId, message, approved) {
        return Ref.update(approvalRequests, (current) => {
          const kept = current.get(threadId);
          // A request's first answer stands.
          const waits = (request: KeptApprovalRequest) =>
            request.message === message && request.approved === undefined;
          if (kept === undefined || !kept.some(waits)) return current;
          return new Map(current).set(
            threadId,
            kept.map((request) => (waits(request) ? { ...request, approved } : request)),
          );
        });
      },
    ),
    takeApprovalRequest: Effect.fn("McpProviderSessions.takeApprovalRequest")(takeApprovalRequest),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
