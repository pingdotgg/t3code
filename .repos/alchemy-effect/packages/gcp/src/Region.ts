import * as DistilledRegion from "@distilled.cloud/gcp/Region";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { GcpEnvironment } from "./Environment.ts";

export type { RegionalEndpointMode, RegionName } from "@distilled.cloud/gcp/Region";

/**
 * Override the default GCP region — the region regional resources land in
 * when created without an explicit `location` / `region`.
 *
 * The region normally comes with the credentials (the profile's
 * `region`), else `us-central1`. Provide `GCP.Region(...)` on the
 * providers layer to override that for a stack. There is no environment
 * variable: Google's SDKs don't define one, and deployed GCP runtimes
 * read their region from the metadata server. A resource that should live elsewhere takes
 * an explicit `location`; a recorded location always wins, so changing
 * the region never moves a deployed resource.
 *
 * ### Choosing a region
 * **Example:** Deploy a stack to europe-west1
 * ```typescript
 * export default Alchemy.Stack(
 *   "App",
 *   {
 *     providers: GCP.providers().pipe(
 *       Layer.provideMerge(GCP.Region("europe-west1")),
 *     ),
 *     state: Alchemy.localState(),
 *   },
 *   program,
 * );
 * ```
 */
export const Region = (region: DistilledRegion.RegionName): Layer.Layer<DistilledRegion.Region> =>
  DistilledRegion.of(region);

/**
 * Route requests to Google's regional endpoints
 * (`{service}.{region}.rep.googleapis.com`):
 *
 * - `"required"` (default): only where the global endpoint rejects
 *   regional resources (Secret Manager, Parameter Manager).
 * - `"prefer"`: every request for a regional resource whose service
 *   publishes a regional endpoint, so traffic terminates in-region.
 * - `"never"`: always the global endpoint.
 *
 * ### Data residency
 * **Example:** Keep every regional request in-region
 * ```typescript
 * GCP.providers().pipe(
 *   Layer.provideMerge(GCP.Region("europe-west1")),
 *   Layer.provideMerge(GCP.RegionalEndpoints("prefer")),
 * );
 * ```
 */
export const RegionalEndpoints = (
  mode: DistilledRegion.RegionalEndpointMode,
): Layer.Layer<DistilledRegion.RegionalEndpoints> => DistilledRegion.regionalEndpoints(mode);

/** The effective default region in the current scope. */
export const currentRegion = Effect.suspend(() =>
  GcpEnvironment.use((env) => Effect.map(env, ({ region }) => region)),
);
