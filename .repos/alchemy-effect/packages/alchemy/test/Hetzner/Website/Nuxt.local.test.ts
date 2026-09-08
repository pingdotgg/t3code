import * as Hetzner from "@/Hetzner";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Hetzner.providers(), dev: true });

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

describe("Hetzner.Website.Nuxt local", () => {
  test.provider(
    "dev runs the framework server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-hetzner-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Hetzner.Website.Nuxt("Web", {
              rootDir,
            });
            return { site };
          }),
        );

        const url = deployed.site.url;
        expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
        expect(deployed.site.service).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();

        yield* expectUrlContains(`${url}/`, "NUXT_AWS_PAGE_MARKER", {
          timeout: "90 seconds",
          label: "dev home page",
        });
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "NUXT_AWS_API_MARKER",
          { label: "api route (dev)" },
        );
        yield* expectUrlContains(
          `${url}/prerendered`,
          "NUXT_AWS_PRERENDERED_MARKER",
          { label: "extra route (dev)" },
        );

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );
});
