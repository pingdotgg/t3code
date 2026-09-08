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

const waitUntilVolumeGone = (id: number) =>
  Services.volumes.getVolume({ id }).pipe(
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
  "create, list, and delete a volume attachment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* Hetzner.Server("Web", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
          const volume = yield* Hetzner.Volume("Data", {
            size: 10,
            format: "ext4",
            location: "nbg1",
          });
          const attachment = yield* Hetzner.VolumeAttachment("DataAttach", {
            volume,
            server,
            automount: false,
          });
          return { server, volume, attachment };
        }),
      );

      expect(created.attachment.volumeId).toEqual(created.volume.id);
      expect(created.attachment.serverId).toEqual(created.server.serverId);
      expect(created.attachment.automount).toEqual(false);
      expect(created.attachment.linuxDevice).toMatch(/^\/dev\//);
      expect(created.volume.serverId).toBeNull();

      const fetched = yield* Services.volumes.getVolume({
        id: created.volume.id,
      });
      expect(fetched.volume.server).toEqual(created.server.id);
      expect(fetched.volume.linux_device).toEqual(
        created.attachment.linuxDevice,
      );

      const provider = yield* Provider.findProvider(Hetzner.VolumeAttachment);
      const listed = yield* provider.list();
      const found = listed.find(
        (item) =>
          item.volumeId === created.volume.id &&
          item.serverId === created.server.id,
      );
      expect(found).toBeDefined();
      expect(found?.linuxDevice).toEqual(created.attachment.linuxDevice);

      yield* stack.destroy();

      const volumeGone = yield* waitUntilVolumeGone(created.volume.id);
      expect(volumeGone).toEqual("gone");
      const serverGone = yield* waitUntilServerGone(created.server.id);
      expect(serverGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000, exclusive: true },
);
