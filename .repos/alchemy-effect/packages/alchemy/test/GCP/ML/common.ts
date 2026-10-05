import { GcpEnvironment } from "@/GCP/Environment";
import { MinimumLogLevel } from "effect/References";
import * as Effect from "effect/Effect";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// AI Platform Training & Prediction (`ml.googleapis.com`) is deprecated: new
// projects get AiPlatformDeprecated ("Cloud AI Platform has been deprecated. Please use
// Vertex AI … instead."). Set GCP_TEST_ML_LEGACY_PROJECT=1 on a project that
// still has legacy access. Version create also needs a trained SavedModel at
// GCP_TEST_ML_DEPLOYMENT_URI.
export const runLifecycle = !!process.env.GCP_TEST_ML_LEGACY_PROJECT;

export const runVersionLifecycle =
  runLifecycle && !!process.env.GCP_TEST_ML_DEPLOYMENT_URI;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const region = "us-central1";
