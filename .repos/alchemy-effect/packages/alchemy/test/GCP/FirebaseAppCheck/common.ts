import { GcpEnvironment } from "@/GCP/Environment";
import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

// App Check needs a Firebase project with the App Check API enabled; the
// testing project has neither (App Check calls fail with ServiceDisabled).
// Set GCP_TEST_FIREBASE_APP_ID to a registered Firebase app id on such a
// project to run the lifecycles.
export const lifecycleAppId = process.env.GCP_TEST_FIREBASE_APP_ID;
export const runLifecycle = !!lifecycleAppId;

export const missingDebugToken = () =>
  currentProject.pipe(
    Effect.map(
      (project) =>
        `projects/${project}/apps/1:0:web:deadbeef/debugTokens/missing`,
    ),
  );

export const missingResourcePolicy = () =>
  currentProject.pipe(
    Effect.map(
      (project) =>
        `projects/${project}/services/oauth2.googleapis.com/resourcePolicies/missing`,
    ),
  );

export const waitUntilDebugTokenGone = (name: string) =>
  firebaseappcheck.getProjectsAppsDebugTokens({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const waitUntilResourcePolicyGone = (name: string) =>
  firebaseappcheck.getProjectsServicesResourcePolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
