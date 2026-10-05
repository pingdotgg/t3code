import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as connectors from "@distilled.cloud/gcp/connectors_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Entity CRUD needs a running Integration Connectors connection. Without
// one, the entity API answers HTTP 501 (EntitiesNotImplemented).
const connectorsParent = process.env.GCP_TEST_CONNECTORS_PARENT?.trim();

const missingParent = (project: string) =>
  `projects/${project}/locations/us-central1/connections/alchemy-missing/entityTypes/Account`;

const waitUntilGone = (name: string) =>
  connectors.getProjectsLocationsConnectionsEntityTypesEntities({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsConnectionsEntityTypesEntities under a missing connection fails with EntitiesNotImplemented",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        connectors.getProjectsLocationsConnectionsEntityTypesEntities({
          name: `${missingParent(project)}/entities/alchemy-missing-entity`,
        }),
      );
      expect(error._tag).toEqual("EntitiesNotImplemented");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:connectors", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "createProjectsLocationsConnectionsEntityTypesEntities under a missing connection fails with EntitiesNotImplemented",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        connectors.createProjectsLocationsConnectionsEntityTypesEntities({
          parent: missingParent(project),
          body: { fields: { Name: "Alchemy Probe" } },
        }),
      );
      expect(error._tag).toEqual("EntitiesNotImplemented");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:connectors", "live"],
    timeout: 90_000,
  },
);

// Set GCP_TEST_CONNECTORS_PARENT to an entity type
// (`…/connections/{c}/entityTypes/{type}`) of a running connection.
test.provider.skipIf(!connectorsParent)(
  "create, update, and delete an entity",
  (stack) =>
    Effect.gen(function* () {
      const entityTypeParent = connectorsParent!;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Connectors.ConnectionsEntityTypesEntity("Account", {
            parent: entityTypeParent,
            fields: { Name: "Alchemy Test" },
          });
        }),
      );

      expect(created.entityId.length).toBeGreaterThan(0);
      expect(created.parent).toEqual(entityTypeParent);
      expect(created.name).toContain("/entities/");
      expect(created.fields).toMatchObject({ Name: "Alchemy Test" });

      const fetched =
        yield* connectors.getProjectsLocationsConnectionsEntityTypesEntities({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.fields).toMatchObject({ Name: "Alchemy Test" });

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Connectors.ConnectionsEntityTypesEntity("Account", {
            parent: entityTypeParent,
            fields: { Name: "Alchemy Test Corp" },
          });
        }),
      );

      expect(updated.entityId).toEqual(created.entityId);
      expect(updated.fields).toMatchObject({ Name: "Alchemy Test Corp" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:connectors", "live"],
    timeout: 90_000,
  },
);
