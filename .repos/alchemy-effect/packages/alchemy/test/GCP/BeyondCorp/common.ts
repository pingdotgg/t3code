import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

// Needs a Chrome Enterprise Premium (BeyondCorp Enterprise) subscription
// (GCP_TEST_CHROME_ENTERPRISE_PREMIUM=1). Without it, app connector/connection/
// gateway creates fail with `AppConnectorsNotImplemented` (HTTP 501 "This
// function is not implemented") and security gateway creates fail with
// `BadRequest: ... Chrome Enterprise Premium SKU is not enabled.`
export const runLifecycle = !!process.env.GCP_TEST_CHROME_ENTERPRISE_PREMIUM;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const serviceAccountEmailOf = (project: string) =>
  process.env.GOOGLE_CONNECTOR_SA_EMAIL ??
  `alchemy-testing@${project}.iam.gserviceaccount.com`;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
