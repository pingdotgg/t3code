import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const runLifecycle = !process.env.FAST;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
export const location = "us-central1";
/** Analytics Hub listings/query templates delete reliably in the US multi-region. */
export const hubLocation = "US";
export const primaryContactOf = (project: string) =>
  `alchemy-testing@${project}.iam.gserviceaccount.com`;
