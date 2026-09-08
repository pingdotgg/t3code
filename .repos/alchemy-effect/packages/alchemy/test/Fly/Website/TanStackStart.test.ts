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

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../AWS/Website/fixtures/tanstack-start-app",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "vite.config.ts",
  "src",
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
  "TanStackStart: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-tanstack-start-fly-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Fly.Website.TanStackStart("Web", {
            rootDir,
            memo: {
              include: [
                "src/**",
                "public/**",
                "package.json",
                "vite.config.ts",
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

      yield* expectUrlContains(`${url!}/`, "TANSTACK_AWS_PAGE_MARKER", {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(
        `${url!}/api/hello?echo=roundtrip`,
        "TANSTACK_AWS_API_MARKER",
        {
          timeout: "30 seconds",
          label: "api route",
        },
      );

      const appName = deployed.site.app!.appName;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(appName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180000 },
);
