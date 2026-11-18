import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  foldkitFixture,
  foldkitMemo,
  verifyFoldkitBrowser,
  verifyFoldkitRendering,
} from "../../Website/Foldkit.ts";
import {
  assertSiteGone,
  cloudRunUrl,
  cloudflareFixture,
  type DeployedService,
  liveOptions,
  logLevel,
  serviceIdentity,
  tempRoot,
} from "./site.ts";

const { test } = Test.make({ providers: GCP.providers() });

const fixtureDir = cloudflareFixture("foldkit-fixture");
const fixtureEntries = ["index.html", "package.json", "vite.config.ts", "src"];

test.provider(
  "Foldkit: deploy, GET / and a deep link, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-foldkit-gcp-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* GCP.Website.Foldkit("Web", {
            rootDir,
            memo: {
              include: ["index.html", "src/**", "package.json", "vite.config.ts"],
            },
          });
          return { site };
        }),
      );

      const url = deployed.site.url as string;
      expect(url).toMatch(cloudRunUrl);
      expect(deployed.site.service).toBeDefined();
      const service = serviceIdentity(deployed.site.service!);

      yield* expectUrlContains(`${url}/`, "Foldkit Fixture", {
        timeout: "180 seconds",
        label: "Foldkit /",
      });
      yield* expectUrlContains(`${url}/counter/42`, "Foldkit Fixture", {
        timeout: "30 seconds",
        label: "Foldkit /counter/42",
      });

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(900_000),
);

// One Cloud Run service walked through every server-rendered mode: each
// redeploy replaces the build, and every route must answer for the new mode.
test.provider.skipIf(!!process.env.FAST)(
  "Foldkit: ssg, ssr and hybrid render every route across redeploys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      let service: DeployedService | undefined;
      for (const mode of ["ssg", "ssr", "hybrid"] as const) {
        const rootDir = yield* foldkitFixture(mode);
        const site = yield* stack.deploy(
          GCP.Website.Foldkit("Web", { rootDir, memo: foldkitMemo }),
        );
        expect(site.url).toMatch(cloudRunUrl);
        expect(site.service).toBeDefined();
        service = serviceIdentity(site.service!);
        yield* verifyFoldkitRendering(site.url as string, mode);
        yield* verifyFoldkitBrowser(site.url as string, mode);
      }

      yield* stack.destroy();
      yield* assertSiteGone(service!);
    }).pipe(logLevel),
  liveOptions(1_800_000),
);
