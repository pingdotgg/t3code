import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { dockerAvailable } from "../bindingHost.ts";
import {
  assertSiteGone,
  awsFixture,
  cloudRunUrl,
  liveOptions,
  logLevel,
  serviceIdentity,
  tempRoot,
} from "./site.ts";

const { test } = Test.make({ providers: GCP.providers() });

const fixtureDir = awsFixture("astro-app");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "astro.config.mjs",
  "src",
  "public",
];

test.provider.skipIf(!dockerAvailable)(
  "Astro SSR: deploy, GET / and an API route, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-astro-gcp-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* GCP.Website.Astro("Web", {
            rootDir,
            memo: {
              include: [
                "src/**",
                "public/**",
                "package.json",
                "astro.config.mjs",
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

      yield* expectUrlContains(`${url}/`, "ASTRO_AWS_PAGE_MARKER", {
        timeout: "180 seconds",
        label: "Astro /",
      });
      yield* expectUrlContains(
        `${url}/api/hello?echo=roundtrip`,
        "ASTRO_AWS_API_MARKER",
        {
          timeout: "30 seconds",
          label: "Astro /api/hello?echo=roundtrip",
        },
      );

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(900_000),
);
