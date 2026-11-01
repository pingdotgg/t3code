import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

// Cloud Search needs Workspace-admin credentials with a Cloud Search license
// (others get InsufficientScopes); set GCP_TEST_CLOUDSEARCH_ADMIN=1 when the
// profile credentials have that access.
export const runLifecycle = !!process.env.GCP_TEST_CLOUDSEARCH_ADMIN;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
