import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Fly.providers(), dev: true });

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

describe("Fly.Website.TanStackStart local", () => {
  test.provider(
    "dev runs the framework server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-tanstack-start-fly-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Fly.Website.TanStackStart("Web", {
              rootDir,
            });
            return { site };
          }),
        );

        const url = deployed.site.url;
        expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
        expect(deployed.site.service).toBeUndefined();
        expect(deployed.site.app).toBeUndefined();
        expect(deployed.site.ip).toBeUndefined();

        const origin = String(url).replace(/\/+$/, "");
        yield* expectUrlContains(`${origin}/`, "TANSTACK_AWS_PAGE_MARKER", {
          timeout: "90 seconds",
          label: "dev home page",
        });
        yield* expectUrlContains(
          `${origin}/api/hello?echo=roundtrip`,
          "TANSTACK_AWS_API_MARKER",
          { label: "api route (dev)" },
        );

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );
});
