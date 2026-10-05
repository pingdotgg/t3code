import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkmanagement from "@distilled.cloud/gcp/networkmanagement_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
// Monitoring providers (AppNeta) need the provider's Terms of Service accepted
// for the project; otherwise the create operation fails with "Terms of Service
// not accepted for project: ...". Set GCP_TEST_NETWORKMANAGEMENT_APPNETA=1 once
// accepted.
const runLifecycle = !!process.env.GCP_TEST_NETWORKMANAGEMENT_APPNETA;

const waitUntilGone = (name: string) =>
  networkmanagement
    .getProjectsLocationsNetworkMonitoringProviders({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsNetworkMonitoringProviders on a missing provider fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkmanagement.getProjectsLocationsNetworkMonitoringProviders({
          name: `projects/${project}/locations/global/networkMonitoringProviders/alchemy-missing`,
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
  "create and delete a network monitoring provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkManagement.NetworkMonitoringProvider(
            "AppNeta",
            { providerType: "EXTERNAL" },
          );
        }),
      );

      expect(created.name).toContain("/networkMonitoringProviders/");
      expect(created.networkMonitoringProviderId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.providerType).toEqual("EXTERNAL");
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkmanagement.getProjectsLocationsNetworkMonitoringProviders(
          { name: created.name },
        );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.providerType).toEqual("EXTERNAL");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkmanagement", "live"],
    timeout: 180_000,
  },
);
