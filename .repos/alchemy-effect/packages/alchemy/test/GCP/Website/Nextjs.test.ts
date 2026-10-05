import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { prepareNextjsFixture } from "../../Cloudflare/Website/TypeScriptCompat.ts";
import { dockerAvailable } from "../bindingHost.ts";
import {
  assertSiteGone,
  awsFixture,
  cloudRunUrl,
  liveOptions,
  logLevel,
  serviceIdentity,
} from "./site.ts";

const { test } = Test.make({ providers: GCP.providers() });

const fixtureDir = awsFixture("nextjs-app");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "next.config.ts",
  "tsconfig.json",
  "app",
  "public",
];

test.provider.skipIf(!dockerAvailable)(
  "Nextjs: deploy, GET page, API and static routes, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Clone outside the repo: an in-workspace clone makes Next treat the
      // monorepo as the workspace root and pick up the root's typescript.
      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-nextjs-gcp-",
        entries: fixtureEntries,
      });
      yield* prepareNextjsFixture(rootDir);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* GCP.Website.Nextjs("Web", {
            rootDir,
            memo: {
              include: [
                "app/**",
                "public/**",
                "package.json",
                "next.config.ts",
                "tsconfig.json",
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

      yield* expectUrlContains(`${url}/`, "NEXTJS_AWS_PAGE_MARKER", {
        timeout: "180 seconds",
        label: "Nextjs /",
      });
      yield* expectUrlContains(
        `${url}/api/hello?echo=roundtrip`,
        "NEXTJS_AWS_API_MARKER",
        {
          timeout: "30 seconds",
          label: "Nextjs /api/hello?echo=roundtrip",
        },
      );
      yield* expectUrlContains(`${url}/static`, "NEXTJS_AWS_STATIC_MARKER", {
        timeout: "30 seconds",
        label: "Nextjs /static",
      });

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(1_200_000),
);
