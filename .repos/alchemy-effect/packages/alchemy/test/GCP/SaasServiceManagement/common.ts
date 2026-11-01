import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const runLifecycle = !process.env.FAST;

// Releases need a blueprint image pushed to Artifact Registry. Set
// GCP_TEST_SAAS_BLUEPRINT_PACKAGE (e.g.
// `us-central1-docker.pkg.dev/<project>/blueprints/store:v1`) to run the
// release, rollout, and unit-operation lifecycles.
export const blueprintPackage = process.env.GCP_TEST_SAAS_BLUEPRINT_PACKAGE;
export const runBlueprintLifecycle =
  runLifecycle && blueprintPackage !== undefined;

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
      (error) => error._tag === "NotFound",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
