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

const cpuFilter =
  'resource.type = "gce_instance" AND metric.type = "compute.googleapis.com/instance/cpu/utilization"';

const waitUntilGone = (name: string) =>
  monitoring.getProjectsAlertPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete an alert policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.AlertPolicy("CpuHigh", {
            combiner: "OR",
            conditions: [
              {
                displayName: "CPU > 90%",
                conditionThreshold: {
                  filter: cpuFilter,
                  comparison: "COMPARISON_GT",
                  thresholdValue: 0.9,
                  duration: "60s",
                  aggregations: [
                    {
                      alignmentPeriod: "60s",
                      perSeriesAligner: "ALIGN_MEAN",
                    },
                  ],
                },
              },
            ],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/alertPolicies/");
      expect(created.alertPolicyId).toEqual(expect.any(String));
      expect(created.combiner).toEqual("OR");
      expect(created.enabled).toEqual(true);
      expect(created.conditions.length).toEqual(1);
      expect(created.conditions[0]?.displayName).toEqual("CPU > 90%");
      expect(created.conditions[0]?.conditionThreshold?.thresholdValue).toEqual(
        0.9,
      );
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.notificationChannels).toEqual([]);

      const fetched = yield* monitoring.getProjectsAlertPolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.combiner).toEqual("OR");
      expect(
        fetched.conditions?.[0]?.conditionThreshold?.thresholdValue,
      ).toEqual(0.9);
      expect(fetched.userLabels?.env).toEqual("test");
      expect(
        Object.keys(fetched.userLabels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.AlertPolicy("CpuHigh", {
            displayName: created.displayName,
            combiner: "OR",
            enabled: false,
            conditions: [
              {
                displayName: "CPU > 50%",
                conditionThreshold: {
                  filter: cpuFilter,
                  comparison: "COMPARISON_GT",
                  thresholdValue: 0.5,
                  duration: "60s",
                  aggregations: [
                    {
                      alignmentPeriod: "60s",
                      perSeriesAligner: "ALIGN_MEAN",
                    },
                  ],
                },
              },
            ],
            labels: { env: "prod", role: "alerts" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.enabled).toEqual(false);
      expect(updated.conditions[0]?.displayName).toEqual("CPU > 50%");
      expect(updated.conditions[0]?.conditionThreshold?.thresholdValue).toEqual(
        0.5,
      );
      expect(updated.labels).toMatchObject({ env: "prod", role: "alerts" });

      const fetchedUpdate = yield* monitoring.getProjectsAlertPolicies({
        name: updated.name,
      });
      expect(fetchedUpdate.enabled).toEqual(false);
      expect(
        fetchedUpdate.conditions?.[0]?.conditionThreshold?.thresholdValue,
      ).toEqual(0.5);
      expect(fetchedUpdate.userLabels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:monitoring", "live"],
    timeout: 90_000,
  },
);
