import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Driving Cloudflare Browser Rendering inside an Action via `BrowserLocal` —
// the local (current-credentials) implementation of the `Browser` binding.
// Browser Rendering is account-scoped and has no backing cloud resource, so the
// Action runs the REST quick actions directly against a stable page.
test.provider(
  "BrowserLocal: render a page to markdown and content from an Action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const Render = Action(
            "Render",
            Effect.gen(function* () {
              const browser = yield* Cloudflare.Browser("BROWSER");

              return Effect.fn(function* () {
                const md = yield* browser.markdown({
                  url: "https://example.com",
                });
                const html = yield* browser.content({
                  url: "https://example.com",
                });

                return { markdown: md.result, content: html.result };
              });
            }).pipe(Effect.provide(Cloudflare.Workers.BrowserLocal)),
          );

          return yield* Render({});
        }),
      );

      expect(out.markdown.toLowerCase()).toContain("example");
      expect(out.content.toLowerCase()).toContain("example");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
