import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import { waitUntilVolumeGone } from "./waitUntilVolumeGone.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "create, update, list, and delete a volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const volume = yield* Railway.Volume("Data", {
            project,
            environment,
            mountPath: "/data",
          });
          return { project, environment, volume };
        }),
      );

      expect(created.volume.volumeId).toEqual(expect.any(String));
      expect(created.volume.volumeId.length).toBeGreaterThan(0);
      expect(created.volume.volumeInstanceId).toEqual(expect.any(String));
      expect(created.volume.volumeInstanceId.length).toBeGreaterThan(0);
      expect(created.volume.projectId).toEqual(created.project.projectId);
      expect(created.volume.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.volume.mountPath).toEqual("/data");
      expect(created.volume.serviceId).toBeUndefined();
      expect(created.volume.name).toEqual(expect.any(String));
      expect(created.volume.name.length).toBeGreaterThan(0);
      expect(created.volume.name.length).toBeLessThanOrEqual(32);
      expect(created.volume.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.volume.sizeMB).toEqual(expect.any(Number));
      expect(created.volume.createdAt).toEqual(expect.any(String));

      const fetched = yield* railway.volumeInstance({
        id: created.volume.volumeInstanceId,
      });
      expect(fetched.id).toEqual(created.volume.volumeInstanceId);
      expect(fetched.volumeId).toEqual(created.volume.volumeId);
      expect(fetched.mountPath).toEqual("/data");
      expect(fetched.environmentId).toEqual(created.volume.environmentId);
      expect(fetched.volume.name).toEqual(created.volume.name);
      expect(fetched.volume.projectId).toEqual(created.volume.projectId);
      expect(fetched.serviceId).toBeNull();

      const provider = yield* Provider.findProvider(Railway.Volume);
      const listed = yield* provider.list();
      const found = listed.find(
        (volume) => volume.volumeId === created.volume.volumeId,
      );
      expect(found).toBeDefined();
      expect(found?.volumeInstanceId).toEqual(created.volume.volumeInstanceId);
      expect(found?.mountPath).toEqual("/data");
      expect(found?.name).toEqual(created.volume.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const volume = yield* Railway.Volume("Data", {
            project,
            environment,
            mountPath: "/app/data",
          });
          return { project, environment, volume };
        }),
      );

      expect(updated.volume.volumeId).toEqual(created.volume.volumeId);
      expect(updated.volume.volumeInstanceId).toEqual(
        created.volume.volumeInstanceId,
      );
      expect(updated.volume.projectId).toEqual(created.volume.projectId);
      expect(updated.volume.environmentId).toEqual(
        created.volume.environmentId,
      );
      expect(updated.volume.mountPath).toEqual("/app/data");
      expect(updated.volume.name).toEqual(created.volume.name);

      const fetchedUpdate = yield* railway.volumeInstance({
        id: updated.volume.volumeInstanceId,
      });
      expect(fetchedUpdate.id).toEqual(updated.volume.volumeInstanceId);
      expect(fetchedUpdate.mountPath).toEqual("/app/data");
      expect(fetchedUpdate.volume.name).toEqual(updated.volume.name);

      yield* stack.destroy();

      const gone = yield* waitUntilVolumeGone(created.volume.volumeInstanceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

test.provider(
  "refuse a second volume on a service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Api", {
            project,
            environment,
            image: "hashicorp/http-echo",
            port: 5678,
          });
          const data = yield* Railway.Volume("Data", {
            project,
            environment,
            mountPath: "/data",
            service: api,
          });
          return { project, environment, api, data };
        }),
      );

      const result = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            const { project, environment } = yield* suitePartition;
            const api = yield* Railway.Service("Api", {
              project,
              environment,
              image: "hashicorp/http-echo",
              port: 5678,
            });
            const data = yield* Railway.Volume("Data", {
              project,
              environment,
              mountPath: "/data",
              service: api,
            });
            const cache = yield* Railway.Volume("Cache", {
              project,
              environment,
              mountPath: "/cache",
              service: api,
            });
            return { project, environment, api, data, cache };
          }),
        ),
      );

      expect(created.data.serviceId).toEqual(created.api.serviceId);
      expect(Result.isFailure(result)).toEqual(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toEqual("Railway.MultipleVolumes");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
