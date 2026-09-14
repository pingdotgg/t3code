import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** An application installed on the environment's host that computer use can drive. */
export const InstalledApp = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  bundleId: TrimmedNonEmptyString.check(
    Schema.isMaxLength(512),
    Schema.isPattern(/^[A-Za-z0-9._-]+$/u),
  ),
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
});
export type InstalledApp = typeof InstalledApp.Type;

export const AppsListInput = Schema.Struct({});
export type AppsListInput = typeof AppsListInput.Type;

/**
 * `supported` is false where the host cannot enumerate applications or
 * computer use is off, so clients hide the picker instead of showing nothing.
 */
export const AppsListResult = Schema.Struct({
  supported: Schema.Boolean,
  apps: Schema.Array(InstalledApp),
});
export type AppsListResult = typeof AppsListResult.Type;

export class AppsListError extends Schema.TaggedError<AppsListError>()("AppsListError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}
