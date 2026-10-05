import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import { sameStopConfig } from "@/Fly/replicas.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import {
  assertAppGone,
  assertMachineGone,
  assertOnlyMachine,
  getText,
  initialText,
  startTraffic,
  websiteChecks,
  websiteServices,
} from "./fixtures/deployment.ts";

const { test } = Test.make({ providers: Fly.providers() });
const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "R08/R02 StaticSite: build v1 to v2 under un-retried traffic, forwarded policies, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* cloneFixture(
        path.resolve(
          import.meta.dirname,
          "../../Cloudflare/Website/staticsite-fixture",
        ),
        {
          prefix: "alchemy-staticsite-fly-",
          tempRoot: path.resolve(import.meta.dirname, "../../../.tmp"),
          entries: ["src", "build.sh"],
        },
      );
      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const site = yield* Fly.Website.StaticSite("Blog", {
              path: cwd,
              build: { command: "bash build.sh", output: "dist" },
              memo: { include: ["src/**", "build.sh"] },
              deploy: { strategy: "bluegreen", healthTimeout: "90 seconds" },
              shutdown: { signal: "SIGTERM", timeout: "10 seconds" },
              checks: websiteChecks("/index.html"),
              services: websiteServices("/index.html"),
            });
            return { site };
          }),
        );
      let appName: string | undefined;
      yield* Effect.gen(function* () {
        const first = yield* deploy();
        appName = first.site.app!.appName;
        const url = first.site.url!;
        const oldId = first.site.service!.machineId;
        expect(url).toBe(`https://${appName}.fly.dev`);
        const firstBody = yield* initialText(`${url}/`);
        expect(firstBody).toContain("StaticSite fixture v1");
        const observed = yield* machines.getMachine({
          app_name: appName,
          machine_id: oldId,
        });
        expect(observed.config?.metadata?.["alchemy.phase"]).toBe("active");
        expect(observed.config?.stop_config?.signal).toBe("SIGTERM");
        expect(
          sameStopConfig(observed.config?.stop_config, {
            signal: "SIGTERM",
            timeout: "10000ms",
          }),
        ).toBe(true);
        expect(observed.config?.checks?.website?.path).toBe("/index.html");
        expect(observed.config?.services?.[0]?.checks?.[0]?.path).toBe(
          "/index.html",
        );
        expect(
          observed.config?.env?.ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS,
        ).toBeUndefined();
        const traffic = yield* startTraffic(`${url}/`);
        yield* traffic.waitFor((body) =>
          body.includes("StaticSite fixture v1"),
        );
        const index = path.join(cwd, "src/index.html");
        yield* fs.writeFileString(
          index,
          (yield* fs.readFileString(index)).replaceAll(
            "fixture v1",
            "fixture v2",
          ),
        );
        const second = yield* deploy();
        const newId = second.site.service!.machineId;
        expect(
          yield* fs.readFileString(path.join(cwd, "dist/index.html")),
        ).toContain("StaticSite fixture v2");
        expect(second.site.service!.code.hash).not.toBe(
          first.site.service!.code.hash,
        );
        const updated = yield* machines.getMachine({
          app_name: appName,
          machine_id: newId,
        });
        expect(updated.config?.image).not.toBe(observed.config?.image);
        expect(second.site.url).toBe(url);
        expect(newId).not.toBe(oldId);
        const secondBody = yield* getText(`${url}/`);
        expect(secondBody).toContain("StaticSite fixture v2");
        yield* traffic.waitFor((body) =>
          body.includes("StaticSite fixture v2"),
        );
        const samples = yield* traffic.finish;
        for (const body of samples)
          expect([firstBody, secondBody]).toContain(body);
        yield* assertMachineGone(appName, oldId);
        yield* assertOnlyMachine(appName, newId);
      }).pipe(
        Effect.scoped,
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy();
            if (appName) yield* assertAppGone(appName);
          }).pipe(Effect.orDie),
        ),
      );
    }).pipe(logLevel),
  // Two build-command/image deployments, proxy overlap, and final cloud census.
  {
    tags: [
      "provider:fly",
      "provider:fly:machine",
      "provider:fly:website",
      "live",
    ],
    timeout: 720_000,
  },
);
