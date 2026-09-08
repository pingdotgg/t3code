import * as railway from "@distilled.cloud/railway";
import * as Railway from "@/Railway";
import { suitePartition } from "../suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../Cloudflare/Website/vite-spa-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = ["index.html", "package.json", "src"];

const waitUntilGone = (serviceId: string) =>
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) =>
      service.deletedAt != null ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "Vite SPA: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-railway-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const site = yield* Railway.Website.Vite("Web", {
            project,
            environment,
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
      expect(url).toMatch(/^https:\/\//);
      expect(deployed.site.service).toBeDefined();
      expect(deployed.site.service!.serviceId.length).toBeGreaterThan(0);
      expect(deployed.site.project).toBeDefined();

      yield* expectUrlContains(`${url!}/`, "Vite SPA fixture", {
        timeout: "90 seconds",
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

      const serviceId = deployed.site.service!.serviceId;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(serviceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
