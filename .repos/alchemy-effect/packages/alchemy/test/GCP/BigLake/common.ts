import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
export const location = "us-central1";

export const waitUntilGone = <E extends { readonly _tag: string }, R>(
  get: Effect.Effect<unknown, E, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchIf(
      // BigLake answers a missing resource with 403, typed
      // BigLakeResourceNotFound.
      (
        error,
      ): error is Extract<
        E,
        { readonly _tag: "NotFound" | "BigLakeResourceNotFound" }
      > =>
        error._tag === "NotFound" || error._tag === "BigLakeResourceNotFound",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
