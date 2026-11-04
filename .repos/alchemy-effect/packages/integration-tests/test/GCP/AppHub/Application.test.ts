import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apphub from "@distilled.cloud/gcp/apphub_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { isServiceEnabled } from "../ServiceState.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// App Hub is not enabled in the test project; live calls fail with
// ServiceDisabled:
// "App Hub API has not been used in project <project>
// before or it is disabled. Enable it by visiting
// https://console.developers.google.com/apis/api/apphub.googleapis.com/overview?project=<project>"
const runLifecycle = !process.env.FAST && process.env.GCP_TEST_APPHUB === "1";
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apphub.getProjectsLocationsApplications({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsApplications fails with ServiceDisabled when App Hub is disabled",
  (stack) =>
    Effect.gen(function* () {
      // Only meaningful while the API is disabled: enabled, the create would
      // provision a real resource.
      if (yield* isServiceEnabled("apphub.googleapis.com")) return;
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apphub.createProjectsLocationsApplications({
          parent: `projects/${project}/locations/${location}`,
          applicationId: "alchemy-apphub-probe",
          body: {
            displayName: "probe",
            scope: { type: "REGIONAL" },
          },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apphub", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "getProjectsLocationsApplications on a missing application fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apphub.getProjectsLocationsApplications({
          name: `projects/${project}/locations/${location}/applications/alchemy-missing-app`,
        }),
      );
      expect(["ServiceDisabled", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apphub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an App Hub application",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AppHub.Application("Checkout", {
            location,
            displayName: "checkout",
            description: "payments",
            scope: { type: "REGIONAL" },
            attributes: {
              criticality: { type: "MEDIUM" },
              environment: { type: "DEVELOPMENT" },
            },
          });
        }),
      );

      expect(created.applicationId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/${location}/applications/${created.applicationId}`,
      );
      expect(created.location).toEqual(location);
      expect(created.displayName).toEqual("checkout");
      expect(created.description).toEqual("payments");
      expect(created.scope?.type).toEqual("REGIONAL");
      expect(created.attributes?.criticality?.type).toEqual("MEDIUM");

      const fetched = yield* apphub.getProjectsLocationsApplications({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("checkout");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("payments");
      expect(fetched.scope?.type).toEqual("REGIONAL");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AppHub.Application("Checkout", {
            applicationId: created.applicationId,
            location,
            displayName: "checkout-v2",
            description: "payments v2",
            scope: { type: "REGIONAL" },
            attributes: {
              criticality: { type: "HIGH" },
              environment: { type: "TEST" },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("checkout-v2");
      expect(updated.description).toEqual("payments v2");
      expect(updated.attributes?.criticality?.type).toEqual("HIGH");
      expect(updated.attributes?.environment?.type).toEqual("TEST");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apphub", "live"], timeout: 90_000 },
);
