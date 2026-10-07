import { GcpEnvironment } from "@/GCP/Environment";
import type { GcpOpError } from "@distilled.cloud/gcp/datamigration_v1";
import { NotFound } from "@distilled.cloud/gcp/datamigration_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const runSlowLifecycle =
  !!process.env.GCP_TEST_SLOW && !process.env.FAST;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E | NotFound | GcpOpError, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchIf(
      (error): error is NotFound => error._tag === "NotFound",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
