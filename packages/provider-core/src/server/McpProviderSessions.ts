// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing keeps page matching bounded without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";
import { randomUuidV4 } from "./randomUuid.ts";

// Other providers may never consume these references.
const MAX_KEPT_HTML_RENDERS = 64;
const MAX_KEPT_TOOL_RESULTS = 64;
// A request whose call never comes back for its answer stays until the session ends. An
// answered one makes room for a new one; one still waiting for the person is never dropped.
export const MAX_KEPT_APPROVAL_REQUESTS = 8;

// Antigravity truncates long HTML arguments to a marked tail of at most 8,000 characters.
const BOUNDED_TEXT_MARKER = "[Earlier output truncated]\n\n";
const KEPT_HTML_END_LENGTH = 8_000;

interface KeptHtmlRender {
  readonly path: string | undefined;
  readonly title: string;
  readonly height: number;
  readonly htmlLength: number;
  readonly htmlHash: string;
  readonly htmlEnd: string;
  readonly reference: HtmlRenderReference;
}

interface KeptToolResult {
  readonly toolName: string;
  readonly inputHash: string;
  readonly outputJson: string;
  readonly output: Record<string, unknown>;
}

/** What one of T3's own MCP tools is asking the person behind a thread to approve. */
export interface T3ApprovalRequest {
  /** The whole question, as the thread shows it and as a provider's client hands it on. */
  readonly message: string;
  /** What an answer is given for: a call asking for the same state again finds this request. */
  readonly state: string;
}

/**
 * How a request ended. "cancelled": without the person's answer, as when its turn ends or is
 * interrupted, or they dismiss it.
 */
export type T3ApprovalAnswer = "accepted" | "declined" | "cancelled";

/** A request T3 is waiting on. `id` names it in the thread and to the provider's client. */
export interface KeptApprovalRequest extends T3ApprovalRequest {
  readonly id: string;
}

interface WaitingApprovalRequest extends KeptApprovalRequest {
  readonly answer: Deferred.Deferred<T3ApprovalAnswer>;
}

type KeptApprovalRequests = Map<ThreadId, ReadonlyArray<WaitingApprovalRequest>>;

interface JoinedRequest {
  readonly request: WaitingApprovalRequest;
  readonly opened: boolean;
}

/** The request a call waits on. */
export interface JoinedApprovalRequest {
  readonly id: string;
  /** Whether this call opened it, and so shows it. Otherwise one already kept asks the same. */
  readonly opened: boolean;
  /** Waits until the request is settled. */
  readonly answer: Effect.Effect<T3ApprovalAnswer>;
  /** The answer the request has so far, without waiting for one. */
  readonly answered: Effect.Effect<Option.Option<T3ApprovalAnswer>>;
}

interface ToolResultState {
  readonly entries: ReadonlyMap<ThreadId, ReadonlyArray<KeptToolResult>>;
  readonly epochs: ReadonlyMap<ThreadId, number>;
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
    // A reported output consumes only an exact (tool, input, output) match; input-only recovery
    // consumes a match only when all matching candidates carry the same output.
    readonly takeToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      reported?: Record<string, unknown>,
    ) => Effect.Effect<Record<string, unknown> | undefined>;
    readonly clearToolResults: (threadId: ThreadId) => Effect.Effect<void>;
    // T3's own tools ask the person in the thread itself and keep the request here until it
    // has ended. The server alone settles it, from its record of what the person answered.
    /**
     * The thread's request for `request.state`: the one already kept, which the same call made
     * again or made twice at once joins, or else a new one. Undefined, with nothing kept, when
     * the thread already has `MAX_KEPT_APPROVAL_REQUESTS` waiting for the person.
     */
    readonly joinApprovalRequest: (
      threadId: ThreadId,
      request: T3ApprovalRequest,
    ) => Effect.Effect<JoinedApprovalRequest | undefined>;
    readonly settleApprovalRequest: (
      threadId: ThreadId,
      id: string,
      answer: T3ApprovalAnswer,
    ) => Effect.Effect<void>;
    /** Waits until the request is settled. One that is gone, as after a restart, was cancelled. */
    readonly awaitApprovalAnswer: (
      threadId: ThreadId,
      id: string,
    ) => Effect.Effect<T3ApprovalAnswer>;
    /**
     * Stops keeping the request, and says whether this call was the one that did. An answer is
     * used by the call that takes its request away, so of the calls waiting on one request
     * exactly one is told true.
     */
    readonly forgetApprovalRequest: (threadId: ThreadId, id: string) => Effect.Effect<boolean>;
    // A waiting request is also sent to the thread's client as an MCP elicitation. An adapter
    // that is handed those says so for its provider instance and holds each until the request
    // is settled, never answering one itself. It knows one by the id the client passes on, or
    // else by the question's words.
    readonly holdsApprovalRequests: (providerInstanceId: ProviderInstanceId) => Effect.Effect<void>;
    readonly areApprovalRequestsHeld: (
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<boolean>;
    readonly ownApprovalRequest: (
      threadId: ThreadId,
      elicited: { readonly id: string | undefined; readonly message: string },
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

const matchingToolResultIndex = (
  kept: ReadonlyArray<KeptToolResult>,
  toolName: string,
  input: unknown,
  reported?: Record<string, unknown>,
): number => {
  const inputHash = hashToolInput(input);
  if (reported !== undefined) {
    const reportedJson = stableStringify(reported);
    return kept.findIndex(
      (entry) =>
        entry.toolName === toolName &&
        entry.inputHash === inputHash &&
        entry.outputJson === reportedJson,
    );
  }
  const matches = kept.flatMap((entry, index) =>
    entry.toolName === toolName && entry.inputHash === inputHash ? [index] : [],
  );
  if (matches.length === 0) return -1;
  if (matches.length === 1) return matches[0]!;
  // Identical outputs (e.g. repeated send_to_user calls) are interchangeable; differing outputs
  // (e.g. parallel identical-input delegate_task calls) stay unclaimed to avoid misattribution.
  const firstOutput = kept[matches[0]!]!.outputJson;
  return matches.every((index) => kept[index]!.outputJson === firstOutput) ? matches[0]! : -1;
};

const clearThreadToolResults = (state: ToolResultState, threadId: ThreadId): ToolResultState => {
  const entries = new Map(state.entries);
  entries.delete(threadId);
  const epochs = new Map(state.epochs);
  epochs.set(threadId, (state.epochs.get(threadId) ?? 0) + 1);
  return { entries, epochs };
};

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptHtmlRender>>());
  const toolResultState = yield* Ref.make<ToolResultState>({
    entries: new Map(),
    epochs: new Map(),
  });
  const approvalRequests = yield* Ref.make<KeptApprovalRequests>(new Map());
  const approvalRequestsHeldBy = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());
  const withoutThread = <A>(kept: ReadonlyMap<ThreadId, A>, threadId: ThreadId) => {
    const next = new Map(kept);
    next.delete(threadId);
    return next;
  };
  const cancelAll = (requests: ReadonlyArray<WaitingApprovalRequest> | undefined) =>
    Effect.forEach(requests ?? [], (request) => Deferred.succeed(request.answer, "cancelled"), {
      discard: true,
    });
  // A request dropped with its session ends as cancelled, so nothing waits on it for ever.
  const dropApprovalRequests = (threadId: ThreadId) =>
    Ref.modify(approvalRequests, (current) => [
      current.get(threadId),
      withoutThread(current, threadId),
    ]).pipe(Effect.flatMap(cancelAll));
  const waitingApprovalRequest = (threadId: ThreadId, id: string) =>
    Ref.get(approvalRequests).pipe(
      Effect.map((current) => current.get(threadId)?.find((kept) => kept.id === id)),
    );
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
        yield* dropApprovalRequests(config.threadId);
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
        Effect.andThen(dropApprovalRequests(threadId)),
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
        const entry: KeptToolResult = {
          toolName: canonicalTool,
          inputHash: hashToolInput(input),
          outputJson: stableStringify(output),
          output,
        };
        const expectedEpoch = options?.epoch;
        yield* Ref.update(toolResultState, (state) => {
          // A handler finishing after its turn closed must not populate the next turn.
          if (expectedEpoch !== undefined && (state.epochs.get(threadId) ?? 0) !== expectedEpoch) {
            return state;
          }
          const entries = new Map(state.entries);
          entries.set(
            threadId,
            [...(entries.get(threadId) ?? []), entry].slice(-MAX_KEPT_TOOL_RESULTS),
          );
          return { ...state, entries };
        });
      },
    ),
    takeToolResult: Effect.fn("McpProviderSessions.takeToolResult")(
      function (threadId, toolName, input, reported) {
        const canonicalTool = resolveT3McpToolId(toolName) ?? toolName;
        return Ref.modify(toolResultState, (state) => {
          const kept = state.entries.get(threadId) ?? [];
          const index = matchingToolResultIndex(kept, canonicalTool, input, reported);
          if (index === -1) {
            return [undefined, state];
          }
          const rest = kept.filter((_, keptIndex) => keptIndex !== index);
          const entries = new Map(state.entries);
          if (rest.length === 0) {
            entries.delete(threadId);
          } else {
            entries.set(threadId, rest);
          }
          return [kept[index]!.output, { ...state, entries }];
        });
      },
    ),
    clearToolResults: Effect.fn("McpProviderSessions.clearToolResults")(function (threadId) {
      return Ref.update(toolResultState, (state) => clearThreadToolResults(state, threadId));
    }),
    joinApprovalRequest: Effect.fn("McpProviderSessions.joinApprovalRequest")(
      function* (threadId, request) {
        const id = yield* randomUuidV4;
        const answer = yield* Deferred.make<T3ApprovalAnswer>();
        const joined = yield* Ref.modify(
          approvalRequests,
          (current: KeptApprovalRequests): [JoinedRequest | "full", KeptApprovalRequests] => {
            const kept = current.get(threadId) ?? [];
            const same = kept.find((candidate) => candidate.state === request.state);
            if (same !== undefined) return [{ request: same, opened: false }, current];
            // The oldest answered requests make room. Their calls never came back for the answer.
            const excess = Math.max(0, kept.length + 1 - MAX_KEPT_APPROVAL_REQUESTS);
            const dropped = new Set(
              kept.filter((candidate) => Deferred.isDoneUnsafe(candidate.answer)).slice(0, excess),
            );
            if (dropped.size < excess) return ["full", current];
            const opened = { ...request, id, answer };
            return [
              { request: opened, opened: true },
              new Map(current).set(threadId, [
                ...kept.filter((candidate) => !dropped.has(candidate)),
                opened,
              ]),
            ];
          },
        );
        if (joined === "full") return undefined;
        const waiting = joined.request.answer;
        return {
          id: joined.request.id,
          opened: joined.opened,
          answer: Deferred.await(waiting),
          answered: Effect.gen(function* () {
            const polled = yield* Deferred.poll(waiting);
            return Option.isNone(polled)
              ? Option.none<T3ApprovalAnswer>()
              : Option.some(yield* polled.value);
          }),
        } satisfies JoinedApprovalRequest;
      },
    ),
    settleApprovalRequest: Effect.fn("McpProviderSessions.settleApprovalRequest")(
      function* (threadId, id, answer) {
        const request = yield* waitingApprovalRequest(threadId, id);
        // A request's first answer stands.
        if (request !== undefined) yield* Deferred.succeed(request.answer, answer);
      },
    ),
    awaitApprovalAnswer: Effect.fn("McpProviderSessions.awaitApprovalAnswer")(
      function* (threadId, id) {
        const request = yield* waitingApprovalRequest(threadId, id);
        return request === undefined ? "cancelled" : yield* Deferred.await(request.answer);
      },
    ),
    forgetApprovalRequest: Effect.fn("McpProviderSessions.forgetApprovalRequest")(
      function* (threadId, id) {
        const forgotten = yield* Ref.modify(approvalRequests, (current) => {
          const kept = current.get(threadId);
          const taken = kept?.find((candidate) => candidate.id === id);
          if (kept === undefined || taken === undefined) return [undefined, current];
          const rest = kept.filter((candidate) => candidate !== taken);
          return [
            taken,
            rest.length === 0
              ? withoutThread(current, threadId)
              : new Map(current).set(threadId, rest),
          ];
        });
        if (forgotten === undefined) return false;
        yield* Deferred.succeed(forgotten.answer, "cancelled");
        return true;
      },
    ),
    holdsApprovalRequests: Effect.fn("McpProviderSessions.holdsApprovalRequests")(
      function (providerInstanceId) {
        return Ref.update(approvalRequestsHeldBy, (current) =>
          new Set(current).add(providerInstanceId),
        );
      },
    ),
    areApprovalRequestsHeld: Effect.fn("McpProviderSessions.areApprovalRequestsHeld")(
      function (providerInstanceId) {
        return Ref.get(approvalRequestsHeldBy).pipe(
          Effect.map((current) => current.has(providerInstanceId)),
        );
      },
    ),
    ownApprovalRequest: Effect.fn("McpProviderSessions.ownApprovalRequest")(
      function (threadId, elicited) {
        return Ref.get(approvalRequests).pipe(
          Effect.map((current) =>
            current
              .get(threadId)
              ?.find((kept) =>
                elicited.id === undefined
                  ? kept.message === elicited.message
                  : kept.id === elicited.id,
              ),
          ),
          Effect.map((kept) =>
            kept === undefined
              ? undefined
              : { id: kept.id, message: kept.message, state: kept.state },
          ),
        );
      },
    ),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
