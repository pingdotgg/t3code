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

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  networkconnectivity
    .getProjectsLocationsServiceConnectionPolicies({ name })
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
  "getProjectsLocationsServiceConnectionPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkconnectivity.getProjectsLocationsServiceConnectionPolicies({
          name: `projects/${project}/locations/us-central1/serviceConnectionPolicies/alchemy-missing`,
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
  "create, update, and delete a service connection policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("ScpVpc", {
            autoCreateSubnetworks: false,
          });
          const subnet = yield* GCP.Compute.Subnetwork("ScpSubnet", {
            network: network.networkName,
            ipCidrRange: "10.22.0.0/24",
            privateIpGoogleAccess: true,
          });
          const policy = yield* GCP.NetworkConnectivity.ServiceConnectionPolicy(
            "Redis",
            {
              serviceClass: "gcp-memorystore-redis",
              network: network.selfLink.as<string>(),
              pscConfig: {
                subnetworks: [subnet.selfLink.as<string>()],
              },
              description: "policy a",
              labels: { env: "test" },
            },
          );
          return { network, subnet, policy };
        }),
      );

      expect(created.policy.name).toContain("/serviceConnectionPolicies/");
      expect(created.policy.location).toEqual("us-central1");
      expect(created.policy.serviceClass).toEqual("gcp-memorystore-redis");
      expect(created.policy.description).toEqual("policy a");
      expect(created.policy.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networkconnectivity.getProjectsLocationsServiceConnectionPolicies(
          { name: created.policy.name },
        );
      expect(fetched.name).toEqual(created.policy.name);
      expect(fetched.serviceClass).toEqual("gcp-memorystore-redis");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("ScpVpc", {
            networkName: created.network.networkName,
            autoCreateSubnetworks: false,
          });
          const subnet = yield* GCP.Compute.Subnetwork("ScpSubnet", {
            subnetworkName: created.subnet.subnetworkName,
            network: network.networkName,
            ipCidrRange: "10.22.0.0/24",
            privateIpGoogleAccess: true,
          });
          const policy = yield* GCP.NetworkConnectivity.ServiceConnectionPolicy(
            "Redis",
            {
              serviceConnectionPolicyId:
                created.policy.serviceConnectionPolicyId,
              location: created.policy.location,
              serviceClass: "gcp-memorystore-redis",
              network: network.selfLink.as<string>(),
              pscConfig: {
                subnetworks: [subnet.selfLink.as<string>()],
                limit: "4",
              },
              description: "policy b",
              labels: { env: "prod", role: "psc" },
            },
          );
          return { network, subnet, policy };
        }),
      );

      expect(updated.policy.name).toEqual(created.policy.name);
      expect(updated.policy.description).toEqual("policy b");
      expect(updated.policy.labels).toMatchObject({
        env: "prod",
        role: "psc",
      });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.policy.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 600_000,
  },
);
