import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as appengine from "@distilled.cloud/gcp/appengine_v1";
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

// Needs an App Engine application in the project, which is permanent once
// created (it can never be deleted). The testing project has none and the
// App Engine Admin API is off (ServiceDisabled: "App Engine Admin API has not been
// used in project ... or it is disabled."). Set GCP_TEST_APPENGINE_APP=1 on a
// project with an app to run the lifecycle.
const runLifecycle = !!process.env.GCP_TEST_APPENGINE_APP;

const sourceUrl = process.env.GCP_TEST_APPENGINE_SOURCE_URL ?? "";

const waitUntilGone = (
  appsId: string,
  servicesId: string,
  versionsId: string,
) =>
  appengine
    .getAppsServicesVersions({
      appsId,
      servicesId,
      versionsId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getAppsServicesVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.getAppsServicesVersions({
          appsId: project,
          servicesId: "default",
          versionsId: "alchemy-missing",
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:appengine", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createAppsServicesVersions without an App Engine app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.createAppsServicesVersions({
          appsId: project,
          servicesId: "default",
          body: {
            id: "alchemy-probe",
            runtime: "python311",
          },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:appengine", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle || sourceUrl.length === 0)(
  "create, update, and delete a service version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AppEngine.AppsServicesVersion("Api", {
            runtime: "python311",
            servingStatus: "SERVING",
            automaticScaling: {
              standardSchedulerSettings: {
                minInstances: 0,
                maxInstances: 1,
              },
            },
            deployment: {
              zip: { sourceUrl },
            },
          });
        }),
      );

      expect(created.versionId.length).toBeGreaterThan(0);
      expect(created.runtime).toEqual("python311");
      expect(created.serviceId).toEqual("default");

      const fetched = yield* appengine.getAppsServicesVersions({
        appsId: created.appsId,
        servicesId: created.serviceId,
        versionsId: created.versionId,
        view: "FULL",
      });
      expect(fetched.id).toEqual(created.versionId);
      expect(fetched.envVariables?.ALCHEMY_OWNERSHIP).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AppEngine.AppsServicesVersion("Api", {
            versionId: created.versionId,
            runtime: "python311",
            servingStatus: "STOPPED",
            deployment: {
              zip: { sourceUrl },
            },
          });
        }),
      );

      expect(updated.versionId).toEqual(created.versionId);
      expect(updated.servingStatus).toEqual("STOPPED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.appsId,
        created.serviceId,
        created.versionId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:appengine", "live"],
    timeout: 120_000,
  },
);
