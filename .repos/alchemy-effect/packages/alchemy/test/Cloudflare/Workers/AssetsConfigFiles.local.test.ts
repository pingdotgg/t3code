import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import {
  expectUrlContains,
  expectUrlHeader,
  expectUrlRedirect,
} from "../Utils/Http.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures/assets-config");

/**
 * Regression for https://github.com/alchemy-run/alchemy/pull/1418:
 * local asset serving used to crash with `TypeError: undefined is not an
 * object` the moment the assets directory contained a `_headers` or
 * `_redirects` file, because `constructHeaders` / `constructRedirects`
 * called `logger.log` with no logger. After the crash every subsequent
 * request hung. Those helpers now log through Effect.log.
 *
 * This is the local counterpart of `AssetsConfigFiles.test.ts`: the
 * fixture's rules must reach the local assets worker and actually apply.
 */
test.provider(
  "dev assets _headers and _redirects apply without crashing the assets worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("assets-config-local", {
            assets: { directory: fixtureDir },
          });
          return { worker };
        }),
      );

      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const url = deployed.worker.url;
      yield* expectUrlContains(`${url}/`, "alchemy-assets-config-index");
      yield* expectUrlHeader(
        `${url}/`,
        "x-alchemy-test",
        "assets-config-header",
        { label: "local _headers" },
      );
      yield* expectUrlRedirect(`${url}/old-path`, "/index.html", {
        status: 301,
        label: "local _redirects",
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
