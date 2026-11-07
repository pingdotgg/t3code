import * as Hetzner from "@alchemy.run/hetzner";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as servers from "@distilled.cloud/hetzner/servers";
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

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const fixtureDir = pathe.resolve(import.meta.dirname, "../../Cloudflare/Website/foldkit-fixture");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = ["index.html", "package.json", "vite.config.ts", "src"];

const waitUntilGone = (id: number) =>
  servers.getServer({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "Foldkit: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-foldkit-hetzner-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Hetzner.Website.Foldkit("Web", {
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
      expect(url).toMatch(/^http:\/\//);
      expect(deployed.site.service).toBeDefined();
      expect(deployed.site.server).toBeDefined();

      yield* expectUrlContains(`${url!}/`, "Foldkit Fixture", {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(`${url!}/counter/42`, "Foldkit Fixture", {
        timeout: "30 seconds",
        label: "spa fallback",
      });

      const serverId = deployed.site.server!.serverId;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(serverId);
      expect(gone).toEqual("gone");
    }).pipe(
      logLevel,
      Effect.ensuring(stack.destroy().pipe(Effect.orDie)),
      Effect.catchTag(["PreconditionFailed", "Forbidden"], (error) =>
        Effect.logWarning(`skipping: Hetzner quota (${error._tag})`),
      ),
    ),
  {
    tags: ["provider:hetzner", "provider:hetzner:service", "provider:hetzner:website", "live"],
    timeout: 180000,
  },
);

describe.sequential(
  "Hetzner Foldkit rendering modes",
  { tags: ["provider:hetzner", "provider:hetzner:website", "live"] },
  () => {
    for (const mode of ["ssg", "ssr", "hybrid"] as const) {
      test.provider.skipIf(!!process.env.FAST || !hasHetznerCreds)(
        `${mode}: renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* foldkitFixture(mode);

            const site = yield* stack.deploy(
              Hetzner.Website.Foldkit("Web", {
                rootDir,
                memo: foldkitMemo,
              }),
            );
            expect(site.url).toBeDefined();
            expect(site.server).toBeDefined();
            const serverId = site.server!.serverId;
            yield* servers.getServer({ id: serverId });
            yield* verifyFoldkitRendering(site.url!, mode);
            yield* verifyFoldkitBrowser(site.url!, mode);
            yield* stack.destroy();
            expect(yield* waitUntilGone(serverId)).toEqual("gone");
          }),
        {
          timeout: 180_000,
        },
      );
    }
  },
);
