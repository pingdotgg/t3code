import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  networkservices.getProjectsLocationsMeshes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsMeshes on a missing mesh fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsMeshes({
          name: `projects/${project}/locations/global/meshes/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a mesh",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.Mesh("Sidecar", {
            location: "global",
            description: "mesh a",
            labels: { env: "test" },
            interceptionPort: 15001,
          });
        }),
      );

      expect(created.name).toContain("/meshes/");
      expect(created.meshId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.description).toEqual("mesh a");
      expect(created.interceptionPort).toEqual(15001);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched = yield* networkservices.getProjectsLocationsMeshes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("mesh a");
      expect(fetched.interceptionPort).toEqual(15001);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.Mesh("Sidecar", {
            meshId: created.meshId,
            location: "global",
            description: "mesh b",
            labels: { env: "prod", role: "mesh" },
            interceptionPort: 15006,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("mesh b");
      expect(updated.interceptionPort).toEqual(15006);
      expect(updated.labels).toMatchObject({ env: "prod", role: "mesh" });

      const refetched = yield* networkservices.getProjectsLocationsMeshes({
        name: created.name,
      });
      expect(refetched.description).toEqual("mesh b");
      expect(refetched.interceptionPort).toEqual(15006);
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("mesh");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);
