import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Api from "./fixtures/api.ts";
import { MARKER, Site, VOLUME_PATH } from "./fixtures/shared.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (appName: string, machineId: string) =>
  machines
    .getMachine({
      app_name: appName,
      machine_id: machineId,
    })
    .pipe(
      Effect.map((machine) =>
        machine.state === "destroyed" ? ("gone" as const) : ("found" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "deploy token probe is typed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.App("TokenSite");
        }),
      );

      const minted = yield* machines.createAppDeployToken({
        app_name: app.appName,
      });
      expect(minted.token).toEqual(expect.any(String));
      expect(minted.token!.length).toBeGreaterThan(0);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider(
  "create, serve, mount, and delete a service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Site;
          const ip = yield* Fly.IpAssignment("Shared", {
            app,
            type: "shared_v4",
          });
          const api = yield* Api;
          return { app, ip, api };
        }),
      );

      expect(deployed.api.machineId).toEqual(expect.any(String));
      expect(deployed.api.machineId.length).toBeGreaterThan(0);
      expect(deployed.api.machineIds).toEqual([deployed.api.machineId]);
      expect(deployed.api.count).toEqual(1);
      expect(deployed.api.appName).toEqual(deployed.app.appName);
      expect(deployed.api.name).toEqual(expect.any(String));
      expect(deployed.api.region).toEqual("iad");
      expect(deployed.api.state).toEqual("started");
      expect(deployed.api.url).toEqual(
        `https://${deployed.app.appName}.fly.dev`,
      );
      expect(deployed.api.code.hash).toEqual(expect.any(String));
      expect(deployed.api.code.hash.length).toBeGreaterThan(0);
      expect(deployed.api.mounts[0]?.path).toEqual(VOLUME_PATH);
      expect(deployed.api.mounts[0]?.volumeId).toEqual(expect.any(String));

      const fetched = yield* machines.getMachine({
        app_name: deployed.api.appName,
        machine_id: deployed.api.machineId,
      });
      expect(fetched.id).toEqual(deployed.api.machineId);
      expect(fetched.name).toEqual(deployed.api.name);
      expect(fetched.region).toEqual("iad");
      expect(fetched.state).toEqual("started");
      expect(fetched.config?.metadata?.["alchemy.type"]).toEqual("Fly.Service");
      expect(fetched.config?.metadata?.["alchemy.stack"]).toEqual(
        expect.any(String),
      );
      expect(fetched.config?.image).toEqual(
        expect.stringContaining("registry.fly.io/"),
      );
      expect(fetched.config?.image).toEqual(
        expect.stringContaining(deployed.api.code.hash),
      );
      expect(fetched.config?.mounts?.[0]?.path).toEqual(VOLUME_PATH);
      expect(fetched.config?.mounts?.[0]?.volume).toEqual(
        deployed.api.mounts[0]?.volumeId,
      );
      expect(fetched.config?.metadata?.["alchemy.replica"]).toEqual("0");
      expect(fetched.config?.guest?.cpus).toEqual(1);
      expect(fetched.config?.guest?.memory_mb).toEqual(256);

      const liveVolume = yield* machines.getVolumeById({
        app_name: deployed.api.appName,
        volume_id: deployed.api.mounts[0]!.volumeId,
      });
      expect(liveVolume.attached_machine_id).toEqual(deployed.api.machineId);

      const provider = yield* Provider.findProvider(Fly.Service);
      const all = yield* provider.list();
      const found = all.find(
        (service) => service.machineId === deployed.api.machineId,
      );
      expect(found).toBeDefined();
      expect(found?.appName).toEqual(deployed.api.appName);
      expect(found?.name).toEqual(deployed.api.name);
      expect(found?.region).toEqual("iad");

      const body = yield* HttpClient.get(deployed.api.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.fail(new Error(`api returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("4 seconds"),
          times: 10,
        }),
        Effect.map((value) => value as { text: string; path: string }),
      );
      expect(body.path).toEqual(VOLUME_PATH);
      expect(body.text).toEqual(MARKER);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        deployed.api.appName,
        deployed.api.machineId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
