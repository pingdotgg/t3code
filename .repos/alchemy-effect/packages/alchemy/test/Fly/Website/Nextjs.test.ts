import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { prepareNextjsFixture } from "../../Cloudflare/Website/TypeScriptCompat.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../AWS/Website/fixtures/nextjs-app",
);
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "next.config.ts",
  "tsconfig.json",
  "app",
  "public",
];

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
  "Nextjs: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Clone OUTSIDE the repo (OS temp dir): an in-workspace clone makes
      // Next treat the alchemy monorepo as the workspace root and look up
      // the root's typescript (catalog:build = tsgo, which has no JS compiler).
      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-nextjs-fly-",
        entries: fixtureEntries,
      });
      yield* prepareNextjsFixture(rootDir);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Fly.Website.Nextjs("Web", {
            rootDir,
            memo: {
              include: [
                "app/**",
                "public/**",
                "package.json",
                "next.config.ts",
                "tsconfig.json",
              ],
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

      yield* expectUrlContains(`${url!}/`, "NEXTJS_AWS_PAGE_MARKER", {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(
        `${url!}/api/hello?echo=roundtrip`,
        "NEXTJS_AWS_API_MARKER",
        {
          timeout: "30 seconds",
          label: "api route",
        },
      );
      yield* expectUrlContains(`${url!}/static`, "NEXTJS_AWS_STATIC_MARKER", {
        timeout: "30 seconds",
        label: "extra route",
      });

      const appName = deployed.site.app!.appName;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(appName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 480000 },
);
