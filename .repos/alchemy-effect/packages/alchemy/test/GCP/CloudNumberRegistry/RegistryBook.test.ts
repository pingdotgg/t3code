import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cnr from "@distilled.cloud/gcp/cloudnumberregistry_v1alpha";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  location,
  logLevel,
  currentProject,
  entitled,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!entitled)(
  "getProjectsLocationsRegistryBooks on a missing book fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        cnr.getProjectsLocationsRegistryBooks({
          name: `projects/${project}/locations/${location}/registryBooks/alchemy-missing-book`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudnumberregistry", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a registry book",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudNumberRegistry.RegistryBook("Inventory", {
            location,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.registryBookId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/${location}/registryBooks/${created.registryBookId}`,
      );
      expect(created.location).toEqual(location);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* cnr.getProjectsLocationsRegistryBooks({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudNumberRegistry.RegistryBook("Inventory", {
            registryBookId: created.registryBookId,
            location,
            labels: { env: "prod", role: "ipam" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.registryBookId).toEqual(created.registryBookId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "ipam" });

      const refetched = yield* cnr.getProjectsLocationsRegistryBooks({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("ipam");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        cnr.getProjectsLocationsRegistryBooks({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudnumberregistry", "live"],
    timeout: 90_000,
  },
);
