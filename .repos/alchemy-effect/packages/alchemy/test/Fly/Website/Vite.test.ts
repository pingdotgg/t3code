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

for (const bluegreen of [true, false]) {
  test.provider(
    bluegreen
      ? "R08/R02 Vite SPA: v1 to v2 under un-retried traffic, forwarded policies, destroy, gone"
      : "R06 Vite SPA: omitted deploy/shutdown keeps default rolling Machine identity",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const rootDir = yield* cloneFixture(
          path.resolve(
            import.meta.dirname,
            "../../Cloudflare/Website/vite-spa-fixture",
          ),
          {
            prefix: "alchemy-vite-fly-",
            tempRoot: path.resolve(import.meta.dirname, "../../../.tmp"),
            entries: ["index.html", "package.json", "src"],
          },
        );
        const index = path.join(rootDir, "index.html");
        const original = yield* fs.readFileString(index);
        const writeVersion = (version: string) =>
          fs.writeFileString(
            index,
            original.replaceAll(
              "Vite SPA fixture",
              `Vite SPA fixture ${version}`,
            ),
          );
        const deploy = () =>
          stack.deploy(
            Effect.gen(function* () {
              const site = yield* Fly.Website.Vite("Web", {
                rootDir,
                ...(bluegreen
                  ? {
                      deploy: {
                        strategy: "bluegreen" as const,
                        healthTimeout: "90 seconds" as const,
                      },
                      shutdown: {
                        signal: "SIGTERM" as const,
                        timeout: "10 seconds" as const,
                      },
                      checks: websiteChecks("/index.html"),
                      services: websiteServices("/index.html"),
                    }
                  : {}),
                memo: { include: ["index.html", "src/**", "package.json"] },
              });
              return { site };
            }),
          );
        let appName: string | undefined;
        yield* Effect.gen(function* () {
          yield* writeVersion("v1");
          const first = yield* deploy();
          appName = first.site.app!.appName;
          const url = first.site.url!;
          const oldId = first.site.service!.machineId;
          expect(url).toBe(`https://${appName}.fly.dev`);
          const firstBody = yield* initialText(`${url}/`);
          expect(firstBody).toContain("Vite SPA fixture v1");
          const observed = yield* machines.getMachine({
            app_name: appName,
            machine_id: oldId,
          });
          expect(
            observed.config?.env?.ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS,
          ).toBeUndefined();
          if (bluegreen) {
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
          } else {
            expect(
              observed.config?.metadata?.["alchemy.generation"],
            ).toBeUndefined();
          }
          const traffic = bluegreen
            ? yield* startTraffic(`${url}/`)
            : undefined;
          if (traffic)
            yield* traffic.waitFor((body) =>
              body.includes("Vite SPA fixture v1"),
            );
          yield* writeVersion("v2");
          const second = yield* deploy();
          const newId = second.site.service!.machineId;
          expect(second.site.url).toBe(url);
          const secondBody = yield* getText(`${url}/`);
          expect(secondBody).toContain("Vite SPA fixture v2");
          if (traffic) {
            yield* traffic.waitFor((body) =>
              body.includes("Vite SPA fixture v2"),
            );
            const samples = yield* traffic.finish;
            for (const body of samples)
              expect([firstBody, secondBody]).toContain(body);
            expect(newId).not.toBe(oldId);
            yield* assertMachineGone(appName, oldId);
          } else {
            expect(newId).toBe(oldId);
          }
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
    // Two real frontend/image builds, registry pushes, routing overlap and teardown.
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
}
