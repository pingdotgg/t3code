import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const listLive = (environmentId: string) =>
  railway.privateNetworks({ environmentId }).pipe(
    Effect.map((items) => items.filter((network) => network.deletedAt == null)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.succeed([])),
  );

const waitUntilEndpointGone = (input: {
  environmentId: string;
  privateNetworkId: string;
  serviceId: string;
}) =>
  railway.privateNetworkEndpoint(input).pipe(
    Effect.map((endpoint) =>
      endpoint == null ||
      endpoint.deletedAt != null ||
      endpoint.syncStatus === "DELETED" ||
      endpoint.syncStatus === "DELETING"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skip(
  "create-or-get a private network is idempotent (dnsName was delightful-purpose, expected to contain api)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const network = yield* Railway.PrivateNetwork("Mesh", {
            environment,
          });
          return { project, environment, network };
        }),
      );

      expect(created.network.publicId).toEqual(expect.any(String));
      expect(created.network.publicId.length).toBeGreaterThan(0);
      expect(typeof created.network.networkId).toEqual("string");
      expect(created.network.networkId.length).toBeGreaterThan(0);
      expect(created.network.networkId).toMatch(/^\d+$/);
      expect(created.network.projectId).toEqual(created.project.projectId);
      expect(created.network.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.network.name).toEqual(expect.any(String));
      expect(created.network.name.length).toBeGreaterThan(0);
      expect(created.network.name.length).toBeLessThanOrEqual(32);
      expect(created.network.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.network.dnsName).toEqual(expect.any(String));
      expect(created.network.dnsName.length).toBeGreaterThan(0);
      expect(created.network.tags).toEqual(expect.any(Array));

      const listed = yield* listLive(created.network.environmentId);
      const fetched = listed.find(
        (network) => network.publicId === created.network.publicId,
      );
      expect(fetched).toBeDefined();
      expect(fetched?.name).toEqual(created.network.name);
      expect(fetched?.dnsName).toEqual(created.network.dnsName);
      expect(fetched?.projectId).toEqual(created.network.projectId);
      expect(fetched?.environmentId).toEqual(created.network.environmentId);

      const again = yield* railway.privateNetworkCreateOrGet({
        input: {
          environmentId: created.network.environmentId,
          projectId: created.network.projectId,
          name: created.network.name,
          tags: ["alchemy"],
        },
      });
      expect(again.publicId).toEqual(created.network.publicId);
      expect(again.name).toEqual(created.network.name);
      expect(again.dnsName).toEqual(created.network.dnsName);
      expect(String(again.networkId)).toEqual(created.network.networkId);

      const provider = yield* Provider.findProvider(Railway.PrivateNetwork);
      const owned = yield* provider.list();
      const found = owned.find(
        (network) => network.publicId === created.network.publicId,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.network.name);
      expect(found?.dnsName).toEqual(created.network.dnsName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const network = yield* Railway.PrivateNetwork("Mesh", {
            environment,
          });
          return { project, environment, network };
        }),
      );

      expect(updated.network.publicId).toEqual(created.network.publicId);
      expect(updated.network.name).toEqual(created.network.name);
      expect(updated.network.dnsName).toEqual(created.network.dnsName);
      expect(updated.project.projectId).toEqual(created.project.projectId);

      const service = yield* railway.serviceCreate({
        input: {
          projectId: created.project.projectId,
          environmentId: created.environment.environmentId,
          source: { image: "hashicorp/http-echo" },
        },
      });

      const withEndpoint = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const network = yield* Railway.PrivateNetwork("Mesh", {
            environment,
          });
          const endpoint = yield* Railway.PrivateNetworkEndpoint("ApiDns", {
            network,
            service: { serviceId: service.id, name: service.name },
            name: "api",
          });
          return { project, environment, network, endpoint };
        }),
      );

      expect(withEndpoint.network.publicId).toEqual(created.network.publicId);
      expect(withEndpoint.endpoint.publicId).toEqual(expect.any(String));
      expect(withEndpoint.endpoint.publicId.length).toBeGreaterThan(0);
      expect(withEndpoint.endpoint.serviceId).toEqual(service.id);
      expect(withEndpoint.endpoint.privateNetworkId).toEqual(
        created.network.publicId,
      );
      expect(withEndpoint.endpoint.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(withEndpoint.endpoint.dnsName).toEqual(expect.any(String));
      expect(withEndpoint.endpoint.dnsName.length).toBeGreaterThan(0);
      expect(withEndpoint.endpoint.dnsName.toLowerCase()).toContain("api");

      const liveEndpoint = yield* railway.privateNetworkEndpoint({
        environmentId: created.environment.environmentId,
        privateNetworkId: created.network.publicId,
        serviceId: service.id,
      });
      expect(liveEndpoint).not.toBeNull();
      expect(liveEndpoint?.publicId).toEqual(withEndpoint.endpoint.publicId);
      expect(liveEndpoint?.dnsName).toEqual(withEndpoint.endpoint.dnsName);

      const endpointAgain = yield* railway.privateNetworkEndpointCreateOrGet({
        input: {
          environmentId: created.environment.environmentId,
          privateNetworkId: created.network.publicId,
          serviceId: service.id,
          serviceName: "api",
          tags: ["alchemy"],
        },
      });
      expect(endpointAgain.publicId).toEqual(withEndpoint.endpoint.publicId);

      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const network = yield* Railway.PrivateNetwork("Mesh", {
            environment,
          });
          const endpoint = yield* Railway.PrivateNetworkEndpoint("ApiDns", {
            network,
            service: { serviceId: service.id, name: service.name },
            name: "gateway",
          });
          return { project, environment, network, endpoint };
        }),
      );

      expect(renamed.endpoint.publicId).toEqual(withEndpoint.endpoint.publicId);
      expect(renamed.endpoint.dnsName.toLowerCase()).toContain("gateway");

      yield* stack.destroy();

      const endpointGone = yield* waitUntilEndpointGone({
        environmentId: created.environment.environmentId,
        privateNetworkId: created.network.publicId,
        serviceId: service.id,
      });
      expect(endpointGone).toEqual("gone");
      // Named networks have no delete API — tearing them down would
      // also drop the environment's default mesh. They leave with the
      // parent Project / Environment.
      const networks = yield* listLive(created.environment.environmentId);
      expect(networks.length).toBeGreaterThan(0);
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
