import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as monitoring from "@distilled.cloud/gcp/monitoring_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const latencyFilter =
  'metric.type="serviceruntime.googleapis.com/api/request_latencies" AND resource.type="consumed_api"';

const waitUntilGone = (name: string) =>
  monitoring.getServicesServiceLevelObjectives({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a service level objective",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const checkout = yield* GCP.Monitoring.Service("Checkout", {
            displayName: "Checkout",
            labels: { env: "test" },
          });
          const slo = yield* GCP.Monitoring.ServicesServiceLevelObjective(
            "Latency",
            {
              service: checkout.name,
              displayName: "99% latency",
              goal: 0.99,
              rollingPeriod: "86400s",
              serviceLevelIndicator: {
                requestBased: {
                  distributionCut: {
                    distributionFilter: latencyFilter,
                    range: { max: 500 },
                  },
                },
              },
              labels: { env: "test" },
            },
          );
          return { checkout, slo };
        }),
      );

      expect(created.slo.name).toContain("/serviceLevelObjectives/");
      expect(created.slo.service).toEqual(created.checkout.name);
      expect(created.slo.displayName).toEqual("99% latency");
      expect(created.slo.goal).toEqual(0.99);
      expect(created.slo.rollingPeriod).toEqual("86400s");
      expect(created.slo.labels).toMatchObject({ env: "test" });
      expect(
        created.slo.serviceLevelIndicator?.requestBased?.distributionCut?.range
          ?.max,
      ).toEqual(500);

      const fetched = yield* monitoring.getServicesServiceLevelObjectives({
        name: created.slo.name,
      });
      expect(fetched.name).toEqual(created.slo.name);
      expect(fetched.goal).toEqual(0.99);
      expect(fetched.userLabels?.env).toEqual("test");
      expect(
        Object.keys(fetched.userLabels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const checkout = yield* GCP.Monitoring.Service("Checkout", {
            serviceId: created.checkout.serviceId,
            displayName: "Checkout",
            labels: { env: "test" },
          });
          const slo = yield* GCP.Monitoring.ServicesServiceLevelObjective(
            "Latency",
            {
              service: checkout.name,
              serviceLevelObjectiveId: created.slo.serviceLevelObjectiveId,
              displayName: "95% latency",
              goal: 0.95,
              rollingPeriod: "604800s",
              serviceLevelIndicator: {
                requestBased: {
                  distributionCut: {
                    distributionFilter: latencyFilter,
                    range: { max: 1000 },
                  },
                },
              },
              labels: { env: "prod" },
            },
          );
          return { checkout, slo };
        }),
      );

      expect(updated.slo.name).toEqual(created.slo.name);
      expect(updated.slo.displayName).toEqual("95% latency");
      expect(updated.slo.goal).toEqual(0.95);
      expect(updated.slo.rollingPeriod).toEqual("604800s");
      expect(
        updated.slo.serviceLevelIndicator?.requestBased?.distributionCut?.range
          ?.max,
      ).toEqual(1000);
      expect(updated.slo.labels).toMatchObject({ env: "prod" });

      const fetchedUpdate = yield* monitoring.getServicesServiceLevelObjectives(
        {
          name: updated.slo.name,
        },
      );
      expect(fetchedUpdate.goal).toEqual(0.95);
      expect(fetchedUpdate.displayName).toEqual("95% latency");
      expect(fetchedUpdate.userLabels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.slo.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:monitoring", "live"],
    timeout: 90_000,
  },
);
