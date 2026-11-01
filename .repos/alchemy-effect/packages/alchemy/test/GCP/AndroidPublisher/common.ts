import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const packageName =
  process.env.GCP_ANDROIDPUBLISHER_PACKAGE_NAME?.trim() ||
  process.env.GCP_PLAY_PACKAGE_NAME?.trim();

// Lifecycles need a Play Console app the credentials can manage; set
// GCP_ANDROIDPUBLISHER_PACKAGE_NAME to run them.
export const runLifecycle = !!packageName;

export const probePackageName = packageName ?? "com.alchemy.missing.app";

// The cloud-platform token of the testing profile lacks the androidpublisher
// scope, so without a Play app every call is rejected with Forbidden
// ("Request had insufficient authentication scopes.").
export const missingTag = runLifecycle ? "NotFound" : "Forbidden";
