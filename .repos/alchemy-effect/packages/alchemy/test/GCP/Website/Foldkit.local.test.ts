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
  "../../Cloudflare/Website/foldkit-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = ["index.html", "package.json", "vite.config.ts", "src"];

describe(
  "GCP.Website.Foldkit local",
  { tags: ["provider:gcp", "provider:gcp:website", "local"] },
  () => {
    test.provider(
      "dev runs the framework server with no cloud resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-foldkit-gcp-local-",
            tempRoot,
            entries: fixtureEntries,
          });

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* GCP.Website.Foldkit("Web", {
                rootDir,
              });
              return { site };
            }),
          );

          const url = deployed.site.url;
          expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
          expect(deployed.site.service).toBeUndefined();

          yield* expectUrlContains(`${url}/`, "Foldkit Fixture", {
            timeout: "90 seconds",
            label: "dev home page",
          });
          yield* expectUrlContains(`${url}/counter/42`, "Foldkit Fixture", {
            label: "spa fallback",
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
