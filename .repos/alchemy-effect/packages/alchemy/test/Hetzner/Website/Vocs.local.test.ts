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
  "../../../../../examples/cloudflare-website-vocs",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = [
  "package.json",
  "public",
  "src",
  "tsconfig.json",
  "vocs.config.ts",
];

describe("Hetzner.Website.Vocs local", () => {
  // Vocs' vite plugin reads `src/pages` from process.cwd() rather than
  // the project `root`, so alchemy-test (cwd = packages/alchemy) cannot
  // host the cloned fixture. Cloudflare.Website.Vocs local uses the
  // Worker source provider instead.
  test.provider.skipIf(true)(
    "dev runs the framework server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-vocs-hetzner-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Hetzner.Website.Vocs("Web", {
              rootDir,
            });
            return { site };
          }),
        );

        const url = deployed.site.url;
        expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
        expect(deployed.site.service).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();

        yield* expectUrlContains(`${url}/`, "Alchemy with Vocs", {
          timeout: "90 seconds",
          label: "dev home page",
        });

        yield* stack.destroy();
      }),
    { timeout: 180_000 },
  );
});
