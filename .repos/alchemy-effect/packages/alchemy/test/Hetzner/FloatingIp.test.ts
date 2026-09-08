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
  Services.floatingIps.getFloatingIp({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "create update delete unassigned ipv4",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.FloatingIp("PublicIp", {
            type: "ipv4",
            homeLocation: "nbg1",
            description: "alchemy floating ip create",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(Number));
      expect(created.name).toEqual(expect.any(String));
      expect(created.type).toEqual("ipv4");
      expect(created.ip).toEqual(expect.any(String));
      expect(created.homeLocation).toEqual("nbg1");
      expect(created.homeLocationId).toEqual(expect.any(Number));
      expect(created.description).toEqual("alchemy floating ip create");
      expect(created.deleteProtection).toEqual(false);
      expect(created.serverId).toBeNull();
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* Services.floatingIps.getFloatingIp({
        id: created.id,
      });
      expect(fetched.floating_ip.id).toEqual(created.id);
      expect(fetched.floating_ip.type).toEqual("ipv4");
      expect(fetched.floating_ip.ip).toEqual(created.ip);
      expect(fetched.floating_ip.home_location.name).toEqual("nbg1");
      expect(fetched.floating_ip.description).toEqual(
        "alchemy floating ip create",
      );
      expect(fetched.floating_ip.server).toBeNull();
      expect(fetched.floating_ip.labels.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.FloatingIp("PublicIp", {
            type: "ipv4",
            homeLocation: "nbg1",
            description: "alchemy floating ip update",
            labels: { env: "prod", role: "edge" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.ip).toEqual(created.ip);
      expect(updated.description).toEqual("alchemy floating ip update");
      expect(updated.labels).toMatchObject({ env: "prod", role: "edge" });

      const refetched = yield* Services.floatingIps.getFloatingIp({
        id: updated.id,
      });
      expect(refetched.floating_ip.description).toEqual(
        "alchemy floating ip update",
      );
      expect(refetched.floating_ip.labels.env).toEqual("prod");
      expect(refetched.floating_ip.labels.role).toEqual("edge");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "replace when type changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.FloatingIp("ReplaceIp", {
            type: "ipv4",
            homeLocation: "nbg1",
          });
        }),
      );

      expect(created.type).toEqual("ipv4");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.FloatingIp("ReplaceIp", {
            type: "ipv6",
            homeLocation: "nbg1",
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.type).toEqual("ipv6");
      expect(replaced.ip).not.toEqual(created.ip);
      expect(replaced.homeLocation).toEqual("nbg1");
      expect(replaced.serverId).toBeNull();

      const fetched = yield* Services.floatingIps.getFloatingIp({
        id: replaced.id,
      });
      expect(fetched.floating_ip.type).toEqual("ipv6");

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "list enumerates the deployed floating ip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.FloatingIp("ListIp", {
            type: "ipv4",
            homeLocation: "nbg1",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Hetzner.FloatingIp);
      const all = yield* provider.list();
      const found = all.find((ip) => ip.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.type).toEqual("ipv4");
      expect(found?.homeLocation).toEqual("nbg1");
      expect(found?.ip).toEqual(deployed.ip);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
