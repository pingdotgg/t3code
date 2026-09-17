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

const waitUntilFloatingIpGone = (id: number) =>
  Services.floatingIps.getFloatingIp({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilServerGone = (id: number) =>
  Services.servers.getServer({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "create update replace and delete assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* Hetzner.Server("Web", {
            serverType: "cx23",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
          const ip = yield* Hetzner.FloatingIp("PublicIp", {
            type: "ipv4",
            homeLocation: "nbg1",
          });
          const assignment = yield* Hetzner.FloatingIpAssignment("Assign", {
            floatingIp: ip,
            server,
          });
          return { server, ip, assignment };
        }),
      );

      expect(created.assignment.floatingIpId).toEqual(created.ip.id);
      expect(created.assignment.serverId).toEqual(created.server.serverId);

      const fetched = yield* Services.floatingIps.getFloatingIp({
        id: created.ip.id,
      });
      expect(fetched.floating_ip.server).toEqual(created.server.serverId);

      const provider = yield* Provider.findProvider(
        Hetzner.FloatingIpAssignment,
      );
      const listed = yield* provider.list();
      const found = listed.find((row) => row.floatingIpId === created.ip.id);
      expect(found).toBeDefined();
      expect(found?.serverId).toEqual(created.server.serverId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* Hetzner.Server("Web", {
            serverType: "cx23",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
          const ip = yield* Hetzner.FloatingIp("PublicIp", {
            type: "ipv4",
            homeLocation: "nbg1",
          });
          const assignment = yield* Hetzner.FloatingIpAssignment("Assign", {
            floatingIp: ip,
            server,
          });
          return { server, ip, assignment };
        }),
      );

      expect(updated.assignment.floatingIpId).toEqual(created.ip.id);
      expect(updated.assignment.serverId).toEqual(created.server.serverId);
      expect(updated.server.id).toEqual(created.server.id);
      expect(updated.ip.id).toEqual(created.ip.id);

      const stillAssigned = yield* Services.floatingIps.getFloatingIp({
        id: created.ip.id,
      });
      expect(stillAssigned.floating_ip.server).toEqual(created.server.serverId);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* Hetzner.Server("Web", {
            serverType: "cx23",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
          const ip = yield* Hetzner.FloatingIp("PublicIp", {
            type: "ipv4",
            homeLocation: "nbg1",
          });
          const nextIp = yield* Hetzner.FloatingIp("PublicIp2", {
            type: "ipv4",
            homeLocation: "nbg1",
          });
          const assignment = yield* Hetzner.FloatingIpAssignment("Assign", {
            floatingIp: nextIp,
            server,
          });
          return { server, ip, nextIp, assignment };
        }),
      );

      expect(replaced.assignment.floatingIpId).toEqual(replaced.nextIp.id);
      expect(replaced.assignment.serverId).toEqual(created.server.serverId);
      expect(replaced.nextIp.id).not.toEqual(created.ip.id);

      const oldIp = yield* Services.floatingIps.getFloatingIp({
        id: created.ip.id,
      });
      expect(oldIp.floating_ip.server).toBeNull();

      const newIp = yield* Services.floatingIps.getFloatingIp({
        id: replaced.nextIp.id,
      });
      expect(newIp.floating_ip.server).toEqual(created.server.serverId);

      yield* stack.destroy();

      const ipGone = yield* waitUntilFloatingIpGone(created.ip.id);
      expect(ipGone).toEqual("gone");
      const nextIpGone = yield* waitUntilFloatingIpGone(replaced.nextIp.id);
      expect(nextIpGone).toEqual("gone");
      const serverGone = yield* waitUntilServerGone(created.server.id);
      expect(serverGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000, exclusive: true },
);
