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

const fixtureDir = awsFixture("react-router-app");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "react-router.config.ts",
  "vite.config.ts",
  "app",
  "public",
];

test.provider.skipIf(!dockerAvailable)(
  "ReactRouter: deploy, GET page and API route, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-react-router-gcp-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* GCP.Website.ReactRouter("Web", {
            rootDir,
            memo: {
              include: [
                "app/**",
                "public/**",
                "package.json",
                "react-router.config.ts",
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

      yield* expectUrlContains(`${url}/`, "REACT_ROUTER_AWS_PAGE_MARKER", {
        timeout: "180 seconds",
        label: "ReactRouter /",
      });
      yield* expectUrlContains(
        `${url}/api/hello?echo=roundtrip`,
        "REACT_ROUTER_AWS_API_MARKER",
        {
          timeout: "30 seconds",
          label: "ReactRouter /api/hello?echo=roundtrip",
        },
      );

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(900_000),
);
