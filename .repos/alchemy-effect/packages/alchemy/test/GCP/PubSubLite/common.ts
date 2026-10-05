import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Pub/Sub Lite is turned down for new projects (creates answer 403
// PubSubLiteTurnedDown); only a project still allow-listed can run lifecycles.
export const runLifecycle =
  !process.env.FAST && process.env.GCP_TEST_PUBSUBLITE === "1";

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
export const region = "us-central1";
export const zone = "us-central1-a";

export const waitUntilGone = <E extends { readonly _tag: string }, R>(
  get: Effect.Effect<unknown, E, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
