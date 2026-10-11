import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkmanagement from "@distilled.cloud/gcp/networkmanagement_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { defaultNetworkSelfLink } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  networkmanagement.getProjectsLocationsGlobalConnectivityTests({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsGlobalConnectivityTests on a missing test fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkmanagement.getProjectsLocationsGlobalConnectivityTests({
          name: `projects/${project}/locations/global/connectivityTests/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkmanagement", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a connectivity test",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const test = yield* GCP.NetworkManagement.ConnectivityTest(
            "DnsPath",
            {
              source: {
                ipAddress: "10.8.0.1",
                network: defaultNetworkSelfLink(project),
                networkType: "GCP_NETWORK",
                projectId: project,
              },
              destination: { ipAddress: "10.8.0.2", port: 443 },
              protocol: "TCP",
              description: "reach a",
              labels: { env: "test" },
            },
          );
          return { test };
        }),
      );

      expect(created.test.name).toContain("/connectivityTests/");
      expect(created.test.name).toContain("/locations/global/");
      expect(created.test.testId).toEqual(expect.any(String));
      expect(created.test.location).toEqual("global");
      expect(created.test.description).toEqual("reach a");
      expect(created.test.protocol).toEqual("TCP");
      expect(created.test.source?.ipAddress).toEqual("10.8.0.1");
      expect(created.test.destination?.ipAddress).toEqual("10.8.0.2");
      expect(created.test.destination?.port).toEqual(443);
      expect(created.test.labels).toMatchObject({ env: "test" });
      expect(created.test.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkmanagement.getProjectsLocationsGlobalConnectivityTests({
          name: created.test.name,
        });
      expect(fetched.name).toEqual(created.test.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("reach a");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const test = yield* GCP.NetworkManagement.ConnectivityTest(
            "DnsPath",
            {
              testId: created.test.testId,
              source: {
                ipAddress: "10.8.0.1",
                network: defaultNetworkSelfLink(project),
                networkType: "GCP_NETWORK",
                projectId: project,
              },
              destination: { ipAddress: "10.8.0.2", port: 80 },
              protocol: "TCP",
              description: "reach b",
              labels: { env: "prod", role: "reach" },
              bypassFirewallChecks: true,
            },
          );
          return { test };
        }),
      );

      expect(updated.test.name).toEqual(created.test.name);
      expect(updated.test.description).toEqual("reach b");
      expect(updated.test.destination?.port).toEqual(80);
      expect(updated.test.bypassFirewallChecks).toEqual(true);
      expect(updated.test.labels).toMatchObject({ env: "prod", role: "reach" });

      const refetched =
        yield* networkmanagement.getProjectsLocationsGlobalConnectivityTests({
          name: created.test.name,
        });
      expect(refetched.description).toEqual("reach b");
      expect(refetched.destination?.port).toEqual(80);
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("reach");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.test.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkmanagement", "live"],
    timeout: 600_000,
  },
);
