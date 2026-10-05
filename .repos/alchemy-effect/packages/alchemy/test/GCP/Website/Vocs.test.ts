import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { dockerAvailable } from "../bindingHost.ts";
import {
  assertSiteGone,
  cloudRunUrl,
  liveOptions,
  logLevel,
  serviceIdentity,
  tempRoot,
} from "./site.ts";

const { test } = Test.make({ providers: GCP.providers() });

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../../../../examples/cloudflare-website-vocs",
);
const fixtureEntries = [
  "package.json",
  "public",
  "src",
  "tsconfig.json",
  "vocs.config.ts",
];

test.provider.skipIf(!dockerAvailable)(
  "Vocs: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vocs-gcp-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* GCP.Website.Vocs("Web", {
            rootDir,
            memo: {
              include: [
                "src/**",
                "public/**",
                "package.json",
                "tsconfig.json",
                "vocs.config.ts",
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

      yield* expectUrlContains(`${url}/`, "Alchemy with Vocs", {
        timeout: "180 seconds",
        label: "Vocs /",
      });

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(900_000),
);
