import * as AWS from "@/AWS";
import { AppMonitor } from "@/AWS/RUM";
import * as Test from "@/Test/Alchemy";
import * as rum from "@distilled.cloud/aws/rum";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findMonitor = (name: string) =>
  rum.getAppMonitor({ Name: name }).pipe(
    Effect.map((r) => r.AppMonitor),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class AppMonitorStillExists extends Data.TaggedError("AppMonitorStillExists")<{
  readonly name: string;
}> {}

const assertMonitorDeleted = (name: string) =>
  findMonitor(name).pipe(
    Effect.flatMap((monitor) =>
      monitor === undefined
        ? Effect.void
        : Effect.fail(new AppMonitorStillExists({ name })),
    ),
    Effect.retry({
      while: (e) => e._tag === "AppMonitorStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getAppMonitor on a nonexistent monitor fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        rum.getAppMonitor({ Name: "alchemy-nonexistent-rum-monitor-probe" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "create, update in place, delete app monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const monitor = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AppMonitor("TestMonitor", {
            domain: "example.com",
            appMonitorConfiguration: {
              sessionSampleRate: 0.5,
              telemetries: ["errors", "http"],
              allowCookies: true,
            },
            tags: { fixture: "rum-app-monitor" },
          });
        }),
      );

      expect(monitor.appMonitorName).toBeDefined();
      expect(monitor.appMonitorId).toBeDefined();
      expect(monitor.appMonitorArn).toContain(":appmonitor/");

      // out-of-band verification via distilled
      const created = yield* findMonitor(monitor.appMonitorName);
      expect(created?.Id).toBe(monitor.appMonitorId);
      expect(created?.Domain).toBe("example.com");
      expect(created?.AppMonitorConfiguration?.SessionSampleRate).toBe(0.5);
      expect(
        [...(created?.AppMonitorConfiguration?.Telemetries ?? [])].sort(),
      ).toEqual(["errors", "http"]);
      expect(created?.AppMonitorConfiguration?.AllowCookies).toBe(true);
      expect(created?.DataStorage?.CwLog?.CwLogEnabled ?? false).toBe(false);
      expect(created?.CustomEvents?.Status ?? "DISABLED").toBe("DISABLED");
      expect(created?.Tags?.fixture).toBe("rum-app-monitor");
      expect(created?.Tags?.["alchemy::id"]).toBe("TestMonitor");

      // update in place: domain, sample rate, cw logs, custom events, tags
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AppMonitor("TestMonitor", {
            domain: "updated.example.com",
            appMonitorConfiguration: {
              sessionSampleRate: 1,
              telemetries: ["errors"],
              allowCookies: false,
            },
            cwLogEnabled: true,
            customEvents: "ENABLED",
            tags: { fixture: "rum-app-monitor", phase: "two" },
          });
        }),
      );
      // same physical monitor — update, not replace
      expect(updated.appMonitorName).toBe(monitor.appMonitorName);
      expect(updated.appMonitorId).toBe(monitor.appMonitorId);

      const afterUpdate = yield* findMonitor(monitor.appMonitorName);
      expect(afterUpdate?.Domain).toBe("updated.example.com");
      expect(afterUpdate?.AppMonitorConfiguration?.SessionSampleRate).toBe(1);
      expect(afterUpdate?.AppMonitorConfiguration?.Telemetries).toEqual([
        "errors",
      ]);
      expect(afterUpdate?.AppMonitorConfiguration?.AllowCookies).toBe(false);
      expect(afterUpdate?.DataStorage?.CwLog?.CwLogEnabled).toBe(true);
      expect(afterUpdate?.CustomEvents?.Status).toBe("ENABLED");
      expect(afterUpdate?.Tags?.phase).toBe("two");

      // removing a user tag converges (internal tags survive)
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AppMonitor("TestMonitor", {
            domain: "updated.example.com",
            appMonitorConfiguration: {
              sessionSampleRate: 1,
              telemetries: ["errors"],
              allowCookies: false,
            },
            cwLogEnabled: true,
            customEvents: "ENABLED",
            tags: { fixture: "rum-app-monitor" },
          });
        }),
      );
      const afterTagRemoval = yield* findMonitor(monitor.appMonitorName);
      expect(afterTagRemoval?.Tags?.phase).toBeUndefined();
      expect(afterTagRemoval?.Tags?.fixture).toBe("rum-app-monitor");
      expect(afterTagRemoval?.Tags?.["alchemy::id"]).toBe("TestMonitor");

      yield* stack.destroy();
      yield* assertMonitorDeleted(monitor.appMonitorName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom name, domainList, and replacement on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AppMonitor("NamedMonitor", {
            appMonitorName: "alchemy-test-rum-monitor-a",
            domainList: ["example.com", "app.example.com"],
          });
        }),
      );
      expect(first.appMonitorName).toBe("alchemy-test-rum-monitor-a");

      const observed = yield* findMonitor(first.appMonitorName);
      expect([...(observed?.DomainList ?? [])].sort()).toEqual([
        "app.example.com",
        "example.com",
      ]);

      // rename replaces the monitor
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AppMonitor("NamedMonitor", {
            appMonitorName: "alchemy-test-rum-monitor-b",
            domainList: ["example.com", "app.example.com"],
          });
        }),
      );
      expect(second.appMonitorName).toBe("alchemy-test-rum-monitor-b");
      expect(second.appMonitorId).not.toBe(first.appMonitorId);

      // the old monitor is cleaned up by the replacement
      yield* assertMonitorDeleted("alchemy-test-rum-monitor-a");

      yield* stack.destroy();
      yield* assertMonitorDeleted("alchemy-test-rum-monitor-b");
    }),
  { timeout: 120_000 },
);

test.provider(
  "rejects a monitor with both domain and domainList",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            return yield* AppMonitor("BadMonitor", {
              domain: "example.com",
              domainList: ["other.example.com"],
            });
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      yield* stack.destroy();
    }),
  { timeout: 60_000 },
);
