import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/gcp/apim_v1alpha";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { DEFAULT_NETWORK } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The API Management API is not enabled in the testing project: every call
// answers 403 SERVICE_DISABLED (typed `ServiceDisabled`). Set GCP_TEST_APIM=1
// on a project with the API enabled to run the lifecycle.
const apimEnabled = !!process.env.GCP_TEST_APIM;
const runLifecycle = !process.env.FAST && apimEnabled;
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apim.getProjectsLocationsObservationSources({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsObservationSources on a missing source fails with ServiceDisabled while the API is disabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apim.getProjectsLocationsObservationSources({
          name: `${parent}/observationSources/alchemy-missing-src`,
        }),
      );
      expect(error._tag).toEqual(apimEnabled ? "NotFound" : "ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apim", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an API Observation source",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet = yield* GCP.Compute.Subnetwork("ApimSrcSubnet", {
            network: DEFAULT_NETWORK,
            region: location,
            ipCidrRange: "172.20.12.0/24",
            privateIpGoogleAccess: true,
          });
          const source = yield* GCP.Apim.ObservationSource("Edge", {
            location,
            gclbObservationSource: {
              pscNetworkConfigs: [
                {
                  network: DEFAULT_NETWORK,
                  subnetwork: subnet.subnetworkName,
                },
              ],
            },
          });
          return { subnet, source };
        }),
      );

      expect(created.source.name).toContain("/observationSources/");
      expect(created.source.observationSourceId).toEqual(expect.any(String));
      expect(created.source.location).toEqual(location);
      expect(
        created.source.gclbObservationSource?.pscNetworkConfigs.length,
      ).toBeGreaterThan(0);

      const fetched = yield* apim.getProjectsLocationsObservationSources({
        name: created.source.name,
      });
      expect(fetched.name).toEqual(created.source.name);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.source.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apim", "live"], timeout: 120_000 },
);
