import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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

// Multicast needs a multicast domain activation in the project; without one
// create fails with BadRequest "The request was invalid: missing
// multicast_domain_activation". Set GCP_TEST_MULTICAST=1 on a project with
// multicast activated.
const runLifecycle = !process.env.FAST && !!process.env.GCP_TEST_MULTICAST;

const waitUntilGone = (name: string) =>
  networkservices
    .getProjectsLocationsMulticastConsumerAssociations({ name })
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
  "getProjectsLocationsMulticastConsumerAssociations on a missing association fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsMulticastConsumerAssociations({
          name: `projects/${project}/locations/us-central1-a/multicastConsumerAssociations/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a multicast consumer association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
            description: "multicast consumer vpc",
          });
          const association =
            yield* GCP.NetworkServices.MulticastConsumerAssociation(
              "Consumers",
              {
                location: "us-central1-a",
                network: vpc.selfLink.as<string>(),
                description: "mcast assoc a",
                labels: { env: "test" },
              },
            );
          return { vpc, association };
        }),
      );

      expect(created.association.name).toContain(
        "/multicastConsumerAssociations/",
      );
      expect(created.association.multicastConsumerAssociationId).toEqual(
        expect.any(String),
      );
      expect(created.association.location).toEqual("us-central1-a");
      expect(created.association.description).toEqual("mcast assoc a");
      expect(created.association.labels).toMatchObject({ env: "test" });
      expect(created.association.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkservices.getProjectsLocationsMulticastConsumerAssociations(
          {
            name: created.association.name,
          },
        );
      expect(fetched.name).toEqual(created.association.name);
      expect(fetched.description).toEqual("mcast assoc a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            networkName: created.vpc.networkName,
            autoCreateSubnetworks: false,
            description: "multicast consumer vpc",
          });
          const association =
            yield* GCP.NetworkServices.MulticastConsumerAssociation(
              "Consumers",
              {
                multicastConsumerAssociationId:
                  created.association.multicastConsumerAssociationId,
                location: "us-central1-a",
                network: vpc.selfLink.as<string>(),
                description: "mcast assoc b",
                labels: { env: "prod", role: "mcast" },
              },
            );
          return { vpc, association };
        }),
      );

      expect(updated.association.name).toEqual(created.association.name);
      expect(updated.association.description).toEqual("mcast assoc b");
      expect(updated.association.labels).toMatchObject({
        env: "prod",
        role: "mcast",
      });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.association.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 900_000,
  },
);
