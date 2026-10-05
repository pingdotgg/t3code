import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The Cloud Number Registry API is not enabled in the testing project. Set
// GCP_TEST_CLOUD_NUMBER_REGISTRY=1 on a project where it is.
export const entitled = !!process.env.GCP_TEST_CLOUD_NUMBER_REGISTRY;
export const runLifecycle = entitled && !process.env.FAST;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
export const location = "global";

export const waitUntilGone = <E extends { readonly _tag: string }, R>(
  get: Effect.Effect<unknown, E, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchIf(
      (error): error is Extract<E, { readonly _tag: "NotFound" }> =>
        error._tag === "NotFound",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
