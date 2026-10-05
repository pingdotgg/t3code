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
  beyondcorp.getProjectsLocationsAppConnectors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAppConnectors on a missing connector fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        beyondcorp.getProjectsLocationsAppConnectors({
          name: `projects/${project}/locations/us-central1/appConnectors/alchemy-missing-cn`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* beyondcorp.listProjectsLocationsAppConnectors({
        parent: `projects/${project}/locations/us-central1`,
        pageSize: 10,
      });
      expect((page.appConnectors ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/appConnectors/alchemy-missing-cn`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:beyondcorp", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsAppConnectors without entitlement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const serviceAccountEmail = serviceAccountEmailOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        beyondcorp.createProjectsLocationsAppConnectors({
          parent: `projects/${project}/locations/us-central1`,
          appConnectorId: "alch-probe-cn",
          validateOnly: true,
          body: {
            principalInfo: {
              serviceAccount: { email: serviceAccountEmail },
            },
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
  "create, update, and delete an app connector",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const serviceAccountEmail = serviceAccountEmailOf(project);
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BeyondCorp.AppConnector("Agent", {
            location: "us-central1",
            serviceAccountEmail,
            displayName: "connector a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/appConnectors/");
      expect(created.location).toEqual("us-central1");
      expect(created.serviceAccountEmail).toEqual(serviceAccountEmail);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* beyondcorp.getProjectsLocationsAppConnectors({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BeyondCorp.AppConnector("Agent", {
            appConnectorId: created.appConnectorId,
            location: "us-central1",
            serviceAccountEmail,
            displayName: "connector b",
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("connector b");
      expect(updated.labels).toMatchObject({ env: "prod" });

      const refetched = yield* beyondcorp.getProjectsLocationsAppConnectors({
        name: created.name,
      });
      expect(refetched.displayName).toEqual("connector b");
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:beyondcorp", "live"],
    timeout: 120_000,
  },
);
