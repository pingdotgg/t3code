import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const TARGET_URL = "https://example.com";

const byteLength = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunks) =>
      Array.from(chunks).reduce((total, chunk) => total + chunk.length, 0),
    ),
  );

export default class BrowserEffectWorker extends Cloudflare.Worker<BrowserEffectWorker>()(
  "BrowserEffectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const browser = yield* Cloudflare.Browser("BROWSER");

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = request.url.split("?")[0];

        switch (path) {
          // JSON quick actions resolve to their parsed payload directly.
          case "/content": {
            const content = yield* browser
              .content({ url: TARGET_URL })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              title: content.meta.title,
              contentLength: content.result.length,
            });
          }
          case "/markdown": {
            const markdown = yield* browser
              .markdown({ url: TARGET_URL })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              markdownLength: markdown.result.length,
            });
          }
          case "/links": {
            const links = yield* browser
              .links({ url: TARGET_URL })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              linkCount: links.result.length,
            });
          }
          case "/scrape": {
            const scrape = yield* browser
              .scrape({ url: TARGET_URL, elements: [{ selector: "h1" }] })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              heading: scrape.result[0]?.results[0]?.text ?? null,
            });
          }
          case "/snapshot": {
            const snapshot = yield* browser
              .snapshot({ url: TARGET_URL })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              title: snapshot.meta.title,
              screenshotLength: snapshot.result.screenshot.length,
            });
          }
          case "/json": {
            const extracted = yield* browser
              .json({
                url: TARGET_URL,
                prompt: "Extract the page heading as { heading: string }",
              })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              success: extracted.success,
            });
          }
          // Binary actions stream bytes; drain the stream to count them.
          case "/screenshot": {
            const bytes = yield* byteLength(
              browser.screenshot({ url: TARGET_URL }),
            ).pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ bytes });
          }
          case "/pdf": {
            const bytes = yield* byteLength(
              browser.pdf({ url: TARGET_URL }),
            ).pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ bytes });
          }
          // Generic `quickAction` passthrough.
          case "/quickAction": {
            const snapshot = yield* browser
              .quickAction("snapshot", { url: TARGET_URL })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              title: snapshot.meta.title,
            });
          }
          // `raw` exposes the underlying `cf.BrowserRun` binding (puppeteer, etc.).
          case "/raw": {
            const binding = yield* browser.raw;
            const res = yield* Effect.tryPromise(() =>
              binding.quickAction("content", { url: TARGET_URL }),
            ).pipe(Effect.orDie);
            const body = yield* Effect.promise(
              () =>
                res.json() as Promise<Cloudflare.Workers.BrowserContentResult>,
            );
            return yield* HttpServerResponse.json({ title: body.meta.title });
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.BrowserBinding)),
) {}
