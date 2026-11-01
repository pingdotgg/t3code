import { GcpEnvironment } from "@/GCP/Environment";
import { MinimumLogLevel } from "effect/References";
import * as Effect from "effect/Effect";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Cloud Talent Solution needs a console-only data-permission opt-in
// (GCP_TEST_TALENT_ONBOARDED=1). Without it, every call except deletes fails
// with `BadRequest: Service must be permitted to access job and behavioral
// data to improve common machine learning models ...`.
export const runLifecycle = !!process.env.GCP_TEST_TALENT_ONBOARDED;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
