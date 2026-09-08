import * as railway from "@distilled.cloud/railway";
import * as Railway from "@/Railway";
import { suitePartition } from "../suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../AWS/Website/fixtures/nuxt-app",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "nuxt.config.ts",
  "app",
  "server",
  "public",
];

const waitUntilGone = (serviceId: string) =>
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) =>
      service.deletedAt != null ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "Nuxt: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-nuxt-railway-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const site = yield* Railway.Website.Nuxt("Web", {
            project,
            environment,
            rootDir,
            memo: {
              include: [
                "app/**",
                "server/**",
                "public/**",
                "package.json",
                "nuxt.config.ts",
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
      expect(deployed.site.project).toBeDefined();

      yield* expectUrlContains(`${url!}/`, "NUXT_AWS_PAGE_MARKER", {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(
        `${url!}/api/hello?echo=roundtrip`,
        "NUXT_AWS_API_MARKER",
        {
          timeout: "30 seconds",
          label: "api route",
        },
      );
      yield* expectUrlContains(
        `${url!}/prerendered`,
        "NUXT_AWS_PRERENDERED_MARKER",
        {
          timeout: "30 seconds",
          label: "extra route",
        },
      );

      const serviceId = deployed.site.service!.serviceId;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(serviceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
