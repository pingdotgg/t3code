import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  connectorSource,
  location,
  logLevel,
  missingConnector,
  currentProject,
  schemaSource,
  unlinkedDatasources,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  firebasedataconnect.getProjectsLocationsServicesConnectors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsServicesConnectors on a missing connector fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const missing = yield* missingConnector();
      const error = yield* Effect.flip(
        firebasedataconnect.getProjectsLocationsServicesConnectors({
          name: missing,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page =
        yield* firebasedataconnect.listProjectsLocationsServicesConnectors({
          parent: `projects/${project}/locations/${location}/services/-`,
          pageSize: 10,
        });
      expect((page.connectors ?? []).map((item) => item.name)).not.toContain(
        missing,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebasedataconnect", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a Data Connect connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* GCP.FirebaseDataConnect.Service("App", {
            displayName: "alchemy-test-connector-svc",
            labels: { env: "test" },
          });
          const schema = yield* GCP.FirebaseDataConnect.ServicesSchema("Main", {
            service: service.name,
            source: schemaSource(),
            datasources: unlinkedDatasources,
            labels: { env: "test" },
          });
          const connector = yield* GCP.FirebaseDataConnect.ServicesConnector(
            "Queries",
            {
              service: schema.service,
              source: connectorSource,
              displayName: "alchemy-test-connector",
              labels: { env: "test" },
            },
          );
          return { service, schema, connector };
        }),
      );

      expect(created.connector.name).toContain("/connectors/");
      expect(created.connector.connectorId).toEqual(expect.any(String));
      expect(created.connector.location).toEqual(location);
      expect(created.connector.displayName).toEqual("alchemy-test-connector");
      expect(created.connector.labels).toMatchObject({ env: "test" });
      expect(created.connector.service).toEqual(created.service.name);
      expect(created.connector.reconciling).toEqual(false);

      const fetched =
        yield* firebasedataconnect.getProjectsLocationsServicesConnectors({
          name: created.connector.name,
        });
      expect(fetched.name).toEqual(created.connector.name);
      expect(fetched.displayName).toEqual("alchemy-test-connector");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* GCP.FirebaseDataConnect.Service("App", {
            serviceId: created.service.serviceId,
            displayName: "alchemy-prod-connector-svc",
            labels: { env: "prod" },
          });
          const schema = yield* GCP.FirebaseDataConnect.ServicesSchema("Main", {
            service: service.name,
            source: schemaSource(),
            datasources: unlinkedDatasources,
            labels: { env: "prod" },
          });
          const connector = yield* GCP.FirebaseDataConnect.ServicesConnector(
            "Queries",
            {
              service: schema.service,
              connectorId: created.connector.connectorId,
              source: connectorSource,
              displayName: "alchemy-prod-connector",
              labels: { env: "prod", role: "query" },
            },
          );
          return { service, schema, connector };
        }),
      );

      expect(updated.connector.name).toEqual(created.connector.name);
      expect(updated.connector.displayName).toEqual("alchemy-prod-connector");
      expect(updated.connector.labels).toMatchObject({
        env: "prod",
        role: "query",
      });

      const refetched =
        yield* firebasedataconnect.getProjectsLocationsServicesConnectors({
          name: created.connector.name,
        });
      expect(refetched.displayName).toEqual("alchemy-prod-connector");
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.connector.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebasedataconnect", "live"],
    timeout: 120_000,
  },
);
