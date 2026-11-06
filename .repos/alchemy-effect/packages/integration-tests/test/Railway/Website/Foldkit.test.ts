import * as Railway from "@alchemy.run/railway";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Query } from "@distilled.cloud/core/query";
import { Railway as RailwayApi } from "@distilled.cloud/railway";
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
import { suitePartition } from "../suiteProject.ts";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixtureDir = pathe.resolve(import.meta.dirname, "../../Cloudflare/Website/foldkit-fixture");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = ["index.html", "package.json", "vite.config.ts", "src"];

const readService = Query.fn((id: string) => ({ deletedAt: RailwayApi.service({ id }).deletedAt }));

const waitUntilGone = (serviceId: string) =>
  readService(serviceId).pipe(
    Effect.map((service) => (service.deletedAt != null ? ("gone" as const) : ("found" as const))),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed("gone" as const)),
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
        prefix: "alchemy-foldkit-railway-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const site = yield* Railway.Website.Foldkit("Web", {
            project,
            environment,
            rootDir,
            memo: { include: ["index.html", "src/**", "package.json", "vite.config.ts"] },
          });
          return { site };
        }),
      );

      const url = deployed.site.url;
      expect(url).toBeDefined();
      expect(url).toMatch(/^https:\/\//);
      expect(deployed.site.service).toBeDefined();
      expect(deployed.site.project).toBeDefined();

      yield* expectUrlContains(`${url!}/`, "Foldkit Fixture", {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(`${url!}/counter/42`, "Foldkit Fixture", {
        timeout: "30 seconds",
        label: "spa fallback",
      });

      const serviceId = deployed.site.service!.serviceId;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(serviceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:railway",
      "provider:railway:project",
      "provider:railway:projectenvironment",
      "provider:railway:service",
      "provider:railway:website",
      "live",
    ],
    timeout: 120_000,
  },
);

describe.sequential(
  "Railway Foldkit rendering modes",
  { tags: ["provider:railway", "provider:railway:website", "live"] },
  () => {
    for (const mode of ["ssg", "ssr", "hybrid"] as const) {
      test.provider.skipIf(!!process.env.FAST)(
        `${mode}: renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* foldkitFixture(mode);
            const site = yield* stack.deploy(
              Effect.gen(function* () {
                const { project, environment } = yield* suitePartition;
                return yield* Railway.Website.Foldkit("Web", {
                  rootDir,
                  memo: foldkitMemo,
                  project,
                  environment,
                });
              }),
            );
            expect(site.url).toBeDefined();
            expect(site.service).toBeDefined();
            const serviceId = site.service!.serviceId;
            expect((yield* readService(serviceId)).deletedAt == null).toBe(true);
            yield* verifyFoldkitRendering(site.url!, mode);
            yield* verifyFoldkitBrowser(site.url!, mode);
            yield* stack.destroy();
            expect(yield* waitUntilGone(serviceId)).toEqual("gone");
          }),
        {
          timeout: 120_000,
        },
      );
    }
  },
);
