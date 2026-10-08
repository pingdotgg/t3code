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
  "getProjectsLocationsRealms on a missing realm fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        cnr.getProjectsLocationsRealms({
          name: `projects/${project}/locations/${location}/realms/alchemy-missing-realm`,
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

test.provider.skipIf(entitled)(
  "getProjectsLocationsRealms fails with ServiceDisabled while the API is disabled",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        cnr.getProjectsLocationsRealms({
          name: `projects/${project}/locations/${location}/realms/alchemy-missing-realm`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudnumberregistry", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a realm",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const book = yield* GCP.CloudNumberRegistry.RegistryBook(
            "Inventory",
            {
              location,
              labels: { env: "test" },
            },
          );
          const realm = yield* GCP.CloudNumberRegistry.Realm("Private", {
            location,
            registryBook: book.name,
            trafficType: "PRIVATE",
            managementType: "USER",
            ipVersion: "IPV4",
            labels: { env: "test" },
          });
          return { book, realm };
        }),
      );

      expect(created.realm.realmId).toEqual(expect.any(String));
      expect(created.realm.name).toEqual(
        `projects/${project}/locations/${location}/realms/${created.realm.realmId}`,
      );
      expect(created.realm.location).toEqual(location);
      expect(created.realm.trafficType).toEqual("PRIVATE");
      expect(created.realm.managementType).toEqual("USER");
      expect(created.realm.labels).toMatchObject({ env: "test" });

      const fetched = yield* cnr.getProjectsLocationsRealms({
        name: created.realm.name,
      });
      expect(fetched.name).toEqual(created.realm.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const book = yield* GCP.CloudNumberRegistry.RegistryBook(
            "Inventory",
            {
              registryBookId: created.book.registryBookId,
              location,
              labels: { env: "test" },
            },
          );
          const realm = yield* GCP.CloudNumberRegistry.Realm("Private", {
            realmId: created.realm.realmId,
            location,
            registryBook: book.name,
            trafficType: "PRIVATE",
            managementType: "USER",
            ipVersion: "IPV4",
            labels: { env: "prod", role: "realm" },
          });
          return { book, realm };
        }),
      );

      expect(updated.realm.name).toEqual(created.realm.name);
      expect(updated.realm.realmId).toEqual(created.realm.realmId);
      expect(updated.realm.labels).toMatchObject({
        env: "prod",
        role: "realm",
      });

      const refetched = yield* cnr.getProjectsLocationsRealms({
        name: created.realm.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("realm");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        cnr.getProjectsLocationsRealms({ name: created.realm.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudnumberregistry", "live"],
    timeout: 90_000,
  },
);
