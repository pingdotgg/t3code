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

const waitUntilGone = (project: string, healthCheckName: string) =>
  compute.getHealthChecks({ project, healthCheck: healthCheckName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a health check",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.HealthCheck("Api", {
            description: "frontend probe",
            httpHealthCheck: { port: 80, requestPath: "/health" },
          });
        }),
      );

      expect(created.healthCheckName).toEqual(expect.any(String));
      expect(created.type).toEqual("HTTP");
      expect(created.description).toEqual("frontend probe");
      expect(created.httpHealthCheck?.requestPath).toEqual("/health");
      expect(created.checkIntervalSec).toEqual(5);

      const fetched = yield* compute.getHealthChecks({
        project: created.project,
        healthCheck: created.healthCheckName,
      });
      expect(fetched.name).toEqual(created.healthCheckName);
      expect(fetched.type).toEqual("HTTP");
      expect(fetched.httpHealthCheck?.requestPath).toEqual("/health");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("frontend probe");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.HealthCheck("Api", {
            healthCheckName: created.healthCheckName,
            description: "ready probe",
            checkIntervalSec: 10,
            timeoutSec: 5,
            healthyThreshold: 3,
            httpHealthCheck: { port: 80, requestPath: "/ready" },
          });
        }),
      );

      expect(updated.healthCheckName).toEqual(created.healthCheckName);
      expect(updated.type).toEqual("HTTP");
      expect(updated.description).toEqual("ready probe");
      expect(updated.checkIntervalSec).toEqual(10);
      expect(updated.healthyThreshold).toEqual(3);
      expect(updated.httpHealthCheck?.requestPath).toEqual("/ready");

      const refetched = yield* compute.getHealthChecks({
        project: updated.project,
        healthCheck: updated.healthCheckName,
      });
      expect(refetched.type).toEqual("HTTP");
      expect(refetched.httpHealthCheck?.requestPath).toEqual("/ready");
      expect(refetched.checkIntervalSec).toEqual(10);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.HealthCheck("Api", {
            healthCheckName: created.healthCheckName,
            description: "tcp probe",
            type: "TCP",
            tcpHealthCheck: { port: 8080 },
          });
        }),
      );

      expect(replaced.healthCheckName).toEqual(created.healthCheckName);
      expect(replaced.type).toEqual("TCP");
      expect(replaced.description).toEqual("tcp probe");
      expect(replaced.tcpHealthCheck?.port).toEqual(8080);

      const afterReplace = yield* compute.getHealthChecks({
        project: replaced.project,
        healthCheck: replaced.healthCheckName,
      });
      expect(afterReplace.type).toEqual("TCP");
      expect(afterReplace.tcpHealthCheck?.port).toEqual(8080);
      expect(afterReplace.httpHealthCheck).toBeUndefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.healthCheckName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
