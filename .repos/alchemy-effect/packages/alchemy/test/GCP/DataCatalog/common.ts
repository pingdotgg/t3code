import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Tag templates moved to Dataplex; projects without legacy Data Catalog
// access get DataCatalogDeprecated ("Project … is not allowed to perform read operations
// due to Data Catalog deprecation."). Set GCP_TEST_DATACATALOG_TAG_TEMPLATES=1
// on a project that still has tag-template access.
export const runTagTemplateLifecycle =
  !!process.env.GCP_TEST_DATACATALOG_TAG_TEMPLATES;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
export const location = "us-central1";
