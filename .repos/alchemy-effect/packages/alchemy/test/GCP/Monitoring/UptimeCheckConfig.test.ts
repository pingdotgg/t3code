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
  monitoring.getProjectsUptimeCheckConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete an uptime check",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.UptimeCheckConfig("Homepage", {
            timeout: "10s",
            period: "600s",
            httpCheck: {
              path: "/",
              port: 443,
              useSsl: true,
              validateSsl: true,
            },
            monitoredResource: {
              type: "uptime_url",
              labels: { host: "example.com" },
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/uptimeCheckConfigs/");
      expect(created.uptimeCheckConfigId).toEqual(expect.any(String));
      expect(created.timeout).toEqual("10s");
      expect(created.period).toEqual("600s");
      expect(created.httpCheck?.useSsl).toEqual(true);
      expect(created.httpCheck?.path ?? "/").toEqual("/");
      expect(created.monitoredResource?.type).toEqual("uptime_url");
      expect(created.monitoredResource?.labels?.host).toEqual("example.com");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.disabled).toEqual(false);

      const fetched = yield* monitoring.getProjectsUptimeCheckConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.timeout).toEqual("10s");
      expect(fetched.period).toEqual("600s");
      expect(fetched.httpCheck?.useSsl).toEqual(true);
      expect(fetched.monitoredResource?.labels?.host).toEqual("example.com");
      expect(fetched.userLabels?.env).toEqual("test");
      expect(
        Object.keys(fetched.userLabels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.UptimeCheckConfig("Homepage", {
            displayName: created.displayName,
            timeout: "20s",
            period: "300s",
            httpCheck: {
              path: "/status",
              port: 443,
              useSsl: true,
              validateSsl: true,
            },
            monitoredResource: {
              type: "uptime_url",
              labels: { host: "example.com" },
            },
            labels: { env: "prod", role: "uptime" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.timeout).toEqual("20s");
      expect(updated.period).toEqual("300s");
      expect(updated.httpCheck?.path).toEqual("/status");
      expect(updated.labels).toMatchObject({ env: "prod", role: "uptime" });

      const fetchedUpdate = yield* monitoring.getProjectsUptimeCheckConfigs({
        name: updated.name,
      });
      expect(fetchedUpdate.timeout).toEqual("20s");
      expect(fetchedUpdate.period).toEqual("300s");
      expect(fetchedUpdate.httpCheck?.path).toEqual("/status");
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
