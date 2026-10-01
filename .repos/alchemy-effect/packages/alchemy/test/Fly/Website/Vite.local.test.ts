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
  "../../Cloudflare/Website/vite-spa-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = ["index.html", "package.json", "src"];

describe("Fly.Website.Vite local", () => {
  test.provider(
    "dev runs Vite's own dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-vite-fly-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Fly.Website.Vite("ViteSite", {
              rootDir,
            });
            return { site };
          }),
        );

        const url = deployed.site.url;
        expect(url).toMatch(/^http:\/\/localhost:\d+\/?$/);
        expect(deployed.site.service).toBeUndefined();
        expect(deployed.site.app).toBeUndefined();
        expect(deployed.site.ip).toBeUndefined();

        yield* expectUrlContains(`${url}/`, "Vite SPA fixture", {
          timeout: "90 seconds",
          label: "dev index page",
        });

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );
});
