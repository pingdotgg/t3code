import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";

export class UnfurlError extends Data.TaggedError("UnfurlError")<{
  url: string;
  cause: unknown;
}> {}

const decode = (text: string) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

/** Fetch a page and read its `<title>`, retrying transient failures. */
export const unfurl = Effect.fn("unfurl")(function* (url: string) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.followRedirects(5),
  );
  const html = yield* client.get(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.timeout("5 seconds"),
    Effect.retry({ schedule: Schedule.exponential("200 millis"), times: 3 }),
    Effect.mapError((cause) => new UnfurlError({ url, cause })),
  );
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  return { title: title ? decode(title) : new URL(url).hostname, fetchedAt: Date.now() };
});
