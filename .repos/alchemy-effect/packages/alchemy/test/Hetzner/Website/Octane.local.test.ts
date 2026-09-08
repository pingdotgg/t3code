import * as Hetzner from "@/Hetzner";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Hetzner.providers(), dev: true });

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../AWS/Website/fixtures/octane-app",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "octane.config.ts",
  "vite.config.ts",
  "index.html",
  "src",
  "public",
];

describe("Hetzner.Website.Octane local", () => {
  test.provider(
    "dev runs the framework server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-octane-hetzner-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const fs = yield* FileSystem.FileSystem;
        const pathMod = yield* Path.Path;
        const configPath = pathMod.join(rootDir, "octane.config.ts");
        const raw = yield* fs.readFileString(configPath);
        yield* fs.writeFileString(
          configPath,
          raw
            .replaceAll(
              "@alchemy.run/frontend-frameworks/octane/aws-adapter",
              "@alchemy.run/frontend-frameworks/octane/node-adapter",
            )
            .replaceAll("{ aws }", "{ node }")
            .replaceAll("adapter: aws()", "adapter: node()"),
        );

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Hetzner.Website.Octane("Web", {
              rootDir,
            });
            return { site };
          }),
        );

        const url = deployed.site.url;
        expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
        expect(deployed.site.service).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();

        yield* expectUrlContains(`${url}/`, "OCTANE_AWS_PAGE_MARKER", {
          timeout: "90 seconds",
          label: "dev home page",
        });
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "OCTANE_AWS_API_MARKER",
          { label: "api route (dev)" },
        );

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );
});
