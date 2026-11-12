import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const currentProject = GcpEnvironment.current.pipe(Effect.map((env) => env.project));

export const location = "global";

export const currentParent = currentProject.pipe(
  Effect.map((project) => `projects/${project}/locations/${location}`),
);
