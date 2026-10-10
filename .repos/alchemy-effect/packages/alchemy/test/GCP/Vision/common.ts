import { GcpEnvironment } from "@/GCP/Environment";
import { MinimumLogLevel } from "effect/References";
import * as Effect from "effect/Effect";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Product Search is closed to new projects: creates fail with BadRequest
// "Product Search doesn't onboard new projects. For image search, please use
// Vision Warehouse". Set GCP_TEST_VISION_PRODUCT_SEARCH=1 on a project that was
// onboarded before the cutoff to run the lifecycles.
export const runLifecycle = !!process.env.GCP_TEST_VISION_PRODUCT_SEARCH;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const location = "us-west1";
