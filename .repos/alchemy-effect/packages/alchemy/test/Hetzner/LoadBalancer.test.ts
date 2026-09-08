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
  Services.loadBalancers.getLoadBalancer({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const tcpService = (listenPort: number, destinationPort: number) => ({
  protocol: "tcp" as const,
  listenPort,
  destinationPort,
  healthCheck: {
    protocol: "tcp" as const,
    port: destinationPort,
    interval: 15,
    timeout: 10,
    retries: 3,
  },
});

test.provider.skipIf(!hasHetznerCreds)(
  "create, update, and delete a load balancer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* Hetzner.Server("Target", {
            serverType: "cx23",
            image: "ubuntu-24.04",
            location: "nbg1",
            startAfterCreate: false,
          });
          const network = yield* Hetzner.Network("LbNet", {
            ipRange: "10.30.0.0/16",
            subnets: [
              {
                type: "cloud",
                ipRange: "10.30.1.0/24",
                networkZone: "eu-central",
              },
            ],
          });
          const lb = yield* Hetzner.LoadBalancer("Edge", {
            location: "nbg1",
            loadBalancerType: "lb11",
            algorithm: "round_robin",
            services: [tcpService(80, 80)],
            targets: [{ type: "server", server }],
            networks: [network],
            labels: { env: "test" },
          });
          return {
            lb,
            serverId: server.serverId,
            networkId: network.networkId,
          };
        }),
      );

      expect(created.lb.id).toEqual(expect.any(Number));
      expect(created.lb.name).toEqual(expect.any(String));
      expect(created.lb.loadBalancerType).toEqual("lb11");
      expect(created.lb.location).toEqual("nbg1");
      expect(created.lb.networkZone).toEqual("eu-central");
      expect(created.lb.algorithm).toEqual("round_robin");
      expect(created.lb.publicInterface).toEqual(true);
      expect(created.lb.deleteProtection).toEqual(false);
      expect(created.lb.ipv4).toEqual(expect.any(String));
      expect(created.lb.labels).toMatchObject({ env: "test" });
      expect(created.lb.services).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            protocol: "tcp",
            listenPort: 80,
            destinationPort: 80,
          }),
        ]),
      );
      expect(created.lb.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "server",
            serverId: created.serverId,
          }),
        ]),
      );
      expect(created.lb.privateNetworks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ networkId: created.networkId }),
        ]),
      );

      const fetched = yield* Services.loadBalancers.getLoadBalancer({
        id: created.lb.id,
      });
      expect(fetched.load_balancer.id).toEqual(created.lb.id);
      expect(fetched.load_balancer.algorithm.type).toEqual("round_robin");
      expect(fetched.load_balancer.load_balancer_type.name).toEqual("lb11");
      expect(fetched.load_balancer.location.name).toEqual("nbg1");
      expect(fetched.load_balancer.labels.env).toEqual("test");
      expect(fetched.load_balancer.public_net.enabled).toEqual(true);
      expect(fetched.load_balancer.private_net).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ network: created.networkId }),
        ]),
      );
      expect(fetched.load_balancer.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "server",
            server: expect.objectContaining({ id: created.serverId }),
          }),
        ]),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* Hetzner.Server("Target", {
            serverType: "cx23",
            image: "ubuntu-24.04",
            location: "nbg1",
            startAfterCreate: false,
          });
          const network = yield* Hetzner.Network("LbNet", {
            ipRange: "10.30.0.0/16",
            subnets: [
              {
                type: "cloud",
                ipRange: "10.30.1.0/24",
                networkZone: "eu-central",
              },
            ],
          });
          return yield* Hetzner.LoadBalancer("Edge", {
            location: "nbg1",
            loadBalancerType: "lb11",
            algorithm: "least_connections",
            services: [tcpService(80, 8080)],
            targets: [{ type: "server", server }],
            networks: [network],
            deleteProtection: true,
            labels: { env: "prod", role: "lb" },
          });
        }),
      );

      expect(updated.id).toEqual(created.lb.id);
      expect(updated.algorithm).toEqual("least_connections");
      expect(updated.deleteProtection).toEqual(true);
      expect(updated.labels).toMatchObject({ env: "prod", role: "lb" });
      expect(updated.services).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            protocol: "tcp",
            listenPort: 80,
            destinationPort: 8080,
          }),
        ]),
      );
      expect(updated.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "server",
            serverId: created.serverId,
          }),
        ]),
      );

      const refetched = yield* Services.loadBalancers.getLoadBalancer({
        id: updated.id,
      });
      expect(refetched.load_balancer.algorithm.type).toEqual(
        "least_connections",
      );
      expect(refetched.load_balancer.protection.delete).toEqual(true);
      expect(refetched.load_balancer.labels.env).toEqual("prod");
      expect(refetched.load_balancer.labels.role).toEqual("lb");
      expect(refetched.load_balancer.services).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            protocol: "tcp",
            listen_port: 80,
            destination_port: 8080,
          }),
        ]),
      );

      const provider = yield* Provider.findProvider(Hetzner.LoadBalancer);
      const all = yield* provider.list();
      const listed = all.find((item) => item.id === updated.id);
      expect(listed).toBeDefined();
      expect(listed?.algorithm).toEqual("least_connections");
      expect(listed?.loadBalancerType).toEqual("lb11");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.lb.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "replace when location changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.LoadBalancer("ReplaceEdge", {
            location: "nbg1",
            loadBalancerType: "lb11",
            services: [tcpService(80, 80)],
          });
        }),
      );

      expect(created.location).toEqual("nbg1");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.LoadBalancer("ReplaceEdge", {
            location: "fsn1",
            loadBalancerType: "lb11",
            services: [tcpService(80, 80)],
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.location).toEqual("fsn1");

      const fetched = yield* Services.loadBalancers.getLoadBalancer({
        id: replaced.id,
      });
      expect(fetched.load_balancer.location.name).toEqual("fsn1");

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
