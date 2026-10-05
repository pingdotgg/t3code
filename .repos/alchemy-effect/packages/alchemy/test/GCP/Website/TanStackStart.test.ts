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

const fixtureDir = awsFixture("tanstack-start-app");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "vite.config.ts",
  "src",
  "public",
];

test.provider.skipIf(!dockerAvailable)(
  "TanStackStart: deploy, GET page and API route, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-tanstack-start-gcp-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* GCP.Website.TanStackStart("Web", {
            rootDir,
            memo: {
              include: [
                "src/**",
                "public/**",
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

      yield* expectUrlContains(`${url}/`, "TANSTACK_AWS_PAGE_MARKER", {
        timeout: "180 seconds",
        label: "TanStackStart /",
      });
      yield* expectUrlContains(
        `${url}/api/hello?echo=roundtrip`,
        "TANSTACK_AWS_API_MARKER",
        {
          timeout: "30 seconds",
          label: "TanStackStart /api/hello?echo=roundtrip",
        },
      );

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(900_000),
);
