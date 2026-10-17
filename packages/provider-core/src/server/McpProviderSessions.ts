/**
 * Per-thread state the T3 MCP server shares with the thread's provider
 * session. The session manager writes the T3 MCP credential the session
 * should expose to its agent before the session starts; adapters read it when
 * they build provider launch options. `html_render` keeps the pages it
 * published here for adapters whose agent reports a call without its result.
 *
 * @module provider-core/server/McpProviderSessions
 */
import type { ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

// Agents that report results never take their pages, so only each thread's
// most recent pages are kept. A page is taken as soon as its call completes.
const MAX_KEPT_HTML_RENDERS = 64;

// Antigravity bounds each long string of a call's input to its last 8,000
// characters behind this marker before the adapter sees the call, while the
// MCP server receives the whole page. A kept page holds its length and that
// much of its end, which identifies it in either form without holding every
// page whole.
const BOUNDED_TEXT_MARKER = "[Earlier output truncated]\n\n";
const KEPT_HTML_END_LENGTH = 8_000;

interface KeptHtmlRender {
  readonly title: string;
  readonly height: number;
  readonly htmlLength: number;
  readonly htmlEnd: string;
  readonly reference: HtmlRenderReference;
}

// A slice can share the whole page's memory; the copy holds only its own text.
const copyText = (text: string) => Buffer.from(text, "utf16le").toString("utf16le");

/** Whether a call's `html` argument is this page, whole or bounded to its end. */
const isPageHtml = (page: KeptHtmlRender, html: string): boolean => {
  if (html.length === page.htmlLength && html.endsWith(page.htmlEnd)) {
    return true;
  }
  if (!html.startsWith(BOUNDED_TEXT_MARKER)) {
    return false;
  }
  const end = html.slice(BOUNDED_TEXT_MARKER.length);
  return end.length > 0 && end.length < page.htmlLength && page.htmlEnd.endsWith(end);
};

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    /** Keeps a page `html_render` published with these arguments until a call takes it. */
    readonly recordHtmlRender: (
      threadId: ThreadId,
      input: { readonly html: string; readonly title: string; readonly height: number },
      reference: HtmlRenderReference,
    ) => Effect.Effect<void>;
    /**
     * Removes and returns the kept page the thread published with these
     * arguments, so each page goes to at most one call. A call that reported
     * its page takes that very page, so it never takes another call's. Without
     * `html`, or when several kept pages match, the call could be any of their
     * calls, so it takes none.
     */
    readonly takeHtmlRender: (
      threadId: ThreadId,
      input: { readonly html?: unknown; readonly title?: unknown; readonly height?: unknown },
      reported?: HtmlRenderReference,
    ) => Effect.Effect<HtmlRenderReference | undefined>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

/** The one kept page these arguments match, or -1 when they match none or several. */
const matchingPageIndex = (
  kept: ReadonlyArray<KeptHtmlRender>,
  input: { readonly html?: unknown; readonly title?: unknown; readonly height?: unknown },
): number => {
  const html = input.html;
  if (typeof html !== "string" || html.length === 0) {
    return -1;
  }
  // Agents can report a numeric argument as a string, e.g. "240".
  const height =
    typeof input.height === "string" && input.height.trim() !== ""
      ? Number(input.height)
      : input.height;
  const matches = kept.flatMap((page, index) =>
    page.title === input.title && page.height === height && isPageHtml(page, html) ? [index] : [],
  );
  // Pages the arguments cannot tell apart could belong to any of their calls.
  return matches.length === 1 ? matches[0]! : -1;
};

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptHtmlRender>>());
  return McpProviderSessions.of({
    set: (config) =>
      Ref.update(sessions, (current) => new Map(current).set(config.threadId, config)),
    read: (threadId) => Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId))),
    clear: (threadId) =>
      Ref.update(sessions, (current) => {
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
      ),
    recordHtmlRender: (threadId, input, reference) =>
      Ref.update(htmlRenders, (current) =>
        new Map(current).set(
          threadId,
          [
            ...(current.get(threadId) ?? []),
            {
              title: input.title,
              height: input.height,
              htmlLength: input.html.length,
              htmlEnd: copyText(input.html.slice(-KEPT_HTML_END_LENGTH)),
              reference,
            },
          ].slice(-MAX_KEPT_HTML_RENDERS),
        ),
      ),
    takeHtmlRender: (threadId, input, reported) =>
      Ref.modify(htmlRenders, (current) => {
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
      }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
