import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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
  "create, update, and delete a machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          return yield* Fly.Machine("Web", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
          });
        }),
      );

      expect(created.machineId).toEqual(expect.any(String));
      expect(created.machineId.length).toBeGreaterThan(0);
      expect(created.machineIds).toEqual([created.machineId]);
      expect(created.count).toEqual(1);
      expect(created.appName).toEqual(expect.any(String));
      expect(created.name).toEqual(expect.any(String));
      expect(created.region).toEqual("iad");
      expect(created.state).toEqual("started");
      expect(created.privateIp).toEqual(expect.any(String));
      expect(created.guest?.cpus).toEqual(1);
      expect(created.guest?.memoryMb).toEqual(256);
      expect(created.url).toBeUndefined();

      const fetched = yield* machines.getMachine({
        app_name: created.appName,
        machine_id: created.machineId,
      });
      expect(fetched.id).toEqual(created.machineId);
      expect(fetched.name).toEqual(created.name);
      expect(fetched.region).toEqual("iad");
      expect(fetched.state).toEqual("started");
      expect(fetched.config?.image).toEqual(expect.stringContaining("nginx"));
      expect(fetched.config?.guest?.cpus).toEqual(1);
      expect(fetched.config?.guest?.memory_mb).toEqual(256);
      expect(fetched.config?.metadata?.["alchemy.type"]).toEqual("Fly.Machine");
      expect(fetched.config?.metadata?.["alchemy.replica"]).toEqual("0");
      expect(fetched.config?.metadata?.["alchemy.stack"]).toEqual(
        expect.any(String),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          return yield* Fly.Machine("Web", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            env: { ALCHEMY_MARK: "updated" },
            metadata: { role: "web" },
            restart: { policy: "on-failure", maxRetries: 3 },
            services: [
              {
                protocol: "tcp",
                internalPort: 80,
                ports: [{ port: 80, handlers: ["http"] }],
              },
            ],
          });
        }),
      );

      expect(updated.machineId).toEqual(created.machineId);
      expect(updated.appName).toEqual(created.appName);
      expect(updated.name).toEqual(created.name);
      expect(updated.region).toEqual("iad");
      expect(updated.state).toEqual("started");
      expect(updated.url).toEqual(`https://${created.appName}.fly.dev`);

      const refetched = yield* machines.getMachine({
        app_name: updated.appName,
        machine_id: updated.machineId,
      });
      expect(refetched.id).toEqual(created.machineId);
      expect(refetched.config?.env?.ALCHEMY_MARK).toEqual("updated");
      expect(refetched.config?.metadata?.role).toEqual("web");
      expect(refetched.config?.metadata?.["alchemy.type"]).toEqual(
        "Fly.Machine",
      );
      expect(refetched.config?.restart?.policy).toEqual("on-failure");
      expect(refetched.config?.restart?.max_retries).toEqual(3);
      expect(refetched.config?.services?.[0]?.internal_port).toEqual(80);
      expect(refetched.config?.services?.[0]?.ports?.[0]?.port).toEqual(80);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.appName, created.machineId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ReplaceSite");
          return yield* Fly.Machine("ReplaceWeb", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
          });
        }),
      );

      expect(created.region).toEqual("iad");

      const nextName =
        created.name.slice(0, -1) + (created.name.endsWith("z") ? "y" : "z");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ReplaceSite");
          return yield* Fly.Machine("ReplaceWeb", {
            app,
            name: nextName,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
          });
        }),
      );

      expect(replaced.machineId).not.toEqual(created.machineId);
      expect(replaced.name).toEqual(nextName);
      expect(replaced.appName).toEqual(created.appName);
      expect(replaced.region).toEqual("iad");
      expect(replaced.state).toEqual("started");

      const fetched = yield* machines.getMachine({
        app_name: replaced.appName,
        machine_id: replaced.machineId,
      });
      expect(fetched.id).toEqual(replaced.machineId);
      expect(fetched.name).toEqual(nextName);

      const oldGone = yield* waitUntilGone(created.appName, created.machineId);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.appName, replaced.machineId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ListSite");
          return yield* Fly.Machine("ListWeb", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Fly.Machine);
      const all = yield* provider.list();
      const found = all.find(
        (machine) => machine.machineId === deployed.machineId,
      );
      expect(found).toBeDefined();
      expect(found?.appName).toEqual(deployed.appName);
      expect(found?.name).toEqual(deployed.name);
      expect(found?.region).toEqual("iad");
      expect(found?.state).toEqual("started");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.appName, deployed.machineId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
