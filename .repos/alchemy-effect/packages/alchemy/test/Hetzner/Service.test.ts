import * as Hetzner from "@/Hetzner";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Api from "./fixtures/api.ts";
import { Data, MARKER } from "./fixtures/shared.ts";
import Worker from "./fixtures/worker.ts";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const waitUntilGone = (id: number) =>
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
  "two services on one server share a mounted volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const volume = yield* Data;
          const worker = yield* Worker;
          const api = yield* Api;
          return { volume, worker, api };
        }),
      );

      expect(deployed.api.serverId).toEqual(deployed.worker.serverId);
      expect(deployed.api.ipv4).toEqual(expect.any(String));
      expect(deployed.api.url).toContain(deployed.api.ipv4);
      expect(deployed.api.port).toEqual(3000);
      expect(deployed.api.unitName).toEqual(expect.any(String));
      expect(deployed.api.code.hash).toEqual(expect.any(String));
      expect(deployed.worker.unitName).not.toEqual(deployed.api.unitName);

      const fetched = yield* Services.servers.getServer({
        id: deployed.api.serverId,
      });
      expect(fetched.server?.id).toEqual(deployed.api.serverId);
      expect(fetched.server?.public_net.ipv4?.ip).toEqual(deployed.api.ipv4);

      const liveVolume = yield* Services.volumes.getVolume({
        id: deployed.volume.id,
      });
      expect(liveVolume.volume.server).toEqual(deployed.api.serverId);
      expect(liveVolume.volume.linux_device).toMatch(/^\/dev\//);

      const body = yield* HttpClient.get(deployed.api.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.fail(new Error(`api returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
        Effect.map((value) => value as { text: string; path: string }),
      );
      expect(body.path).toEqual("/data");
      expect(body.text).toEqual(MARKER);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.api.serverId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000, exclusive: true },
);
