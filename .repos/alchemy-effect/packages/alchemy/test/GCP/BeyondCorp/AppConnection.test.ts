import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as beyondcorp from "@distilled.cloud/gcp/beyondcorp_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  logLevel,
  currentProject,
  runLifecycle,
  serviceAccountEmailOf,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  beyondcorp.getProjectsLocationsAppConnections({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAppConnections on a missing connection fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        beyondcorp.getProjectsLocationsAppConnections({
          name: `projects/${project}/locations/us-central1/appConnections/alchemy-missing-ac`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* beyondcorp.listProjectsLocationsAppConnections({
        parent: `projects/${project}/locations/us-central1`,
        pageSize: 10,
      });
      expect(
        (page.appConnections ?? []).map((item) => item.name),
      ).not.toContain(
        `projects/${project}/locations/us-central1/appConnections/alchemy-missing-ac`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:beyondcorp", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsAppConnections without entitlement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        beyondcorp.createProjectsLocationsAppConnections({
          parent: `projects/${project}/locations/us-central1`,
          appConnectionId: "alch-probe-ac",
          validateOnly: true,
          body: {
            type: "TCP_PROXY",
            applicationEndpoint: { host: "10.0.0.4", port: 8080 },
          },
        }),
      );
      expect(error._tag).toEqual("AppConnectorsNotImplemented");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:beyondcorp", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an app connection",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const serviceAccountEmail = serviceAccountEmailOf(project);
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* GCP.BeyondCorp.AppGateway("Edge", {
            location: "us-central1",
          });
          const connector = yield* GCP.BeyondCorp.AppConnector("Agent", {
            location: "us-central1",
            serviceAccountEmail,
          });
          return yield* GCP.BeyondCorp.AppConnection("App", {
            location: "us-central1",
            type: "TCP_PROXY",
            applicationEndpoint: { host: "10.0.0.4", port: 8080 },
            gateway: { appGateway: gateway.name },
            connectors: [connector.name],
            displayName: "connection a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/appConnections/");
      expect(created.location).toEqual("us-central1");
      expect(created.applicationEndpoint?.host).toEqual("10.0.0.4");
      expect(created.applicationEndpoint?.port).toEqual(8080);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* beyondcorp.getProjectsLocationsAppConnections({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.applicationEndpoint?.port).toEqual(8080);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* GCP.BeyondCorp.AppGateway("Edge", {
            location: "us-central1",
          });
          const connector = yield* GCP.BeyondCorp.AppConnector("Agent", {
            location: "us-central1",
            serviceAccountEmail,
          });
          return yield* GCP.BeyondCorp.AppConnection("App", {
            appConnectionId: created.appConnectionId,
            location: "us-central1",
            type: "TCP_PROXY",
            applicationEndpoint: { host: "10.0.0.8", port: 8443 },
            gateway: { appGateway: gateway.name },
            connectors: [connector.name],
            displayName: "connection b",
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.applicationEndpoint?.host).toEqual("10.0.0.8");
      expect(updated.applicationEndpoint?.port).toEqual(8443);
      expect(updated.displayName).toEqual("connection b");
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:beyondcorp", "live"],
    timeout: 120_000,
  },
);
