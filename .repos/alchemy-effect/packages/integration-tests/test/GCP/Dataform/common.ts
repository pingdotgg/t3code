import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const currentProject = GcpEnvironment.current.pipe(Effect.map((env) => env.project));

/** The testing profile's own service account, derived from the configured project. */
export const testServiceAccount = currentProject.pipe(
  Effect.map((project) => `alchemy-testing@${project}.iam.gserviceaccount.com`),
);

export const waitUntilGone = <E extends { readonly _tag: string }, R>(
  get: Effect.Effect<unknown, E, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
