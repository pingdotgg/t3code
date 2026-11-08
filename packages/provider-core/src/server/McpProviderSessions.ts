// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing keeps page matching bounded without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import type { ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

// Other providers may never consume these references.
const MAX_KEPT_HTML_RENDERS = 64;

// Claude binds every T3 tool call; older ones are long answered.
const MAX_KEPT_NATIVE_CALLERS = 1_024;
// Codex can call a tool before its spawn notification is read; Claude binds before calling.
const NATIVE_CALLER_WAIT = "5 seconds";

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

const hashHtml = (html: string) => NodeCrypto.createHash("sha256").update(html).digest("hex");

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * Records which agent of the thread's provider session a provider-reported call id
     * (a tool call or a native thread) belongs to: the thread itself or a native subagent's.
     */
    readonly bindNativeCaller: (input: {
      readonly threadId: ThreadId;
      /** The credential of the provider session that reported the call; ignored once not current. */
      readonly providerSessionId: string;
      readonly callId: string;
      readonly callerThreadId: ThreadId;
    }) => Effect.Effect<void>;
    /** Undefined when this credential's session never bound the call id. */
    readonly resolveNativeCaller: (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: string;
      readonly callId: string;
    }) => Effect.Effect<ThreadId | undefined>;
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
  const htmlHash = hashHtml(html);
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
  return matches.length === 1 ? matches[0]! : -1;
};

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptHtmlRender>>());
  // A replaced or cleared credential drops its thread's bindings, so none answer for the next.
  const nativeCallers = new Map<ThreadId, Map<string, ThreadId>>();
  // Codex thread identities stay valid across calls, unlike Claude's per-call tool-use ids.
  const nativeThreadCallers = new Map<ThreadId, Map<string, ThreadId>>();
  const nativeCallerWaiters = new Map<
    string,
    { readonly deferred: Deferred.Deferred<ThreadId>; pending: number }
  >();
  const waiterKey = (threadId: ThreadId, providerSessionId: string, callId: string) =>
    `${threadId}\u0000${providerSessionId}\u0000${callId}`;
  return McpProviderSessions.of({
    set: Effect.fn("McpProviderSessions.set")(function* (config) {
      const current = yield* Ref.get(sessions);
      if (current.get(config.threadId)?.providerSessionId !== config.providerSessionId) {
        yield* Ref.update(htmlRenders, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
      }
      // Drop bindings in the same update that changes the credential so no bind lands between.
      yield* Ref.update(sessions, (current) => {
        if (current.get(config.threadId)?.providerSessionId !== config.providerSessionId) {
          nativeCallers.delete(config.threadId);
          nativeThreadCallers.delete(config.threadId);
        }
        return new Map(current).set(config.threadId, config);
      });
    }),
    read: Effect.fn("McpProviderSessions.read")(function (threadId) {
      return Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId)));
    }),
    clear: Effect.fn("McpProviderSessions.clear")(function (threadId) {
      return Ref.update(sessions, (current) => {
        nativeCallers.delete(threadId);
        nativeThreadCallers.delete(threadId);
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
      );
    }),
    bindNativeCaller: Effect.fn("McpProviderSessions.bindNativeCaller")(function* (input) {
      // Check and bind in one update: a callback outliving its credential must not bind for the next.
      const waiter = yield* Ref.modify(sessions, (current) => {
        if (current.get(input.threadId)?.providerSessionId !== input.providerSessionId) {
          return [undefined, current] as const;
        }
        const callers = input.callId.startsWith("codex-thread:")
          ? nativeThreadCallers
          : nativeCallers;
        const bound = callers.get(input.threadId) ?? new Map<string, ThreadId>();
        bound.delete(input.callId);
        bound.set(input.callId, input.callerThreadId);
        if (callers === nativeCallers) {
          for (const oldest of bound.keys()) {
            if (bound.size <= MAX_KEPT_NATIVE_CALLERS) break;
            bound.delete(oldest);
          }
        }
        callers.set(input.threadId, bound);
        return [
          nativeCallerWaiters.get(waiterKey(input.threadId, input.providerSessionId, input.callId)),
          current,
        ] as const;
      });
      if (waiter !== undefined) yield* Deferred.succeed(waiter.deferred, input.callerThreadId);
    }),
    resolveNativeCaller: Effect.fn("McpProviderSessions.resolveNativeCaller")(function* (input) {
      // Only the thread's current credential reads its bindings, also after waiting for one.
      const credentialCurrent = Ref.get(sessions).pipe(
        Effect.map((all) => all.get(input.threadId)?.providerSessionId === input.providerSessionId),
      );
      if (!(yield* credentialCurrent)) return undefined;
      const bound =
        nativeThreadCallers.get(input.threadId)?.get(input.callId) ??
        nativeCallers.get(input.threadId)?.get(input.callId);
      if (bound !== undefined) return bound;
      const key = waiterKey(input.threadId, input.providerSessionId, input.callId);
      const waiter = nativeCallerWaiters.get(key) ?? {
        deferred: yield* Deferred.make<ThreadId>(),
        pending: 0,
      };
      waiter.pending += 1;
      nativeCallerWaiters.set(key, waiter);
      const awaited = yield* Deferred.await(waiter.deferred).pipe(
        Effect.timeoutOption(NATIVE_CALLER_WAIT),
        Effect.ensuring(
          Effect.sync(() => {
            waiter.pending -= 1;
            if (waiter.pending === 0 && nativeCallerWaiters.get(key) === waiter) {
              nativeCallerWaiters.delete(key);
            }
          }),
        ),
      );
      return (yield* credentialCurrent) ? Option.getOrUndefined(awaited) : undefined;
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
                htmlHash: hashHtml(input.html),
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
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
