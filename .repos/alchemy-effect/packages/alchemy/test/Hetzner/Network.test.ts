import * as Hetzner from "@/Hetzner";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const waitUntilGone = (id: number) =>
  Services.networks.getNetwork({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "create, update, and delete a network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Network("Vpc", {
            ipRange: "10.0.0.0/16",
            subnets: [
              {
                type: "cloud",
                ipRange: "10.0.1.0/24",
                networkZone: "eu-central",
              },
            ],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.networkId).toEqual(expect.any(Number));
      expect(created.name).toEqual(expect.any(String));
      expect(created.ipRange).toEqual("10.0.0.0/16");
      expect(created.subnets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "cloud",
            ipRange: "10.0.1.0/24",
            networkZone: "eu-central",
          }),
        ]),
      );
      expect(created.routes).toEqual([]);
      expect(created.deleteProtection).toEqual(false);
      expect(created.exposeRoutesToVswitch).toEqual(false);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* Services.networks.getNetwork({
        id: created.networkId,
      });
      expect(fetched.network?.id).toEqual(created.networkId);
      expect(fetched.network?.ip_range).toEqual("10.0.0.0/16");
      expect(fetched.network?.labels.env).toEqual("test");
      expect(fetched.network?.subnets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "cloud",
            ip_range: "10.0.1.0/24",
            network_zone: "eu-central",
          }),
        ]),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Network("Vpc", {
            ipRange: "10.0.0.0/16",
            subnets: [
              {
                type: "cloud",
                ipRange: "10.0.1.0/24",
                networkZone: "eu-central",
              },
              {
                type: "cloud",
                ipRange: "10.0.2.0/24",
                networkZone: "eu-central",
              },
            ],
            routes: [{ destination: "10.10.0.0/24", gateway: "10.0.1.2" }],
            exposeRoutesToVswitch: true,
            deleteProtection: true,
            labels: { env: "prod", role: "vpc" },
          });
        }),
      );

      expect(updated.networkId).toEqual(created.networkId);
      expect(updated.ipRange).toEqual("10.0.0.0/16");
      expect(updated.subnets).toHaveLength(2);
      expect(updated.routes).toEqual([
        { destination: "10.10.0.0/24", gateway: "10.0.1.2" },
      ]);
      expect(updated.deleteProtection).toEqual(true);
      expect(updated.exposeRoutesToVswitch).toEqual(true);
      expect(updated.labels).toMatchObject({ env: "prod", role: "vpc" });

      const refetched = yield* Services.networks.getNetwork({
        id: updated.networkId,
      });
      expect(refetched.network?.protection.delete).toEqual(true);
      expect(refetched.network?.expose_routes_to_vswitch).toEqual(true);
      expect(refetched.network?.labels.env).toEqual("prod");
      expect(refetched.network?.labels.role).toEqual("vpc");
      expect(refetched.network?.subnets).toHaveLength(2);
      expect(refetched.network?.routes).toEqual([
        { destination: "10.10.0.0/24", gateway: "10.0.1.2" },
      ]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.networkId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "replace when ip range is not a supernet",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Network("ReplaceVpc", {
            ipRange: "10.0.0.0/16",
            subnets: [
              {
                type: "cloud",
                ipRange: "10.0.1.0/24",
                networkZone: "eu-central",
              },
            ],
          });
        }),
      );

      expect(created.ipRange).toEqual("10.0.0.0/16");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Network("ReplaceVpc", {
            ipRange: "172.16.0.0/16",
            subnets: [
              {
                type: "cloud",
                ipRange: "172.16.1.0/24",
                networkZone: "eu-central",
              },
            ],
          });
        }),
      );

      expect(replaced.networkId).not.toEqual(created.networkId);
      expect(replaced.ipRange).toEqual("172.16.0.0/16");

      const fetched = yield* Services.networks.getNetwork({
        id: replaced.networkId,
      });
      expect(fetched.network?.ip_range).toEqual("172.16.0.0/16");

      const oldGone = yield* waitUntilGone(created.networkId);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.networkId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "list enumerates the deployed network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Network("ListVpc", {
            ipRange: "10.20.0.0/16",
            subnets: [
              {
                type: "cloud",
                ipRange: "10.20.1.0/24",
                networkZone: "eu-central",
              },
            ],
          });
        }),
      );

      const provider = yield* Provider.findProvider(Hetzner.Network);
      const all = yield* provider.list();
      const found = all.find(
        (network) => network.networkId === deployed.networkId,
      );
      expect(found).toBeDefined();
      expect(found?.ipRange).toEqual("10.20.0.0/16");
      expect(found?.name).toEqual(deployed.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.networkId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
