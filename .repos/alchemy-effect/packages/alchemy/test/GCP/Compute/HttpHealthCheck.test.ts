import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (project: string, httpHealthCheck: string) =>
  compute.getHttpHealthChecks({ project, httpHealthCheck }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete an HTTP health check",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.HttpHealthCheck("Api", {
            description: "frontend probe",
            port: 80,
            requestPath: "/health",
          });
        }),
      );

      expect(created.httpHealthCheckName).toEqual(expect.any(String));
      expect(created.description).toEqual("frontend probe");
      expect(created.port).toEqual(80);
      expect(created.requestPath).toEqual("/health");
      expect(created.checkIntervalSec).toEqual(5);
      expect(created.healthyThreshold).toEqual(2);

      const fetched = yield* compute.getHttpHealthChecks({
        project: created.project,
        httpHealthCheck: created.httpHealthCheckName,
      });
      expect(fetched.name).toEqual(created.httpHealthCheckName);
      expect(fetched.port).toEqual(80);
      expect(fetched.requestPath).toEqual("/health");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("frontend probe");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.HttpHealthCheck("Api", {
            httpHealthCheckName: created.httpHealthCheckName,
            description: "ready probe",
            checkIntervalSec: 10,
            timeoutSec: 5,
            healthyThreshold: 3,
            port: 8080,
            requestPath: "/ready",
            host: "ready.example",
          });
        }),
      );

      expect(updated.httpHealthCheckName).toEqual(created.httpHealthCheckName);
      expect(updated.description).toEqual("ready probe");
      expect(updated.checkIntervalSec).toEqual(10);
      expect(updated.healthyThreshold).toEqual(3);
      expect(updated.port).toEqual(8080);
      expect(updated.requestPath).toEqual("/ready");
      expect(updated.host).toEqual("ready.example");

      const refetched = yield* compute.getHttpHealthChecks({
        project: updated.project,
        httpHealthCheck: updated.httpHealthCheckName,
      });
      expect(refetched.requestPath).toEqual("/ready");
      expect(refetched.checkIntervalSec).toEqual(10);
      expect(refetched.port).toEqual(8080);
      expect(refetched.host).toEqual("ready.example");

      const nextName = `r${created.httpHealthCheckName}`
        .slice(0, 63)
        .replace(/-+$/, "x");
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.HttpHealthCheck("Api", {
            httpHealthCheckName: nextName,
            description: "replaced probe",
            requestPath: "/live",
          });
        }),
      );

      expect(replaced.httpHealthCheckName).toEqual(nextName);
      expect(replaced.description).toEqual("replaced probe");
      expect(replaced.requestPath).toEqual("/live");
      expect(replaced.port).toEqual(80);

      const afterReplace = yield* compute.getHttpHealthChecks({
        project: replaced.project,
        httpHealthCheck: replaced.httpHealthCheckName,
      });
      expect(afterReplace.name).toEqual(nextName);
      expect(afterReplace.requestPath).toEqual("/live");

      const oldGone = yield* waitUntilGone(
        created.project,
        created.httpHealthCheckName,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.project,
        replaced.httpHealthCheckName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
