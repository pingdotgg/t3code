import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../../../../examples/cloudflare-website-vocs",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

describe.concurrent("Vocs dev", () => {
  test.provider(
    "Vocs dev: serves SSR, MDX and assets locally and responds to source edits",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-vocs-dev-",
          tempRoot,
          entries: [
            "package.json",
            "public",
            "src",
            "tsconfig.json",
            "vocs.config.ts",
          ],
        });

        const site = yield* stack.deploy(
          Cloudflare.Website.Vocs("VocsLocal", {
            rootDir,
            dev: { port: 0 },
            memo: {
              include: [
                "src/**",
                "public/**",
                "package.json",
                "tsconfig.json",
                "vocs.config.ts",
              ],
            },
          }),
        );

        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        yield* expectUrlContains(`${site.url!}/`, "Alchemy with Vocs", {
          timeout: "180 seconds",
          label: "Vocs dev SSR home",
        });
        yield* expectUrlContains(`${site.url!}/guide`, "Deployment guide", {
          timeout: "60 seconds",
          label: "Vocs dev MDX guide",
        });
        yield* expectUrlContains(
          `${site.url!}/hello.txt`,
          "hello from the Vocs public directory",
          {
            timeout: "60 seconds",
            label: "Vocs dev public asset",
          },
        );

        const pagePath = path.join(rootDir, "src/pages/index.mdx");
        const page = yield* fs.readFileString(pagePath);
        yield* fs.writeFileString(
          pagePath,
          page.replace(
            "No Wrangler configuration or Vocs adapter setup is required.",
            "This Vocs page was updated through HMR.",
          ),
        );
        yield* expectUrlContains(
          `${site.url!}/?__alchemy_cb=${Date.now()}`,
          "This Vocs page was updated through HMR.",
          {
            timeout: "120 seconds",
            label: "Vocs dev page after source edit",
          },
        );

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );
});
