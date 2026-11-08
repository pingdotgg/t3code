import type { ServerLinkPreview, ServerLinkPreviewInput } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { resolvePublicAddresses } from "./htmlRender/publicProxy.ts";

const MAX_PAGE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 500;
const MANUAL_REDIRECT = { redirect: "manual" } as const;

export class LinkPreview extends Context.Service<
  LinkPreview,
  {
    readonly get: (input: ServerLinkPreviewInput) => Effect.Effect<ServerLinkPreview | null>;
  }
>()("t3/linkPreview") {}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
    const code =
      entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : +entity.slice(1);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : match;
  });
}

function cleanText(value: string | undefined, maxLength: number): string | null {
  if (value === undefined) return null;
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function tagAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(
    /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
  )) {
    const name = match[1]!.toLowerCase();
    if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/** Reads the social or document title and description from an HTML page's head. */
export function parseLinkPreviewHtml(html: string): ServerLinkPreview {
  const meta = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = tagAttributes(tag);
    const key = (attributes.get("property") ?? attributes.get("name"))?.toLowerCase();
    const content = attributes.get("content");
    if (key !== undefined && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const documentTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title =
    cleanText(meta.get("og:title"), MAX_TITLE_LENGTH) ??
    cleanText(meta.get("twitter:title"), MAX_TITLE_LENGTH) ??
    cleanText(documentTitle, MAX_TITLE_LENGTH);
  const description =
    cleanText(meta.get("og:description"), MAX_DESCRIPTION_LENGTH) ??
    cleanText(meta.get("twitter:description"), MAX_DESCRIPTION_LENGTH) ??
    cleanText(meta.get("description"), MAX_DESCRIPTION_LENGTH);
  return { title, description };
}

const make = Effect.fn("LinkPreview.make")(function* () {
  const http = yield* HttpClient.HttpClient;

  // ponytail: each hop's host is checked before the request, but fetch resolves it again, so a
  // DNS rebinding host can still reach a private address. Pin the checked addresses with a
  // per-request dispatcher if previews ever expose more than a title and description.
  const fetchPreview = Effect.fn("LinkPreview.fetch")(function* (raw: string) {
    if (!URL.canParse(raw)) return null;
    let url = new URL(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      if (url.username || url.password) return null;
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = yield* Effect.promise(() => resolvePublicAddresses(host));
      if (addresses === undefined) return null;
      const response = yield* http
        .execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeaders({
              accept: "text/html,application/xhtml+xml;q=0.9",
              "user-agent": "Mozilla/5.0 (compatible; T3Code-LinkPreview/1.0)",
            }),
          ),
        )
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
      const location = response.headers["location"];
      if (response.status >= 300 && response.status < 400) {
        if (!location || !URL.canParse(location, url.href)) return null;
        url = new URL(location, url);
        continue;
      }
      if (response.status < 200 || response.status >= 300) return null;
      if (!/html/i.test(response.headers["content-type"] ?? "")) return null;
      let size = 0;
      const chunks = yield* response.stream.pipe(
        Stream.takeWhile((chunk) => {
          const under = size < MAX_PAGE_BYTES;
          size += chunk.byteLength;
          return under;
        }),
        Stream.runCollect,
      );
      const html = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_PAGE_BYTES));
      const preview = parseLinkPreviewHtml(html);
      return preview.title === null && preview.description === null ? null : preview;
    }
    return null;
  });

  // Failures cache as null too, so a dead link is not refetched on every render.
  const cache = yield* Cache.make({
    capacity: 256,
    timeToLive: Duration.minutes(30),
    lookup: (url: string) =>
      fetchPreview(url).pipe(
        Effect.timeout(Duration.seconds(7)),
        Effect.orElseSucceed(() => null),
      ),
  });
  return LinkPreview.of({
    get: Effect.fn("LinkPreview.get")(function* (input) {
      return yield* Cache.get(cache, input.url);
    }),
  });
});

export const layer = Layer.effect(LinkPreview, make()).pipe(Layer.provide(FetchHttpClient.layer));
