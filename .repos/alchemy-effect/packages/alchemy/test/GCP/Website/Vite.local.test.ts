import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: GCP.providers(), dev: true });

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../Cloudflare/Website/vite-spa-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = ["index.html", "package.json", "src"];

describe(
  "GCP.Website.Vite local",
  { tags: ["provider:gcp", "provider:gcp:website", "local"] },
  () => {
    test.provider(
      "dev runs Vite's own dev server with no cloud resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-vite-gcp-local-",
            tempRoot,
            entries: fixtureEntries,
          });

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* GCP.Website.Vite("ViteSite", {
                rootDir,
              });
              return { site };
            }),
          );

          const url = deployed.site.url;
          expect(url).toMatch(/^http:\/\/localhost:\d+\/?$/);
          expect(deployed.site.service).toBeUndefined();

          yield* expectUrlContains(`${url}/`, "Vite SPA fixture", {
            timeout: "90 seconds",
            label: "dev index page",
          });

          yield* stack.destroy();
        }),
      {
        tags: ["provider:gcp", "provider:gcp:website", "live"],
        timeout: 120_000,
      },
    );
  },
);
