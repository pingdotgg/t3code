import * as Hetzner from "@/Hetzner";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../AWS/Website/fixtures/waku-app",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "tsconfig.json",
  "src",
  "public",
];

const waitUntilGone = (id: number) =>
  Services.servers.getServer({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "Waku: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-waku-hetzner-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Hetzner.Website.Waku("Web", {
            rootDir,
            memo: {
              include: ["src/**", "public/**", "package.json", "tsconfig.json"],
            },
          });
          return { site };
        }),
      );

      const url = deployed.site.url;
      expect(url).toBeDefined();
      expect(url).toMatch(/^http:\/\//);
      expect(deployed.site.service).toBeDefined();
      expect(deployed.site.server).toBeDefined();

      yield* expectUrlContains(`${url!}/`, "WAKU_AWS_PAGE_MARKER", {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(
        `${url!}/echo?echo=roundtrip`,
        "WAKU_AWS_API_MARKER",
        {
          timeout: "30 seconds",
          label: "api route",
        },
      );
      yield* expectUrlContains(`${url!}/about`, "WAKU_AWS_STATIC_MARKER", {
        timeout: "30 seconds",
        label: "extra route",
      });

      const serverId = deployed.site.server!.serverId;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(serverId);
      expect(gone).toEqual("gone");
    }).pipe(
      logLevel,
      Effect.ensuring(stack.destroy().pipe(Effect.orDie)),
      Effect.catchTag(["PreconditionFailed", "Forbidden"], (error) =>
        Effect.logWarning(`skipping: Hetzner quota (${error._tag})`),
      ),
    ),
  { timeout: 180000 },
);
