import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { withNetworkSlots } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  networksecurity
    .getProjectsLocationsMirroringEndpointGroupAssociations({ name })
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
  "getProjectsLocationsMirroringEndpointGroupAssociations on a missing association fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsMirroringEndpointGroupAssociations({
          name: `projects/${project}/locations/global/mirroringEndpointGroupAssociations/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a mirroring endpoint group association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const producer = yield* GCP.Compute.Network("Producer", {
            autoCreateSubnetworks: false,
            description: "mirroring producer vpc",
          });
          const consumer = yield* GCP.Compute.Network("Consumer", {
            autoCreateSubnetworks: false,
            description: "mirroring consumer vpc",
          });
          const collectors =
            yield* GCP.NetworkSecurity.MirroringDeploymentGroup("Collectors", {
              network: producer.selfLink.as<string>(),
              description: "collectors",
            });
          const endpoints = yield* GCP.NetworkSecurity.MirroringEndpointGroup(
            "Front",
            {
              mirroringDeploymentGroup: collectors.name,
            },
          );
          const association =
            yield* GCP.NetworkSecurity.MirroringEndpointGroupAssociation(
              "Link",
              {
                mirroringEndpointGroup: endpoints.name,
                network: consumer.selfLink.as<string>(),
                labels: { env: "test" },
              },
            );
          return { producer, consumer, collectors, endpoints, association };
        }),
      );

      expect(created.association.name).toContain(
        "/mirroringEndpointGroupAssociations/",
      );
      expect(created.association.location).toEqual("global");
      expect(created.association.labels).toMatchObject({ env: "test" });
      expect(created.association.mirroringEndpointGroup).toEqual(
        created.endpoints.name,
      );
      expect(created.association.networkName).toEqual(
        created.consumer.networkName,
      );

      const fetched =
        yield* networksecurity.getProjectsLocationsMirroringEndpointGroupAssociations(
          {
            name: created.association.name,
          },
        );
      expect(fetched.name).toEqual(created.association.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const producer = yield* GCP.Compute.Network("Producer", {
            networkName: created.producer.networkName,
            autoCreateSubnetworks: false,
            description: "mirroring producer vpc",
          });
          const consumer = yield* GCP.Compute.Network("Consumer", {
            networkName: created.consumer.networkName,
            autoCreateSubnetworks: false,
            description: "mirroring consumer vpc",
          });
          const collectors =
            yield* GCP.NetworkSecurity.MirroringDeploymentGroup("Collectors", {
              mirroringDeploymentGroupId:
                created.collectors.mirroringDeploymentGroupId,
              network: producer.selfLink.as<string>(),
              description: "collectors",
            });
          const endpoints = yield* GCP.NetworkSecurity.MirroringEndpointGroup(
            "Front",
            {
              mirroringEndpointGroupId:
                created.endpoints.mirroringEndpointGroupId,
              mirroringDeploymentGroup: collectors.name,
            },
          );
          const association =
            yield* GCP.NetworkSecurity.MirroringEndpointGroupAssociation(
              "Link",
              {
                mirroringEndpointGroupAssociationId:
                  created.association.mirroringEndpointGroupAssociationId,
                mirroringEndpointGroup: endpoints.name,
                network: consumer.selfLink.as<string>(),
                labels: { env: "prod", role: "nsi" },
              },
            );
          return { producer, consumer, collectors, endpoints, association };
        }),
      );

      expect(updated.association.name).toEqual(created.association.name);
      expect(updated.association.labels).toMatchObject({
        env: "prod",
        role: "nsi",
      });

      const refetched =
        yield* networksecurity.getProjectsLocationsMirroringEndpointGroupAssociations(
          {
            name: created.association.name,
          },
        );
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("nsi");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.association.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlots(2)),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 600_000,
  },
);
