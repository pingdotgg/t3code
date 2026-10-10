import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
export const location = "us-central1";

export const serviceAccountOf = (project: string) =>
  process.env.GCP_TEST_FIREBASE_APP_HOSTING_SA ??
  `alchemy-testing@${project}.iam.gserviceaccount.com`;

export const missingBackendOf =
  (project: string) =>
  (backendId = "alchemy-missing-backend") =>
    `projects/${project}/locations/${location}/backends/${backendId}`;
