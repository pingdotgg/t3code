import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (metricName: string) =>
  logging.getProjectsMetrics({ metricName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a logs-based metric",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.Metric("Errors", {
            filter: "severity>=ERROR",
            description: "count errors",
          });
        }),
      );

      expect(created.metricId).toEqual(expect.any(String));
      expect(created.name).toContain("/metrics/");
      expect(created.filter).toEqual("severity>=ERROR");
      expect(created.description).toEqual("count errors");
      expect(created.disabled).toEqual(false);
      expect(created.metricDescriptor?.metricKind).toEqual("DELTA");
      expect(created.metricDescriptor?.valueType).toEqual("INT64");

      const fetched = yield* logging.getProjectsMetrics({
        metricName: created.name,
      });
      expect(fetched.name).toEqual(created.metricId);
      expect(fetched.filter).toEqual("severity>=ERROR");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("count errors");
      expect(fetched.disabled ?? false).toEqual(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.Metric("Errors", {
            metricId: created.metricId,
            filter: "severity>=WARNING",
            description: "count warnings",
            disabled: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.metricId).toEqual(created.metricId);
      expect(updated.filter).toEqual("severity>=WARNING");
      expect(updated.description).toEqual("count warnings");
      expect(updated.disabled).toEqual(true);
      expect(updated.createTime).toEqual(created.createTime);

      const fetchedUpdate = yield* logging.getProjectsMetrics({
        metricName: updated.name,
      });
      expect(fetchedUpdate.filter).toEqual("severity>=WARNING");
      expect(fetchedUpdate.disabled).toEqual(true);
      expect(fetchedUpdate.description).toContain("count warnings");

      const last = created.metricId.at(-1) ?? "a";
      const nextMetricId = `${created.metricId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.Metric("Errors", {
            metricId: nextMetricId,
            filter: "severity>=ERROR",
            description: "replaced counter",
          });
        }),
      );

      expect(replaced.metricId).not.toEqual(created.metricId);
      expect(replaced.filter).toEqual("severity>=ERROR");
      expect(replaced.disabled).toEqual(false);
      expect(replaced.description).toEqual("replaced counter");

      const fetchedReplace = yield* logging.getProjectsMetrics({
        metricName: replaced.name,
      });
      expect(fetchedReplace.name).toEqual(replaced.metricId);
      expect(fetchedReplace.filter).toEqual("severity>=ERROR");

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
