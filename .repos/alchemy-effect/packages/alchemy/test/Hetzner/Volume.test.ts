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
  Services.volumes.getVolume({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "create, update, and delete an unattached volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Volume("Data", {
            size: 10,
            format: "ext4",
            location: "nbg1",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(Number));
      expect(created.name).toEqual(expect.any(String));
      expect(created.size).toEqual(10);
      expect(created.format).toEqual("ext4");
      expect(created.location).toEqual("nbg1");
      expect(created.locationId).toEqual(expect.any(Number));
      expect(created.linuxDevice).toMatch(/^\/dev\//);
      expect(created.serverId).toBeNull();
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* Services.volumes.getVolume({
        id: created.id,
      });
      expect(fetched.volume.id).toEqual(created.id);
      expect(fetched.volume.size).toEqual(10);
      expect(fetched.volume.format).toEqual("ext4");
      expect(fetched.volume.location.name).toEqual("nbg1");
      expect(fetched.volume.linux_device).toEqual(created.linuxDevice);
      expect(fetched.volume.server).toBeNull();
      expect(fetched.volume.labels.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Volume("Data", {
            size: 20,
            format: "ext4",
            location: "nbg1",
            labels: { env: "prod", role: "data" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.linuxDevice).toEqual(created.linuxDevice);
      expect(updated.size).toEqual(20);
      expect(updated.labels).toMatchObject({ env: "prod", role: "data" });

      const refetched = yield* Services.volumes.getVolume({
        id: updated.id,
      });
      expect(refetched.volume.size).toEqual(20);
      expect(refetched.volume.linux_device).toEqual(created.linuxDevice);
      expect(refetched.volume.labels.env).toEqual("prod");
      expect(refetched.volume.labels.role).toEqual("data");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "replace when format changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Volume("ReplaceData", {
            size: 10,
            format: "ext4",
            location: "nbg1",
          });
        }),
      );

      expect(created.format).toEqual("ext4");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Volume("ReplaceData", {
            size: 10,
            format: "xfs",
            location: "nbg1",
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.format).toEqual("xfs");
      expect(replaced.location).toEqual("nbg1");
      expect(replaced.serverId).toBeNull();

      const fetched = yield* Services.volumes.getVolume({
        id: replaced.id,
      });
      expect(fetched.volume.format).toEqual("xfs");

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "list enumerates the deployed volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Volume("ListData", {
            size: 10,
            format: "ext4",
            location: "nbg1",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Hetzner.Volume);
      const all = yield* provider.list();
      const found = all.find((volume) => volume.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.size).toEqual(10);
      expect(found?.format).toEqual("ext4");
      expect(found?.location).toEqual("nbg1");
      expect(found?.linuxDevice).toEqual(deployed.linuxDevice);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
