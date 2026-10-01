import * as Hetzner from "@/Hetzner";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
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
  "../../Cloudflare/Website/vite-spa-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = ["index.html", "package.json", "src"];

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
  "Vite SPA: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-hetzner-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Hetzner.Website.Vite("Web", {
            rootDir,
            memo: {
              include: ["index.html", "src/**", "package.json"],
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
      expect(deployed.site.service!.serverId).toEqual(
        deployed.site.server!.serverId,
      );

      yield* expectUrlContains(`${url!}/`, "Vite SPA fixture", {
        timeout: "30 seconds",
        label: "vite spa index",
      });
      yield* expectUrlContains(
        `${url!}/missing-client-route`,
        "Vite SPA fixture",
        {
          timeout: "15 seconds",
          label: "vite spa fallback",
        },
      );

      const client = yield* HttpClient.HttpClient;
      const health = yield* client.get(`${url!}/health`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.text
            : Effect.fail(new Error(`health returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      expect(health).toContain("ok");

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
  { timeout: 180_000 },
);
