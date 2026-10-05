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

const waitUntilGone = (name: string) =>
  monitoring.getProjectsMetricDescriptors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a metric descriptor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.MetricDescriptor("Paid", {
            displayName: "Invoice paid amount",
            description: "amount collected per invoice",
            labels: [{ key: "currency", valueType: "STRING" }],
          });
        }),
      );

      expect(created.name).toContain("/metricDescriptors/");
      expect(created.type.startsWith("custom.googleapis.com/")).toEqual(true);
      expect(created.metricKind).toEqual("GAUGE");
      expect(created.valueType).toEqual("DOUBLE");
      expect(created.unit).toEqual("1");
      expect(created.displayName).toEqual("Invoice paid amount");
      expect(created.description).toEqual("amount collected per invoice");
      expect(created.labels.some((label) => label.key === "currency")).toEqual(
        true,
      );

      const fetched = yield* monitoring
        .getProjectsMetricDescriptors({
          name: created.name,
        })
        .pipe(
          Effect.retry({
            times: 10,
            schedule: Schedule.exponential("200 millis"),
            while: (error) => error._tag === "NotFound",
          }),
        );
      expect(fetched.type).toEqual(created.type);
      expect(fetched.metricKind).toEqual("GAUGE");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("amount collected per invoice");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.MetricDescriptor("Paid", {
            type: created.type,
            displayName: "Invoice paid (cents)",
            description: "amount collected per invoice in cents",
            unit: "1",
            labels: [
              { key: "currency", valueType: "STRING" },
              { key: "source", valueType: "STRING" },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.type).toEqual(created.type);
      expect(updated.displayName).toEqual("Invoice paid (cents)");
      expect(updated.description).toEqual(
        "amount collected per invoice in cents",
      );
      expect(updated.labels.map((label) => label.key).sort()).toEqual(
        ["currency", "source"].sort(),
      );

      const fetchedUpdate = yield* monitoring
        .getProjectsMetricDescriptors({
          name: updated.name,
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (descriptor) =>
              descriptor.displayName === "Invoice paid (cents)" &&
              (descriptor.description ?? "").includes("in cents"),
            times: 10,
          }),
        );
      expect(fetchedUpdate.displayName).toEqual("Invoice paid (cents)");
      expect(fetchedUpdate.description).toContain("in cents");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.MetricDescriptor("Paid", {
            metricKind: "CUMULATIVE",
            valueType: "INT64",
            displayName: "Invoice paid count",
            description: "count of paid invoices",
          });
        }),
      );

      expect(replaced.metricKind).toEqual("CUMULATIVE");
      expect(replaced.valueType).toEqual("INT64");
      expect(replaced.description).toEqual("count of paid invoices");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:monitoring", "live"],
    timeout: 90_000,
  },
);
