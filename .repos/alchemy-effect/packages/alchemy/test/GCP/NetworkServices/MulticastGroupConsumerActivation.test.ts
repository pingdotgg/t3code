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
    .getProjectsLocationsMulticastGroupConsumerActivations({ name })
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
  "getProjectsLocationsMulticastGroupConsumerActivations on a missing activation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsMulticastGroupConsumerActivations({
          name: `projects/${project}/locations/us-central1-a/multicastGroupConsumerActivations/alchemy-missing`,
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
  "create, update, and delete a multicast group consumer activation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
            description: "multicast group vpc",
          });
          const association =
            yield* GCP.NetworkServices.MulticastConsumerAssociation(
              "Consumers",
              {
                location: "us-central1-a",
                network: vpc.selfLink.as<string>(),
                description: "mcast assoc",
                labels: { env: "test" },
              },
            );
          const activation =
            yield* GCP.NetworkServices.MulticastGroupConsumerActivation(
              "Join",
              {
                location: "us-central1-a",
                multicastConsumerAssociation: association.name,
                multicastGroupRangeActivation:
                  process.env.GCP_TEST_MULTICAST_RANGE_ACTIVATION ?? "",
                description: "mcast gca a",
                labels: { env: "test" },
                logConfig: { enabled: true },
              },
            );
          return { vpc, association, activation };
        }),
      );

      expect(created.activation.name).toContain(
        "/multicastGroupConsumerActivations/",
      );
      expect(created.activation.multicastGroupConsumerActivationId).toEqual(
        expect.any(String),
      );
      expect(created.activation.location).toEqual("us-central1-a");
      expect(created.activation.description).toEqual("mcast gca a");
      expect(created.activation.labels).toMatchObject({ env: "test" });
      expect(created.activation.logConfig?.enabled).toEqual(true);

      const fetched =
        yield* networkservices.getProjectsLocationsMulticastGroupConsumerActivations(
          {
            name: created.activation.name,
          },
        );
      expect(fetched.name).toEqual(created.activation.name);
      expect(fetched.description).toEqual("mcast gca a");
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
            description: "multicast group vpc",
          });
          const association =
            yield* GCP.NetworkServices.MulticastConsumerAssociation(
              "Consumers",
              {
                multicastConsumerAssociationId:
                  created.association.multicastConsumerAssociationId,
                location: "us-central1-a",
                network: vpc.selfLink.as<string>(),
                description: "mcast assoc",
                labels: { env: "test" },
              },
            );
          const activation =
            yield* GCP.NetworkServices.MulticastGroupConsumerActivation(
              "Join",
              {
                multicastGroupConsumerActivationId:
                  created.activation.multicastGroupConsumerActivationId,
                location: "us-central1-a",
                multicastConsumerAssociation: association.name,
                multicastGroupRangeActivation:
                  created.activation.multicastGroupRangeActivation ??
                  process.env.GCP_TEST_MULTICAST_RANGE_ACTIVATION ??
                  "",
                description: "mcast gca b",
                labels: { env: "prod", role: "mcast" },
                logConfig: { enabled: false },
              },
            );
          return { vpc, association, activation };
        }),
      );

      expect(updated.activation.name).toEqual(created.activation.name);
      expect(updated.activation.description).toEqual("mcast gca b");
      expect(updated.activation.labels).toMatchObject({
        env: "prod",
        role: "mcast",
      });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.activation.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);
