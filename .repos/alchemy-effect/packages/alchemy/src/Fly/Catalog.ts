import type { MainRegionRow } from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { resolveOrgSlug } from "./Environment.ts";

export type CatalogKind = "region" | "org";

export class CatalogNotFound extends Data.TaggedError("Fly.CatalogNotFound")<{
  kind: CatalogKind;
  ref: string;
}> {}

const notFound = (kind: CatalogKind, ref: string) =>
  new CatalogNotFound({ kind, ref });

/**
 * Current token organization slug (`getCurrentToken` → `tokens[0].org_slug`).
 * Feeds `listApps({ org_slug })`. Not a resource.
 */
export const currentOrgSlug = resolveOrgSlug;

/**
 * List Fly platform regions via `getRegions`.
 */
export const listRegions = Effect.fn(function* () {
  const { regions } = yield* machines.getRegions({});
  return regions ?? [];
});

/**
 * Resolve a Fly region by code (`iad`, `ord`, `sjc`, …).
 */
export const findRegion = (code: string) =>
  Effect.gen(function* () {
    const regions = yield* listRegions();
    const found = regions.find((item) => item.code === code);
    if (found === undefined) {
      return yield* notFound("region", code);
    }
    return found;
  });

export type FlyRegion = MainRegionRow;
