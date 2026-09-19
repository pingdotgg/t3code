import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId } from "./baseSchemas.ts";

export const StorageCleanupCategory = Schema.Literals([
  "deleted",
  "inactive",
  "merged",
  "unchanged",
  "kept",
  "unchecked",
]);
export type StorageCleanupCategory = typeof StorageCleanupCategory.Type;

export const StorageCleanupPreviewInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  inactiveAfterDays: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 }))),
  ),
});
export type StorageCleanupPreviewInput = typeof StorageCleanupPreviewInput.Type;

export const StorageUsageTotals = Schema.Struct({
  folders: NonNegativeInt,
  measured: NonNegativeInt,
  bytes: NonNegativeInt,
});
export type StorageUsageTotals = typeof StorageUsageTotals.Type;

export const StorageCleanupPreview = Schema.Struct({
  checkedAt: Schema.String,
  unchecked: NonNegativeInt,
  unavailable: NonNegativeInt,
  total: StorageUsageTotals,
  categories: Schema.Array(
    Schema.Struct({ kind: StorageCleanupCategory, ...StorageUsageTotals.fields }),
  ),
  projectCount: NonNegativeInt,
});
export type StorageCleanupPreview = typeof StorageCleanupPreview.Type;
