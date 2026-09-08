import * as Hetzner from "@/Hetzner";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { prepareNextjsFixture } from "../../Cloudflare/Website/TypeScriptCompat.ts";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Hetzner.providers(), dev: true });

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

describe("Hetzner.Website.Nextjs local", () => {
  test.provider(
    "dev runs the framework server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Clone OUTSIDE the repo (OS temp dir): an in-workspace clone makes
        // Next treat the alchemy monorepo as the workspace root and look up
        // the root's typescript (catalog:build = tsgo).
        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-hetzner-local-",
          entries: fixtureEntries,
        });
        yield* prepareNextjsFixture(rootDir);

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Hetzner.Website.Nextjs("Web", {
              rootDir,
            });
            return { site };
          }),
        );

        const url = deployed.site.url;
        expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
        expect(deployed.site.service).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();

        yield* expectUrlContains(`${url}/`, "NEXTJS_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "dev home page",
        });
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "NEXTJS_AWS_API_MARKER",
          { label: "api route (dev)" },
        );
        yield* expectUrlContains(`${url}/static`, "NEXTJS_AWS_STATIC_MARKER", {
          label: "extra route (dev)",
        });

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});
