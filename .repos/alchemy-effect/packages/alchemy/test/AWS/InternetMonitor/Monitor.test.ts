import * as AWS from "@/AWS";
import { Monitor } from "@/AWS/InternetMonitor";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as im from "@distilled.cloud/aws/internetmonitor";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on (getMonitor's
// Smithy model omits ResourceNotFoundException — patched in distilled).
test.provider(
  "getMonitor on a nonexistent monitor fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        im.getMonitor({
          MonitorName: "alchemy-nonexistent-internetmonitor-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Typed wait-until-gone after destroy.
const assertMonitorGone = (monitorName: string) =>
  im.getMonitor({ MonitorName: monitorName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`monitor ${monitorName} still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

describe("AWS.InternetMonitor.Monitor", () => {
  test.provider(
    "monitor lifecycle: create, update city-networks cap + tags, destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployMonitor = (props: {
          maxCityNetworksToMonitor: number;
          tags: Record<string, string>;
        }) =>
          stack.deploy(
            Effect.gen(function* () {
              const monitor = yield* Monitor("AppMonitor", {
                // No resources — an empty monitor is cheap and still
                // exercises the full PENDING -> ACTIVE lifecycle.
                resources: [],
                ...props,
              });
              return {
                monitorName: monitor.monitorName,
                monitorArn: monitor.monitorArn,
                status: monitor.status,
                maxCityNetworksToMonitor: monitor.maxCityNetworksToMonitor,
                tags: monitor.tags,
              };
            }),
          );

        const created = yield* deployMonitor({
          maxCityNetworksToMonitor: 1,
          tags: { purpose: "alchemy-test" },
        });
        expect(created.monitorArn).toContain(":monitor/");
        expect(created.status).toBe("ACTIVE");
        expect(created.maxCityNetworksToMonitor).toBe(1);
        expect(created.tags.purpose).toBe("alchemy-test");
        expect(created.tags["alchemy::id"]).toBe("AppMonitor");

        // Out-of-band verification via distilled.
        const observed = yield* im.getMonitor({
          MonitorName: created.monitorName,
        });
        expect(observed.MonitorArn).toBe(created.monitorArn);
        expect(observed.Status).toBe("ACTIVE");
        expect(observed.Resources).toEqual([]);
        expect(observed.MaxCityNetworksToMonitor).toBe(1);

        // Update in place: raise the city-networks cap and add a tag. The
        // monitor identity (name/arn) is stable.
        const updated = yield* deployMonitor({
          maxCityNetworksToMonitor: 2,
          tags: { purpose: "alchemy-test", updated: "true" },
        });
        expect(updated.monitorName).toBe(created.monitorName);
        expect(updated.monitorArn).toBe(created.monitorArn);
        expect(updated.maxCityNetworksToMonitor).toBe(2);
        expect(updated.tags.updated).toBe("true");

        const observedUpdated = yield* im.getMonitor({
          MonitorName: created.monitorName,
        });
        expect(observedUpdated.MaxCityNetworksToMonitor).toBe(2);
        expect(observedUpdated.Tags?.updated).toBe("true");

        yield* stack.destroy();
        yield* assertMonitorGone(created.monitorName);

        // Internet Monitor auto-creates per-monitor CloudWatch log groups
        // (/aws/internet-monitor/{name}/{byCity,byCountry,byMetro,
        // bySubdivision}) that survive DeleteMonitor. The provider delete
        // reaps them — prove none remain after destroy.
        const remainingLogGroups = yield* logs
          .describeLogGroups({
            logGroupNamePrefix: `/aws/internet-monitor/${created.monitorName}`,
          })
          .pipe(
            Effect.map((r) => (r.logGroups ?? []).map((g) => g.logGroupName)),
          );
        expect(remainingLogGroups).toEqual([]);
      }),
    { timeout: 300_000 },
  );
});
