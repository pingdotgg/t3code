import * as Hetzner from "@/Hetzner";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Hetzner.providers(), dev: true });

/**
 * SolidStart 2's dev SSR does not run under Bun (`srvx/node` writes
 * `[object Object]`). Body assertions stay gated; identity (localhost,
 * no cloud rows) is asserted unconditionally. Set
 * `ALCHEMY_TEST_SOLIDSTART_DEV_SSR=1` to run the body assertions on a
 * Node-hosted sidecar.
 */
const runDevSsr = process.env.ALCHEMY_TEST_SOLIDSTART_DEV_SSR === "1";

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../AWS/Website/fixtures/solidstart-app",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "vite.config.ts",
  "src",
  "public",
];

describe("Hetzner.Website.SolidStart local", () => {
  test.provider(
    "dev runs the framework server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-solidstart-hetzner-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Hetzner.Website.SolidStart("Web", {
              rootDir,
            });
            return { site };
          }),
        );

        const url = deployed.site.url;
        expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
        expect(deployed.site.service).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );

  test.provider.skipIf(!runDevSsr)(
    "dev serves SSR home and API routes",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-solidstart-hetzner-local-ssr-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Hetzner.Website.SolidStart("Web", {
              rootDir,
            });
            return { site };
          }),
        );

        const url = deployed.site.url;
        yield* expectUrlContains(`${url}/`, "SOLIDSTART_AWS_PAGE_MARKER", {
          timeout: "90 seconds",
          label: "dev home page",
        });
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "SOLIDSTART_AWS_API_MARKER",
          { label: "api route (dev)" },
        );
        yield* expectUrlContains(
          `${url}/prerendered`,
          "SOLIDSTART_AWS_PRERENDERED_MARKER",
          { label: "extra route (dev)" },
        );

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );
});
