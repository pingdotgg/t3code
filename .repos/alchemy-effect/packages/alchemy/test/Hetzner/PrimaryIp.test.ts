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
  Services.primaryIps.getPrimaryIp({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "create, update, and delete an unassigned ipv6 primary ip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.PrimaryIp("WebIp", {
            type: "ipv6",
            location: "nbg1",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(Number));
      expect(created.name).toEqual(expect.any(String));
      expect(created.type).toEqual("ipv6");
      expect(created.ip).toEqual(expect.any(String));
      expect(created.location).toEqual("nbg1");
      expect(created.locationId).toEqual(expect.any(Number));
      expect(created.autoDelete).toEqual(false);
      expect(created.deleteProtection).toEqual(false);
      expect(created.assigneeId).toBeNull();
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* Services.primaryIps.getPrimaryIp({
        id: created.id,
      });
      expect(fetched.primary_ip.id).toEqual(created.id);
      expect(fetched.primary_ip.type).toEqual("ipv6");
      expect(fetched.primary_ip.ip).toEqual(created.ip);
      expect(fetched.primary_ip.location.name).toEqual("nbg1");
      expect(fetched.primary_ip.auto_delete).toEqual(false);
      expect(fetched.primary_ip.assignee_id).toBeNull();
      expect(fetched.primary_ip.labels.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.PrimaryIp("WebIp", {
            type: "ipv6",
            location: "nbg1",
            autoDelete: true,
            labels: { env: "prod", role: "web" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.ip).toEqual(created.ip);
      expect(updated.autoDelete).toEqual(true);
      expect(updated.labels).toMatchObject({ env: "prod", role: "web" });

      const refetched = yield* Services.primaryIps.getPrimaryIp({
        id: updated.id,
      });
      expect(refetched.primary_ip.auto_delete).toEqual(true);
      expect(refetched.primary_ip.labels.env).toEqual("prod");
      expect(refetched.primary_ip.labels.role).toEqual("web");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
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
          return yield* Hetzner.PrimaryIp("ReplaceIp", {
            type: "ipv6",
            location: "nbg1",
          });
        }),
      );

      expect(created.location).toEqual("nbg1");
      const previousId = Number(created.id);
      const previousIp = String(created.ip);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.PrimaryIp("ReplaceIp", {
            type: "ipv6",
            location: "fsn1",
          });
        }),
      );

      expect(replaced.id).not.toEqual(previousId);
      expect(replaced.type).toEqual("ipv6");
      expect(replaced.ip).not.toEqual(previousIp);
      expect(replaced.location).toEqual("fsn1");
      expect(replaced.assigneeId).toBeNull();

      const fetched = yield* Services.primaryIps.getPrimaryIp({
        id: replaced.id,
      });
      expect(fetched.primary_ip.location.name).toEqual("fsn1");

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "create from datacenter name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.PrimaryIp("DatacenterIp", {
            type: "ipv6",
            datacenter: "nbg1-dc3",
          });
        }),
      );

      expect(created.location).toEqual("nbg1");
      expect(created.datacenter).toEqual("nbg1-dc3");
      expect(created.type).toEqual("ipv6");
      expect(created.assigneeId).toBeNull();

      const fetched = yield* Services.primaryIps.getPrimaryIp({
        id: created.id,
      });
      expect(fetched.primary_ip.location.name).toEqual("nbg1");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "list enumerates the deployed primary ip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.PrimaryIp("ListIp", {
            type: "ipv6",
            location: "nbg1",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Hetzner.PrimaryIp);
      const all = yield* provider.list();
      const found = all.find((ip) => ip.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.type).toEqual("ipv6");
      expect(found?.location).toEqual("nbg1");
      expect(found?.ip).toEqual(deployed.ip);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
