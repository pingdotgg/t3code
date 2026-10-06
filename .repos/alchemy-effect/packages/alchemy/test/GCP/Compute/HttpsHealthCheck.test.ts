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

const waitUntilGone = (project: string, httpsHealthCheck: string) =>
  compute.getHttpsHealthChecks({ project, httpsHealthCheck }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete an HTTPS health check",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.HttpsHealthCheck("Api", {
            description: "frontend probe",
            port: 443,
            requestPath: "/health",
          });
        }),
      );

      expect(created.httpsHealthCheckName).toEqual(expect.any(String));
      expect(created.description).toEqual("frontend probe");
      expect(created.port).toEqual(443);
      expect(created.requestPath).toEqual("/health");
      expect(created.checkIntervalSec).toEqual(5);
      expect(created.healthyThreshold).toEqual(2);

      const fetched = yield* compute.getHttpsHealthChecks({
        project: created.project,
        httpsHealthCheck: created.httpsHealthCheckName,
      });
      expect(fetched.name).toEqual(created.httpsHealthCheckName);
      expect(fetched.port).toEqual(443);
      expect(fetched.requestPath).toEqual("/health");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("frontend probe");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.HttpsHealthCheck("Api", {
            httpsHealthCheckName: created.httpsHealthCheckName,
            description: "ready probe",
            checkIntervalSec: 10,
            timeoutSec: 5,
            healthyThreshold: 3,
            port: 8443,
            requestPath: "/ready",
            host: "ready.example",
          });
        }),
      );

      expect(updated.httpsHealthCheckName).toEqual(
        created.httpsHealthCheckName,
      );
      expect(updated.description).toEqual("ready probe");
      expect(updated.checkIntervalSec).toEqual(10);
      expect(updated.healthyThreshold).toEqual(3);
      expect(updated.port).toEqual(8443);
      expect(updated.requestPath).toEqual("/ready");
      expect(updated.host).toEqual("ready.example");

      const refetched = yield* compute.getHttpsHealthChecks({
        project: updated.project,
        httpsHealthCheck: updated.httpsHealthCheckName,
      });
      expect(refetched.requestPath).toEqual("/ready");
      expect(refetched.checkIntervalSec).toEqual(10);
      expect(refetched.port).toEqual(8443);
      expect(refetched.host).toEqual("ready.example");

      const nextName = `r${created.httpsHealthCheckName}`
        .slice(0, 63)
        .replace(/-+$/, "x");
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.HttpsHealthCheck("Api", {
            httpsHealthCheckName: nextName,
            description: "replaced probe",
            requestPath: "/live",
          });
        }),
      );

      expect(replaced.httpsHealthCheckName).toEqual(nextName);
      expect(replaced.description).toEqual("replaced probe");
      expect(replaced.requestPath).toEqual("/live");
      expect(replaced.port).toEqual(443);

      const afterReplace = yield* compute.getHttpsHealthChecks({
        project: replaced.project,
        httpsHealthCheck: replaced.httpsHealthCheckName,
      });
      expect(afterReplace.name).toEqual(nextName);
      expect(afterReplace.requestPath).toEqual("/live");

      const oldGone = yield* waitUntilGone(
        created.project,
        created.httpsHealthCheckName,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.project,
        replaced.httpsHealthCheckName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
