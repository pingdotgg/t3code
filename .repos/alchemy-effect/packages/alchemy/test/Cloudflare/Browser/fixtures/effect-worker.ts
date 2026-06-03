import puppeteer from "@cloudflare/puppeteer";
import * as Cloudflare from "alchemy/Cloudflare";
import type { BrowserPuppeteer } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const TARGET_URL = "https://example.com";

type PuppeteerBrowser = Awaited<ReturnType<(typeof puppeteer)["launch"]>>;

const cloudflarePuppeteer =
  puppeteer as unknown as BrowserPuppeteer<PuppeteerBrowser>;

export default class BrowserEffectWorker extends Cloudflare.Worker<BrowserEffectWorker>()(
  "BrowserEffectWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const browser = yield* Cloudflare.Browser({
      name: "BROWSER",
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (!request.url.startsWith("/title")) {
          return HttpServerResponse.text("ok");
        }

        return yield* browser
          .withBrowser(cloudflarePuppeteer, (browser) =>
            Effect.gen(function* () {
              const page = yield* Effect.tryPromise(() => browser.newPage());
              yield* Effect.tryPromise(() =>
                page.goto(TARGET_URL, { waitUntil: "networkidle0" }),
              );
              const title = yield* Effect.tryPromise(() => page.title());
              return { title };
            }),
          )
          .pipe(
            Effect.orDie,
            Effect.flatMap(({ title }) =>
              HttpServerResponse.json({ mode: "effect", title }),
            ),
          );
      }),
    };
  }).pipe(Effect.provide(Cloudflare.BrowserBindingLive)),
) {}
