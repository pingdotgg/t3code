import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { dockerAvailable } from "../bindingHost.ts";
import {
  assertSiteGone,
  cloudRunUrl,
  cloudflareFixture,
  liveOptions,
  logLevel,
  serviceIdentity,
  tempRoot,
} from "./site.ts";

const { test } = Test.make({ providers: GCP.providers() });

const fixtureDir = cloudflareFixture("foldkit-fixture");
const fixtureEntries = ["index.html", "package.json", "vite.config.ts", "src"];

test.provider.skipIf(!dockerAvailable)(
  "Foldkit: deploy, GET / and a deep link, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-foldkit-gcp-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* GCP.Website.Foldkit("Web", {
            rootDir,
            memo: {
              include: [
                "index.html",
                "src/**",
                "package.json",
                "vite.config.ts",
              ],
            },
          });
          return { site };
        }),
      );

      const url = deployed.site.url as string;
      expect(url).toMatch(cloudRunUrl);
      expect(deployed.site.service).toBeDefined();
      const service = serviceIdentity(deployed.site.service!);

      yield* expectUrlContains(`${url}/`, "Foldkit Fixture", {
        timeout: "180 seconds",
        label: "Foldkit /",
      });
      yield* expectUrlContains(`${url}/counter/42`, "Foldkit Fixture", {
        timeout: "30 seconds",
        label: "Foldkit /counter/42",
      });

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(900_000),
);
