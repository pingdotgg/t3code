import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

// Postmaster Tools needs user OAuth credentials with the postmaster scope and a
// verified sending domain; the service account profile is rejected with
// InsufficientScopes. Set
// GCP_TEST_POSTMASTER_OAUTH=1 with such credentials.
export const runLifecycle = !!process.env.GCP_TEST_POSTMASTER_OAUTH;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
