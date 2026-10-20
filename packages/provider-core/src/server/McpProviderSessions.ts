// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing keeps page matching bounded without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import type { ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

// Other providers may never consume these references.
const MAX_KEPT_HTML_RENDERS = 64;

// Antigravity truncates long HTML arguments to a marked tail of at most 8,000 characters.
const BOUNDED_TEXT_MARKER = "[Earlier output truncated]\n\n";
const KEPT_HTML_END_LENGTH = 8_000;

interface KeptHtmlRender {
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
    readonly recordHtmlRender: (
      threadId: ThreadId,
      input: { readonly html: string; readonly title: string; readonly height: number },
      reference: HtmlRenderReference,
    ) => Effect.Effect<void>;
    // A reported attachment consumes that exact page; otherwise only unique input matches count.
    readonly takeHtmlRender: (
      threadId: ThreadId,
      input: { readonly html?: unknown; readonly title?: unknown; readonly height?: unknown },
      reported?: HtmlRenderReference,
    ) => Effect.Effect<HtmlRenderReference | undefined>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const matchingPageIndex = (
  kept: ReadonlyArray<KeptHtmlRender>,
  input: { readonly html?: unknown; readonly title?: unknown; readonly height?: unknown },
): number => {
  const html = input.html;
  if (typeof html !== "string" || html.length === 0) {
    return -1;
  }
  const height =
    typeof input.height === "string" && input.height.trim() !== ""
      ? Number(input.height)
      : input.height;
  const htmlHash = hashHtml(html);
  const tail = html.startsWith(BOUNDED_TEXT_MARKER)
    ? html.slice(BOUNDED_TEXT_MARKER.length)
    : undefined;
  const matches = kept.flatMap((page, index) =>
    page.title === input.title &&
    page.height === height &&
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
      yield* Ref.update(sessions, (current) => new Map(current).set(config.threadId, config));
    }),
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
              htmlHash: hashHtml(input.html),
              // Copy the tail so its backing storage cannot retain the entire HTML string.
              htmlEnd: Buffer.from(input.html.slice(-KEPT_HTML_END_LENGTH), "utf16le").toString(
                "utf16le",
              ),
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
