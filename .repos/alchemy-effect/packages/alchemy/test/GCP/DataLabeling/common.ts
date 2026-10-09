import { GcpEnvironment } from "@/GCP/Environment";
import { none as noGcpRetry } from "@distilled.cloud/gcp/Retry";
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

/**
 * Data Labeling is shut down. Live GETs hang ~20s then return HTTP 502
 * (`BadGateway`). Opt in with `GCP_TEST_DATALABELING=1` if the API
 * returns.
 */
export const runLifecycle =
  !process.env.FAST && process.env.GCP_TEST_DATALABELING === "1";

export const probe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(noGcpRetry);

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
) =>
  get.pipe(
    noGcpRetry,
    Effect.as("found" as const),
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "BadGateway" } =>
        error._tag === "NotFound" || error._tag === "BadGateway",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
