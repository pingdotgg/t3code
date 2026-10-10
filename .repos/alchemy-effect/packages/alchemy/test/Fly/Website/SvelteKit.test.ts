import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import { sameStopConfig } from "@/Fly/replicas.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as HttpClient from "effect/http/HttpClient";
import { createHash } from "node:crypto";
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

type ResponseRecord = {
  event: string;
  version: string;
  machine: string;
  managedTimeout: null;
  payload?: string;
  startedAt: number;
  signaledAt: number;
  completedAt: number;
  signal: string;
  activeAtSignal: number;
  shutdownMs: number;
};

for (const policy of [
  {
    old: "60 seconds",
    next: "10 seconds",
    oldMs: 60_000,
    nextMs: 10_000,
    delay: 12_000,
    signal: "SIGTERM",
    nextSignal: "SIGINT",
  },
  {
    old: "10 seconds",
    next: "60 seconds",
    oldMs: 10_000,
    nextMs: 60_000,
    delay: 3_000,
    signal: "SIGINT",
    nextSignal: "SIGTERM",
  },
] as const) {
  test.provider(
    `R08/R02 SvelteKit external SSR: v1 to v2, old ${policy.old}/${policy.signal}, new ${policy.next}/${policy.nextSignal}, application-owned response drain`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const rootDir = yield* cloneFixture(
          path.resolve(
            import.meta.dirname,
            "../../AWS/Website/fixtures/sveltekit-app",
          ),
          {
            prefix: "alchemy-sveltekit-fly-",
            tempRoot: path.resolve(import.meta.dirname, "../../../.tmp"),
            entries: [".gitignore", "package.json", "src", "static"],
          },
        );
        const route = path.join(
          rootDir,
          "src/routes/api/deployment/[operation]",
        );
        yield* fs.makeDirectory(route, { recursive: true });
        for (const file of ["+server.ts", "state.ts", "version.ts"]) {
          yield* fs.writeFileString(
            path.join(route, file),
            yield* fs.readFileString(
              path.join(
                import.meta.dirname,
                "fixtures/sveltekit/src/routes/api/deployment/[operation]",
                file,
              ),
            ),
          );
        }
        yield* fs.writeFileString(
          path.join(rootDir, "src/hooks.server.ts"),
          yield* fs.readFileString(
            path.join(
              import.meta.dirname,
              "fixtures/sveltekit/src/hooks.server.ts",
            ),
          ),
        );
        const pagePath = path.join(rootDir, "src/routes/+page.server.ts");
        const page = yield* fs.readFileString(pagePath);
        const writeVersion = (version: string) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(
              path.join(route, "version.ts"),
              `export const version: string = ${JSON.stringify(version)};\n`,
            );
            yield* fs.writeFileString(
              pagePath,
              page.replace(
                "SVELTEKIT_AWS_PAGE_MARKER",
                `SVELTEKIT_AWS_PAGE_MARKER ${version}`,
              ),
            );
          });
        const deploy = (next: boolean) =>
          stack.deploy(
            Effect.gen(function* () {
              const site = yield* Fly.Website.SvelteKit("Web", {
                rootDir,
                deploy: { strategy: "bluegreen", healthTimeout: "90 seconds" },
                shutdown: {
                  signal: next ? policy.nextSignal : policy.signal,
                  timeout: next ? policy.next : policy.old,
                },
                checks: websiteChecks("/api/deployment/ready"),
                services: websiteServices("/api/deployment/ready"),
                env: {
                  WEBSITE_SHUTDOWN_MS: String(
                    next ? policy.nextMs : policy.oldMs,
                  ),
                  WEBSITE_AFTER_SIGNAL_MS: String(next ? 1000 : policy.delay),
                },
                memo: { include: ["src/**", "static/**", "package.json"] },
              });
              return { site };
            }),
          );
        let appName: string | undefined;
        yield* Effect.gen(function* () {
          yield* writeVersion("v1");
          const first = yield* deploy(false);
          appName = first.site.app!.appName;
          const oldId = first.site.service!.machineId;
          const url = first.site.url!;
          expect(url).toBe(`https://${appName}.fly.dev`);
          expect(yield* initialText(`${url}/`)).toContain(
            "SVELTEKIT_AWS_PAGE_MARKER v1",
          );
          expect(yield* getText(`${url}/api/hello?echo=roundtrip`)).toContain(
            "SVELTEKIT_AWS_API_MARKER",
          );
          expect(
            JSON.parse(yield* getText(`${url}/api/deployment/version`)),
          ).toEqual({ version: "v1", machine: oldId, managedTimeout: null });
          const oldMachine = yield* machines.getMachine({
            app_name: appName,
            machine_id: oldId,
          });
          expect(oldMachine.config?.checks?.website?.path).toBe(
            "/api/deployment/ready",
          );
          expect(oldMachine.config?.services?.[0]?.checks?.[0]?.path).toBe(
            "/api/deployment/ready",
          );
          expect(oldMachine.config?.stop_config?.signal).toBe(policy.signal);
          expect(
            sameStopConfig(oldMachine.config?.stop_config, {
              signal: policy.signal,
              timeout: `${policy.oldMs}ms`,
            }),
          ).toBe(true);
          expect(
            oldMachine.config?.env?.ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS,
          ).toBeUndefined();

          const slowStarted = yield* Deferred.make<void>();
          const streamStarted = yield* Deferred.make<void>();
          const slowRequest = (
            operation: string,
            started: Deferred.Deferred<void>,
          ) =>
            HttpClient.get(`${url}/api/deployment/${operation}`, {
              headers: { connection: "close" },
            }).pipe(
              Effect.tap((response) =>
                Effect.gen(function* () {
                  expect(response.status).toBe(200);
                  expect(response.headers["x-website-machine"]).toBe(oldId);
                  expect(response.headers["x-website-version"]).toBe("v1");
                  yield* Deferred.succeed(started, undefined);
                }),
              ),
              Effect.flatMap((response) => response.text),
              Effect.timeout("10 minutes"),
            );
          const slow = yield* slowRequest("slow", slowStarted).pipe(
            Effect.forkScoped,
          );
          const streamed = yield* slowRequest("stream", streamStarted).pipe(
            Effect.forkScoped,
          );
          yield* Effect.all(
            [Deferred.await(slowStarted), Deferred.await(streamStarted)],
            { concurrency: "unbounded" },
          ).pipe(Effect.timeout("20 seconds"));
          const traffic = yield* startTraffic(`${url}/api/deployment/version`);
          yield* traffic.waitFor((body) => JSON.parse(body).version === "v1");
          yield* writeVersion("v2");
          const second = yield* deploy(true);
          const newId = second.site.service!.machineId;
          expect(second.site.url).toBe(url);
          expect(newId).not.toBe(oldId);
          const slowResult = JSON.parse(
            yield* Fiber.join(slow),
          ) as ResponseRecord;
          const streamBody = yield* Fiber.join(streamed);
          const records = streamBody
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as ResponseRecord);
          expect(records[0].event).toBe("started");
          expect(
            records.filter((record) => record.event === "finished"),
          ).toHaveLength(1);
          expect(records[records.length - 1].event).toBe("finished");
          const completed = records[records.length - 1];
          const payload = records
            .map((record) => record.payload ?? "")
            .join("");
          const expected = "website-v1\n".repeat(8192);
          const hashes = yield* Effect.sync(() =>
            [payload, expected].map((value) =>
              createHash("sha256").update(value).digest("hex"),
            ),
          );
          expect(payload.length).toBe(expected.length);
          expect(hashes[0]).toBe(hashes[1]);
          for (const result of [slowResult, completed]) {
            expect(result.version).toBe("v1");
            expect(result.machine).toBe(oldId);
            expect(result.managedTimeout).toBeNull();
            expect(result.signal).toBe(policy.signal);
            expect(result.shutdownMs).toBe(policy.oldMs);
            expect(result.activeAtSignal).toBe(2);
            expect(result.signaledAt).toBeGreaterThan(result.startedAt);
            expect(
              result.completedAt - result.signaledAt,
            ).toBeGreaterThanOrEqual(policy.delay);
            expect(result.completedAt - result.signaledAt).toBeLessThan(
              policy.oldMs,
            );
          }
          expect(yield* getText(`${url}/`)).toContain(
            "SVELTEKIT_AWS_PAGE_MARKER v2",
          );
          yield* traffic.waitFor((body) => JSON.parse(body).version === "v2");
          const samples = yield* traffic.finish;
          for (const body of samples) {
            const sample = JSON.parse(body);
            expect(sample).toEqual({
              version: sample.version,
              machine: sample.version === "v1" ? oldId : newId,
              managedTimeout: null,
            });
            expect(["v1", "v2"]).toContain(sample.version);
          }
          const newMachine = yield* machines.getMachine({
            app_name: appName,
            machine_id: newId,
          });
          expect(newMachine.config?.stop_config?.signal).toBe(
            policy.nextSignal,
          );
          expect(
            sameStopConfig(newMachine.config?.stop_config, {
              signal: policy.nextSignal,
              timeout: `${policy.nextMs}ms`,
            }),
          ).toBe(true);
          expect(
            newMachine.config?.env?.ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS,
          ).toBeUndefined();
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
    // Includes two SSR/image builds, real registry pushes, old-policy drain and cleanup.
    {
      tags: [
        "provider:fly",
        "provider:fly:machine",
        "provider:fly:website",
        "live",
      ],
      timeout: 900_000,
    },
  );
}
