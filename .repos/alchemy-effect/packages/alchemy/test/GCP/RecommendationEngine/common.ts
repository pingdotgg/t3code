import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const catalogParentOf = (project: string) =>
  `projects/${project}/locations/global`;

export const defaultCatalogOf = (project: string) =>
  `${catalogParentOf(project)}/catalogs/default_catalog`;

export const missingNameOf = (project: string) =>
  `${defaultCatalogOf(project)}/catalogItems/alchemy-missing`;

// Recommendations AI (Beta) is not enabled in the testing project. Set
// GCP_TEST_RECOMMENDATION_ENGINE=1 on a project where it is.
export const entitled = !!process.env.GCP_TEST_RECOMMENDATION_ENGINE;
