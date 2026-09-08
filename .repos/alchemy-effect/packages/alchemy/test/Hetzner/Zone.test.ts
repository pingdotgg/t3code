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

const waitUntilGone = (zoneId: number) =>
  Services.zones.getZone({ id_or_name: String(zoneId) }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "create, update, and delete a zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Zone("BasicZone", {
            ttl: 3600,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.zoneId).toEqual(expect.any(Number));
      expect(created.name).toMatch(/\.com$/);
      expect(created.mode).toEqual("primary");
      expect(created.ttl).toEqual(3600);
      expect(created.deleteProtection).toEqual(false);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.assignedNameservers.length).toBeGreaterThan(0);
      expect(created.created).toEqual(expect.any(String));

      const fetched = yield* Services.zones.getZone({
        id_or_name: String(created.zoneId),
      });
      expect(fetched.zone.id).toEqual(created.zoneId);
      expect(fetched.zone.name).toEqual(created.name);
      expect(fetched.zone.ttl).toEqual(3600);
      expect(fetched.zone.protection.delete).toEqual(false);
      expect(fetched.zone.labels.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Zone("BasicZone", {
            name: created.name,
            ttl: 7200,
            labels: { env: "prod", role: "dns" },
            deleteProtection: true,
          });
        }),
      );

      expect(updated.zoneId).toEqual(created.zoneId);
      expect(updated.name).toEqual(created.name);
      expect(updated.ttl).toEqual(7200);
      expect(updated.deleteProtection).toEqual(true);
      expect(updated.labels).toMatchObject({ env: "prod", role: "dns" });

      const refetched = yield* Services.zones.getZone({
        id_or_name: String(updated.zoneId),
      });
      expect(refetched.zone.ttl).toEqual(7200);
      expect(refetched.zone.protection.delete).toEqual(true);
      expect(refetched.zone.labels.env).toEqual("prod");
      expect(refetched.zone.labels.role).toEqual("dns");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.zoneId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "replace when name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Zone("ReplaceZone", {
            ttl: 3600,
          });
        }),
      );

      // Keep the first label ≤ 63 chars (DNS). The generated apex is already
      // at the cap, so we rewrite the tail instead of appending.
      const apex = created.name.replace(/\.com$/, "");
      const replacementName = `${apex.slice(0, 61)}r.com`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Zone("ReplaceZone", {
            name: replacementName,
            ttl: 3600,
          });
        }),
      );

      expect(replaced.zoneId).not.toEqual(created.zoneId);
      expect(replaced.name).toEqual(replacementName);

      const fetched = yield* Services.zones.getZone({
        id_or_name: String(replaced.zoneId),
      });
      expect(fetched.zone.id).toEqual(replaced.zoneId);
      expect(fetched.zone.name).toEqual(replacementName);

      const oldGone = yield* waitUntilGone(created.zoneId);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.zoneId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "list enumerates the deployed zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Zone("ListZone", {
            ttl: 3600,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Hetzner.Zone);
      const all = yield* provider.list();
      const found = all.find((zone) => zone.zoneId === deployed.zoneId);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.ttl).toEqual(3600);
      expect(found?.mode).toEqual("primary");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.zoneId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
