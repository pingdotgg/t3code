import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const enterpriseName =
  process.env.GCP_ANDROIDMANAGEMENT_ENTERPRISE?.trim() || undefined;

// Android Management needs credentials carrying the androidmanagement scope
// (plus an enterprise signup); the service account profile is rejected with
// InsufficientScopes. Set
// GCP_TEST_ANDROIDMANAGEMENT_OAUTH=1 with such credentials.
export const runLifecycle = !!process.env.GCP_TEST_ANDROIDMANAGEMENT_OAUTH;

export const runChildLifecycle = runLifecycle && !!enterpriseName;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
