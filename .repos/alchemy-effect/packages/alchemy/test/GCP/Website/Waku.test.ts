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

const fixtureDir = awsFixture("waku-app");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "tsconfig.json",
  "src",
  "public",
];

test.provider.skipIf(!dockerAvailable)(
  "Waku: deploy, GET page, RSC and SSG routes, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-waku-gcp-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* GCP.Website.Waku("Web", {
            rootDir,
            memo: {
              include: ["src/**", "public/**", "package.json", "tsconfig.json"],
            },
          });
          return { site };
        }),
      );

      const url = deployed.site.url as string;
      expect(url).toMatch(cloudRunUrl);
      expect(deployed.site.service).toBeDefined();
      const service = serviceIdentity(deployed.site.service!);

      yield* expectUrlContains(`${url}/`, "WAKU_AWS_PAGE_MARKER", {
        timeout: "180 seconds",
        label: "Waku /",
      });
      yield* expectUrlContains(
        `${url}/echo?echo=roundtrip`,
        "WAKU_AWS_API_MARKER",
        {
          timeout: "30 seconds",
          label: "Waku /echo?echo=roundtrip",
        },
      );
      yield* expectUrlContains(`${url}/about`, "WAKU_AWS_STATIC_MARKER", {
        timeout: "30 seconds",
        label: "Waku /about",
      });

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(900_000),
);
