import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Consumer-created DNS records need `networkconnectivity.serviceClasses.use` on
// the Google producer's service class, which the testing project lacks
// (Forbidden "Permission 'networkconnectivity.serviceClasses.use' denied on
// 'projects/708115875642/.../serviceClasses/gcp-memorystore-redis'"). Set
// GCP_TEST_NCC_AUTOMATED_DNS_RECORD=1 on an entitled project.
const runLifecycle = !!process.env.GCP_TEST_NCC_AUTOMATED_DNS_RECORD;

const waitUntilGone = (name: string) =>
  networkconnectivity.getProjectsLocationsAutomatedDnsRecords({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAutomatedDnsRecords on a missing record fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkconnectivity.getProjectsLocationsAutomatedDnsRecords({
          name: `projects/${project}/locations/us-central1/automatedDnsRecords/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an automated dns record",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("AdrVpc", {
            autoCreateSubnetworks: false,
          });
          const subnet = yield* GCP.Compute.Subnetwork("AdrSubnet", {
            network: network.networkName,
            ipCidrRange: "10.23.0.0/24",
            privateIpGoogleAccess: true,
          });
          const policy = yield* GCP.NetworkConnectivity.ServiceConnectionPolicy(
            "RedisPolicy",
            {
              serviceClass: "gcp-memorystore-redis",
              network: network.selfLink.as<string>(),
              pscConfig: {
                subnetworks: [subnet.selfLink.as<string>()],
              },
            },
          );
          const record = yield* GCP.NetworkConnectivity.AutomatedDnsRecord(
            "Redis",
            {
              serviceClass: policy.serviceClass.as<string>(),
              creationMode: "CONSUMER_API",
              recordType: "A",
              hostname: "redis",
              dnsSuffix: "psc.internal.",
              originalConfig: { ttl: "30s", rrdatas: ["10.0.0.1"] },
              consumerNetwork: network.selfLink.as<string>(),
              description: "adr a",
              labels: { env: "test" },
            },
          );
          return { network, subnet, policy, record };
        }),
      );

      expect(created.record.name).toContain("/automatedDnsRecords/");
      expect(created.record.location).toEqual("us-central1");
      expect(created.record.recordType).toEqual("A");
      expect(created.record.hostname).toEqual("redis");
      expect(created.record.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networkconnectivity.getProjectsLocationsAutomatedDnsRecords({
          name: created.record.name,
        });
      expect(fetched.name).toEqual(created.record.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.record.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 600_000,
  },
);
