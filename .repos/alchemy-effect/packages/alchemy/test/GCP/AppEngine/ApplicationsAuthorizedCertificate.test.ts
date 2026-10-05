import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as appengine from "@distilled.cloud/gcp/appengine_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { CERT_A, CERT_B, KEY_A, KEY_B } from "./fixtures/cert.ts";
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

const location = "us-central";

const waitUntilGone = (
  projectsId: string,
  locationsId: string,
  applicationsId: string,
  certificateId: string,
) =>
  appengine
    .getProjectsLocationsApplicationsAuthorizedCertificates({
      projectsId,
      locationsId,
      applicationsId,
      authorizedCertificatesId: certificateId,
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
  "getProjectsLocationsApplicationsAuthorizedCertificates on a missing certificate fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.getProjectsLocationsApplicationsAuthorizedCertificates({
          projectsId: project,
          locationsId: location,
          applicationsId: project,
          authorizedCertificatesId: "missing",
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:appengine", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsApplicationsAuthorizedCertificates without an App Engine app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.createProjectsLocationsApplicationsAuthorizedCertificates({
          projectsId: project,
          locationsId: location,
          applicationsId: project,
          body: {
            displayName: "Alchemy Appengine Probe",
            certificateRawData: {
              publicCertificate: CERT_A,
              privateKey: KEY_A,
            },
          },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:appengine", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an applications authorized certificate",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AppEngine.ApplicationsAuthorizedCertificate(
            "FrontendTls",
            {
              displayName: "frontend",
              publicCertificate: CERT_A,
              privateKey: KEY_A,
            },
          );
        }),
      );

      expect(created.certificateId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("frontend");
      expect(created.applicationsId).toEqual(project);

      const fetched =
        yield* appengine.getProjectsLocationsApplicationsAuthorizedCertificates(
          {
            projectsId: created.project,
            locationsId: created.location,
            applicationsId: created.applicationsId,
            authorizedCertificatesId: created.certificateId,
          },
        );
      expect(fetched.id).toEqual(created.certificateId);
      expect(fetched.displayName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AppEngine.ApplicationsAuthorizedCertificate(
            "FrontendTls",
            {
              certificateId: created.certificateId,
              location: created.location,
              displayName: "frontend-prod",
              publicCertificate: CERT_B,
              privateKey: KEY_B,
            },
          );
        }),
      );

      expect(updated.certificateId).toEqual(created.certificateId);
      expect(updated.displayName).toEqual("frontend-prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.location,
        created.applicationsId,
        created.certificateId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:appengine", "live"], timeout: 90_000 },
);
