import * as Fly from "@alchemy.run/fly";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  foldkitFixture,
  foldkitMemo,
  verifyFoldkitBrowser,
  verifyFoldkitRendering,
} from "../../Website/Foldkit.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixtureDir = pathe.resolve(import.meta.dirname, "../../Cloudflare/Website/foldkit-fixture");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = ["index.html", "package.json", "vite.config.ts", "src"];

const waitUntilGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "Foldkit: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-foldkit-fly-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Fly.Website.Foldkit("Web", {
            rootDir,
            memo: {
              include: ["index.html", "src/**", "package.json", "vite.config.ts"],
            },
          });
          return { site };
        }),
      );

      const url = deployed.site.url;
      expect(url).toBeDefined();
      expect(url).toMatch(/^https:\/\//);
      expect(deployed.site.service).toBeDefined();
      expect(deployed.site.app).toBeDefined();

      yield* expectUrlContains(`${url!}/`, "Foldkit Fixture", {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(`${url!}/counter/42`, "Foldkit Fixture", {
        timeout: "30 seconds",
        label: "spa fallback",
      });

      const appName = deployed.site.app!.appName;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(appName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:fly", "provider:fly:machine", "provider:fly:website", "live"],
    timeout: 180000,
  },
);

describe.sequential(
  "Fly Foldkit rendering modes",
  { tags: ["provider:fly", "provider:fly:website", "live"] },
  () => {
    for (const mode of ["ssg", "ssr", "hybrid"] as const) {
      test.provider.skipIf(!!process.env.FAST)(
        `${mode}: renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* foldkitFixture(mode);

            const site = yield* stack.deploy(
              Fly.Website.Foldkit("Web", {
                rootDir,
                memo: foldkitMemo,
              }),
            );
            expect(site.url).toBeDefined();
            expect(site.app).toBeDefined();
            const appName = site.app!.appName;
            expect((yield* machines.getApp({ app_name: appName })).name).toBe(appName);
            yield* verifyFoldkitRendering(site.url!, mode);
            yield* verifyFoldkitBrowser(site.url!, mode);
            yield* stack.destroy();
            expect(yield* waitUntilGone(appName)).toEqual("gone");
          }),
        {
          timeout: 120_000,
        },
      );
    }
  },
);
